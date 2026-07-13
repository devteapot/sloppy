import { existsSync } from "node:fs";

import { loadScopedConfig } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { listenSupervisorClientProtocol } from "./client-protocol/supervisor-server";
import type { SupervisorClientSnapshot } from "./client-protocol/types";
import type { LaunchScope } from "./launch-scope";
import {
  loadSessionRegistry,
  persistSessionRegistry,
  recordFromSnapshot,
  sessionRegistryPath,
  snapshotPathForSession,
} from "./registry";
import { SessionService } from "./service";
import { loadPersistedSessionSnapshot } from "./store/persistence";
import {
  type ClientLease,
  defaultTitle,
  now,
  type PublicSessionRecord,
  recordFromRegistry,
  registryRecordFromSession,
  type ScopeRecord,
  type SessionRecord,
  type SessionScopeInput,
  scopesFromConfig,
  sessionSocketPath,
  stringParam,
} from "./supervisor-model";
import type { ApprovalMode } from "./types";

export type { SessionRecord, SessionScopeInput } from "./supervisor-model";

export class SessionSupervisor {
  private readonly records = new Map<string, SessionRecord>();
  private readonly clientLeases = new Map<object, ClientLease>();
  private readonly lifecycleListeners = new Set<() => void>();
  private resumeSessionId: string | null = null;
  private cachedConfig: SloppyConfig | null = null;
  private registryPath: string | null = null;
  private initialized = false;
  private initializePromise: Promise<void>;
  private scopeError: string | null = null;

  constructor(
    private readonly options: {
      cwd?: string;
      homeConfigPath?: string;
      workspaceConfigPath?: string;
      launchScope?: LaunchScope;
      autoCloseEnabled?: boolean;
    } = {},
  ) {
    this.initializePromise = this.initialize();
  }

  async startInitialSession(input: SessionScopeInput = {}): Promise<SessionRecord> {
    await this.ensureInitialized();
    if (this.resumeSessionId) {
      const record = this.records.get(this.resumeSessionId);
      if (record?.runtimeStatus === "live") {
        return record;
      }
    }
    return this.createSession(input);
  }

  onLifecycleChange(listener: () => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  async getClientSnapshot(): Promise<SupervisorClientSnapshot> {
    await this.ensureInitialized();
    let scopes: ScopeRecord[] = [];
    try {
      scopes = scopesFromConfig(await this.baseConfig());
    } catch {
      // baseConfig records scopeError for client diagnostics.
    }
    return {
      supervisor: {
        resumeSessionId: this.resumeSessionId,
        launchScopeKey: this.options.launchScope?.key,
        launchRoot: this.options.launchScope?.root,
        clientLeaseCount: this.clientLeases.size,
        autoCloseEnabled: this.options.autoCloseEnabled === true,
        ...(this.scopeError && { scopeError: this.scopeError }),
      },
      sessions: [...this.records.values()]
        .filter((record) => !record.archived)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((record) => this.publicSessionRecord(record)),
      scopes,
    };
  }

  stop(): void {
    for (const record of this.records.values()) {
      this.stopLiveRecord(record);
    }
    this.records.clear();
    this.clientLeases.clear();
    this.resumeSessionId = null;
    this.notifyLifecycle();
  }

  canAutoClose(): boolean {
    if (this.clientLeases.size > 0) {
      return false;
    }
    for (const record of this.records.values()) {
      if (
        record.runtimeStatus === "live" &&
        record.service?.runtime.buildAutoCloseBlockers().length
      ) {
        return false;
      }
    }
    return true;
  }

  registerClientLease(owner: object, params: Record<string, unknown>): { lease_id: string } {
    const lease = {
      leaseId: crypto.randomUUID(),
      selectedSessionId: stringParam(params, "selected_session_id"),
      label: stringParam(params, "label"),
      connectedAt: now(),
    };
    this.clientLeases.set(owner, lease);
    this.notifyLifecycle();
    return { lease_id: lease.leaseId };
  }

  updateClientLease(owner: object, params: Record<string, unknown>): { lease_id: string } {
    const existing = this.clientLeases.get(owner);
    const lease =
      existing ??
      ({
        leaseId: crypto.randomUUID(),
        connectedAt: now(),
      } satisfies ClientLease);
    lease.selectedSessionId = stringParam(params, "selected_session_id");
    lease.label = stringParam(params, "label") ?? lease.label;
    this.clientLeases.set(owner, lease);
    this.notifyLifecycle();
    return { lease_id: lease.leaseId };
  }

  unregisterClientLease(owner: object): { lease_id?: string } {
    const leaseId = this.clientLeases.get(owner)?.leaseId;
    this.clientLeases.delete(owner);
    this.notifyLifecycle();
    return { lease_id: leaseId };
  }

  removeConnection(owner: object): void {
    if (this.clientLeases.delete(owner)) {
      this.notifyLifecycle();
    }
  }

  async createSession(input: SessionScopeInput = {}, owner?: object): Promise<SessionRecord> {
    await this.ensureInitialized();
    const config = await this.resolveConfig(input);
    const sessionId = input.session_id ?? crypto.randomUUID();
    if (this.records.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
    const title = defaultTitle({
      workspaceId: config.workspaces?.activeWorkspaceId,
      projectId: config.workspaces?.activeProjectId,
      fallback: input.title,
    });
    const reloadScope = {
      workspace_id: config.workspaces?.activeWorkspaceId,
      project_id: config.workspaces?.activeProjectId,
    };
    const service = new SessionService({
      config,
      sessionId,
      title,
      socketPath: sessionSocketPath(sessionId),
      approvalMode: input.approval_mode ?? this.inheritedApprovalMode(owner),
      configReloader: () => this.resolveConfig(reloadScope),
      launchScope: this.options.launchScope,
    });
    await service.start();
    const record = this.attachService(service, {
      createdAt: now(),
      snapshotPath: service.runtime.store.getSnapshot().session.persistencePath,
    });
    this.resumeSessionId = sessionId;
    if (owner) {
      this.updateClientLease(owner, { selected_session_id: sessionId });
    }
    this.persistRegistry();
    this.notifyLifecycle();
    return record;
  }

  async reloadConfig(): Promise<{
    status: "ok";
    scope_count: number;
    registry_path: string | null;
  }> {
    await this.ensureInitialized();
    this.cachedConfig = null;
    const config = await this.baseConfig();
    this.notifyLifecycle();
    return {
      status: "ok",
      scope_count: scopesFromConfig(config).length,
      registry_path: this.registryPath,
    };
  }

  private inheritedApprovalMode(owner?: object): ApprovalMode | undefined {
    const selectedSessionId = owner ? this.clientLeases.get(owner)?.selectedSessionId : undefined;
    const selectedMode = selectedSessionId
      ? this.approvalModeForSession(selectedSessionId)
      : undefined;
    if (selectedMode) {
      return selectedMode;
    }
    return this.resumeSessionId ? this.approvalModeForSession(this.resumeSessionId) : undefined;
  }

  private approvalModeForSession(sessionId: string): ApprovalMode | undefined {
    const record = this.records.get(sessionId);
    if (!record) {
      return undefined;
    }
    const liveMode = record.service?.runtime.store.getSnapshot().approvalPolicy.mode;
    if (liveMode === "normal" || liveMode === "auto") {
      return liveMode;
    }
    if (!record.snapshotPath || !existsSync(record.snapshotPath)) {
      return undefined;
    }
    try {
      const persistedMode = loadPersistedSessionSnapshot(record.snapshotPath)?.approvalPolicy?.mode;
      return persistedMode === "normal" || persistedMode === "auto" ? persistedMode : undefined;
    } catch {
      return undefined;
    }
  }

  async selectSession(sessionId: string, owner?: object): Promise<SessionRecord> {
    await this.ensureInitialized();
    let record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (record.runtimeStatus === "dormant") {
      record = await this.restoreSession(record);
    }
    this.resumeSessionId = sessionId;
    if (owner) {
      this.updateClientLease(owner, { selected_session_id: sessionId });
    }
    this.persistRegistry();
    this.notifyLifecycle();
    return record;
  }

  async stopSession(
    sessionId: string,
    owner?: object,
  ): Promise<{ stopped: true; sessionId: string }> {
    await this.ensureInitialized();
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (record.runtimeStatus !== "live") {
      return { stopped: true, sessionId };
    }
    const ownerLease = owner ? this.clientLeases.get(owner) : undefined;
    if (ownerLease?.selectedSessionId === sessionId) {
      throw new Error("Use New Session or switch away before stopping the selected session.");
    }
    const otherClientCount = [...this.clientLeases.entries()].filter(
      ([leaseOwner, lease]) => leaseOwner !== owner && lease.selectedSessionId === sessionId,
    ).length;
    if (otherClientCount > 0) {
      throw new Error(`Cannot stop session: selected by ${otherClientCount} other clients.`);
    }

    this.stopLiveRecord(record);
    record.runtimeStatus = "dormant";
    record.socketPath = "";
    record.service = undefined;
    record.unsubscribe = undefined;
    this.persistRegistry();
    this.notifyLifecycle();
    return { stopped: true, sessionId };
  }

  publicSessionRecord(record: SessionRecord): PublicSessionRecord {
    if (record.runtimeStatus === "live" && record.service) {
      this.syncRecordFromService(record);
      const snapshot = record.service.runtime.store.getSnapshot();
      const pluginSummary = record.service.runtime.buildPluginSessionSummary();
      const pendingApprovalCount = snapshot.approvals.filter(
        (approval) => approval.status === "pending",
      ).length;
      const runningTaskCount = snapshot.tasks.filter((task) => task.status === "running").length;
      return {
        sessionId: record.sessionId,
        socketPath: record.socketPath,
        runtimeStatus: "live",
        workspaceRoot: snapshot.session.workspaceRoot,
        workspaceId: snapshot.session.workspaceId,
        projectId: snapshot.session.projectId,
        launchScopeKey: snapshot.session.launchScope?.key,
        launchRoot: snapshot.session.launchScope?.root,
        title: snapshot.session.title,
        createdAt: record.createdAt,
        lastActivityAt: snapshot.session.lastActivityAt,
        isResumeSession: record.sessionId === this.resumeSessionId,
        turnState: snapshot.turn.state,
        turnMessage: snapshot.turn.message,
        queuedCount: snapshot.queue.length,
        pendingApprovalCount,
        runningTaskCount,
        approvalMode: snapshot.approvalPolicy.mode,
        ...pluginSummary.props,
      };
    }

    const approvalMode = this.approvalModeForSession(record.sessionId) ?? "normal";
    return {
      sessionId: record.sessionId,
      runtimeStatus: "dormant",
      workspaceRoot: record.workspaceRoot,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      launchScopeKey: record.launchScopeKey,
      launchRoot: record.launchRoot,
      title: record.title,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      isResumeSession: record.sessionId === this.resumeSessionId,
      approvalMode,
    };
  }

  private async initialize(): Promise<void> {
    try {
      const config = await this.baseConfig();
      if (this.options.launchScope) {
        const loaded = loadSessionRegistry({
          config,
          launchScopeKey: this.options.launchScope.key,
          launchRoot: this.options.launchScope.root,
        });
        if (loaded) {
          this.registryPath = loaded.path;
          this.resumeSessionId = loaded.registry.resumeSessionId ?? null;
          for (const record of loaded.registry.sessions) {
            if (!record.archived) {
              this.records.set(record.sessionId, recordFromRegistry(record));
            }
          }
          this.persistRegistry();
        }
      }
      this.initialized = true;
    } finally {
      this.notifyLifecycle();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initializePromise;
    }
  }

  private async baseConfig(): Promise<SloppyConfig> {
    if (!this.cachedConfig) {
      try {
        this.cachedConfig = await loadScopedConfig({
          cwd: this.options.cwd,
          homeConfigPath: this.options.homeConfigPath,
          workspaceConfigPath: this.options.workspaceConfigPath,
        });
        if (this.options.launchScope) {
          this.registryPath = sessionRegistryPath(this.cachedConfig, this.options.launchScope.key);
        }
        this.scopeError = null;
      } catch (error) {
        this.scopeError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    return this.cachedConfig;
  }

  private async resolveConfig(input: SessionScopeInput): Promise<SloppyConfig> {
    return loadScopedConfig({
      cwd: this.options.cwd,
      homeConfigPath: this.options.homeConfigPath,
      workspaceConfigPath: this.options.workspaceConfigPath,
      workspaceId: input.workspace_id,
      projectId: input.project_id,
    });
  }

  private async restoreSession(record: SessionRecord): Promise<SessionRecord> {
    const config = await this.resolveConfig({
      workspace_id: record.workspaceId,
      project_id: record.projectId,
    });
    const snapshotPath = record.snapshotPath ?? snapshotPathForSession(config, record.sessionId);
    if (!snapshotPath || !existsSync(snapshotPath)) {
      throw new Error(
        `Previous session could not be restored: missing snapshot for ${record.sessionId}.`,
      );
    }
    const service = new SessionService({
      config,
      sessionId: record.sessionId,
      title: record.title,
      socketPath: sessionSocketPath(record.sessionId),
      sessionPersistencePath: snapshotPath,
      configReloader: () =>
        this.resolveConfig({
          workspace_id: record.workspaceId,
          project_id: record.projectId,
        }),
      launchScope: this.options.launchScope,
    });
    await service.start();
    return this.attachService(service, {
      record,
      createdAt: record.createdAt,
      snapshotPath,
    });
  }

  private attachService(
    service: SessionService,
    options: {
      record?: SessionRecord;
      createdAt: string;
      snapshotPath?: string;
    },
  ): SessionRecord {
    const snapshot = service.runtime.store.getSnapshot();
    const record =
      options.record ??
      ({
        sessionId: snapshot.session.sessionId,
        socketPath: service.socketPath,
        runtimeStatus: "live",
        createdAt: options.createdAt,
        lastActivityAt: snapshot.session.lastActivityAt,
      } satisfies SessionRecord);
    record.socketPath = service.socketPath;
    record.runtimeStatus = "live";
    record.service = service;
    record.snapshotPath =
      options.snapshotPath ?? snapshot.session.persistencePath ?? record.snapshotPath;
    this.syncRecordFromService(record);
    const refresh = () => {
      this.syncRecordFromService(record);
      this.persistRegistry();
      this.notifyLifecycle();
    };
    const unsubscribers = [
      service.runtime.store.onSessionChange(refresh),
      service.runtime.store.onTurnChange(refresh),
      service.runtime.store.onGoalChange(refresh),
      service.runtime.store.onQueueChange(refresh),
      service.runtime.store.onApprovalsChange(refresh),
      service.runtime.store.onTasksChange(refresh),
    ];
    record.unsubscribe = () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
    this.records.set(record.sessionId, record);
    return record;
  }

  private syncRecordFromService(record: SessionRecord): void {
    if (!record.service) {
      return;
    }
    const snapshot = record.service.runtime.store.getSnapshot();
    const registryRecord = recordFromSnapshot(snapshot, record.snapshotPath);
    record.title = registryRecord.title;
    record.workspaceRoot = registryRecord.workspaceRoot;
    record.workspaceId = registryRecord.workspaceId;
    record.projectId = registryRecord.projectId;
    record.launchScopeKey = registryRecord.launchScopeKey;
    record.launchRoot = registryRecord.launchRoot;
    record.lastActivityAt = registryRecord.lastActivityAt;
    record.snapshotPath = registryRecord.snapshotPath;
  }

  private stopLiveRecord(record: SessionRecord): void {
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.service?.stop();
    record.service = undefined;
  }

  private persistRegistry(): void {
    if (!this.registryPath || !this.options.launchScope) {
      return;
    }
    persistSessionRegistry(this.registryPath, {
      kind: "sloppy.session.registry",
      schemaVersion: 1,
      launchScopeKey: this.options.launchScope.key,
      launchRoot: this.options.launchScope.root,
      resumeSessionId: this.resumeSessionId ?? undefined,
      sessions: [...this.records.values()]
        .filter((record) => !record.archived)
        .map(registryRecordFromSession),
    });
  }

  private notifyLifecycle(): void {
    for (const listener of this.lifecycleListeners) {
      listener();
    }
  }
}

export async function startSessionSupervisor(options: {
  socketPath: string;
  initial?: SessionScopeInput | false;
  cwd?: string;
  launchScope?: LaunchScope;
  autoClose?: {
    enabled: boolean;
    idleTimeoutMs?: number;
    onClose?: () => void;
  };
}): Promise<{
  supervisor: SessionSupervisor;
  listener: { close(): void };
  initialSession?: SessionRecord;
}> {
  const supervisor = new SessionSupervisor({
    cwd: options.cwd,
    launchScope: options.launchScope,
    autoCloseEnabled: options.autoClose?.enabled === true,
  });
  let autoCloseTimer: Timer | null = null;
  const clearAutoCloseTimer = () => {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  };
  const closeForIdle = () => {
    clearAutoCloseTimer();
    listener.close();
    supervisor.stop();
    options.autoClose?.onClose?.();
  };
  const scheduleAutoClose = () => {
    if (options.autoClose?.enabled !== true) {
      return;
    }
    if (!supervisor.canAutoClose()) {
      clearAutoCloseTimer();
      return;
    }
    if (!autoCloseTimer) {
      autoCloseTimer = setTimeout(closeForIdle, options.autoClose.idleTimeoutMs ?? 5000);
    }
  };
  supervisor.onLifecycleChange(scheduleAutoClose);

  let initialSession: SessionRecord | undefined;
  try {
    if (options.initial !== false) {
      initialSession = await supervisor.startInitialSession(options.initial ?? {});
    }
  } catch (error) {
    supervisor.stop();
    throw error;
  }
  const clientListener = listenSupervisorClientProtocol(supervisor, options.socketPath);
  const listener = {
    close: () => {
      clearAutoCloseTimer();
      clientListener.close();
    },
  };
  scheduleAutoClose();
  return {
    supervisor,
    listener,
    initialSession,
  };
}

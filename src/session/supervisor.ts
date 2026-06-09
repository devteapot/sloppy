import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Action,
  action,
  createSlopServer,
  type ItemDescriptor,
  type SlopServer,
} from "@slop-ai/server";

import { getHomeConfigPath, getWorkspaceConfigPath, loadScopedConfig } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import type { LaunchScope } from "./launch-scope";
import {
  loadSessionRegistry,
  persistSessionRegistry,
  recordFromSnapshot,
  type SessionRegistryRecord,
  sessionRegistryPath,
  snapshotPathForSession,
} from "./registry";
import { SessionService } from "./service";
import type { Listener, WebSocketListenOptions } from "./socket";
import { loadPersistedSessionSnapshot } from "./store/persistence";
import { listenSessionSupervisor, listenSessionSupervisorWebSocket } from "./supervisor-listener";
import type { ApprovalMode } from "./types";

export type SessionScopeInput = {
  workspace_id?: string;
  project_id?: string;
  title?: string;
  session_id?: string;
  approval_mode?: ApprovalMode;
};

export type SessionRecord = {
  sessionId: string;
  providerId: string;
  socketPath: string;
  webSocketUrl?: string;
  runtimeStatus: "live" | "dormant";
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  launchScopeKey?: string;
  launchRoot?: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  snapshotPath?: string;
  archived?: boolean;
  service?: SessionService;
  unsubscribe?: () => void;
};

type PublicSessionRecord = {
  sessionId: string;
  providerId: string;
  socketPath?: string;
  webSocketUrl?: string;
  runtimeStatus: "live" | "dormant";
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  launchScopeKey?: string;
  launchRoot?: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  session_id: string;
  provider_id: string;
  socket_path?: string;
  web_socket_url?: string;
  ws_url?: string;
  runtime_status: "live" | "dormant";
  workspace_root?: string;
  workspace_id?: string;
  project_id?: string;
  launch_scope_key?: string;
  launch_root?: string;
  created_at: string;
  last_activity_at: string;
  is_resume_session: boolean;
  turn_state?: string;
  turn_message?: string;
  queued_count?: number;
  pending_approval_count?: number;
  running_task_count?: number;
  approvalMode?: ApprovalMode;
  approval_mode?: ApprovalMode;
  [key: string]: unknown;
};

type ScopeRecord = {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  root: string;
  configPath: string;
  description?: string;
};

type ClientLease = {
  leaseId: string;
  selectedSessionId?: string;
  label?: string;
  connectedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "session";
}

function sessionSocketPath(sessionId: string): string {
  return `/tmp/slop/sloppy-session-${sanitizeSegment(sessionId)}.sock`;
}

function defaultTitle(input: {
  workspaceId?: string;
  projectId?: string;
  fallback?: string;
}): string | undefined {
  if (input.fallback) {
    return input.fallback;
  }
  if (input.workspaceId && input.projectId) {
    return `${input.workspaceId}/${input.projectId}`;
  }
  return input.workspaceId;
}

function recordFromRegistry(record: SessionRegistryRecord): SessionRecord {
  return {
    sessionId: record.sessionId,
    providerId: `sloppy-session-${record.sessionId}`,
    socketPath: "",
    runtimeStatus: "dormant",
    title: record.title,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    launchScopeKey: record.launchScopeKey,
    launchRoot: record.launchRoot,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    snapshotPath: record.snapshotPath,
    archived: record.archived,
  };
}

function registryRecordFromSession(record: SessionRecord): SessionRegistryRecord {
  return {
    sessionId: record.sessionId,
    title: record.title,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    launchScopeKey: record.launchScopeKey,
    launchRoot: record.launchRoot,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    snapshotPath: record.snapshotPath,
    archived: record.archived,
  };
}

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function approvalModeParam(
  params: Record<string, unknown>,
  name: string,
): ApprovalMode | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === "normal" || value === "auto") {
    return value;
  }
  throw new Error(`${name} must be 'normal' or 'auto'.`);
}

function sessionScopeInputFromParams(params: Record<string, unknown>): SessionScopeInput {
  return {
    workspace_id: stringParam(params, "workspace_id"),
    project_id: stringParam(params, "project_id"),
    title: stringParam(params, "title"),
    session_id: stringParam(params, "session_id"),
    approval_mode: approvalModeParam(params, "approval_mode"),
  };
}

export class SessionSupervisorProvider {
  readonly server: SlopServer;
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
    this.server = createSlopServer({
      id: "sloppy-session-supervisor",
      name: "Sloppy Session Supervisor",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("sessions", () => this.buildSessionsDescriptor());
    this.server.register("scopes", () => this.buildScopesDescriptor());
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

  stop(): void {
    for (const record of this.records.values()) {
      this.stopLiveRecord(record);
    }
    this.records.clear();
    this.clientLeases.clear();
    this.resumeSessionId = null;
    this.server.stop();
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
    this.server.refresh();
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
    this.server.refresh();
    this.notifyLifecycle();
    return { lease_id: lease.leaseId };
  }

  unregisterClientLease(owner: object): { lease_id?: string } {
    const leaseId = this.clientLeases.get(owner)?.leaseId;
    this.clientLeases.delete(owner);
    this.server.refresh();
    this.notifyLifecycle();
    return { lease_id: leaseId };
  }

  removeConnection(owner: object): void {
    if (this.clientLeases.delete(owner)) {
      this.server.refresh();
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
    this.server.refresh();
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
    this.server.refresh();
    this.notifyLifecycle();
    return {
      status: "ok",
      scope_count: this.scopesFromConfig(config).length,
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
    this.server.refresh();
    this.notifyLifecycle();
    return record;
  }

  async stopSession(
    sessionId: string,
    owner?: object,
  ): Promise<{ stopped: true; session_id: string }> {
    await this.ensureInitialized();
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (record.runtimeStatus !== "live") {
      return { stopped: true, session_id: sessionId };
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
    record.webSocketUrl = undefined;
    record.service = undefined;
    record.unsubscribe = undefined;
    this.persistRegistry();
    this.server.refresh();
    this.notifyLifecycle();
    return { stopped: true, session_id: sessionId };
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
        providerId: record.providerId,
        socketPath: record.socketPath,
        webSocketUrl: record.webSocketUrl,
        runtimeStatus: "live",
        workspaceRoot: snapshot.session.workspaceRoot,
        workspaceId: snapshot.session.workspaceId,
        projectId: snapshot.session.projectId,
        launchScopeKey: snapshot.session.launchScope?.key,
        launchRoot: snapshot.session.launchScope?.root,
        title: snapshot.session.title,
        createdAt: record.createdAt,
        lastActivityAt: snapshot.session.lastActivityAt,
        session_id: record.sessionId,
        provider_id: record.providerId,
        socket_path: record.socketPath,
        web_socket_url: record.webSocketUrl,
        ws_url: record.webSocketUrl,
        runtime_status: "live",
        workspace_root: snapshot.session.workspaceRoot,
        workspace_id: snapshot.session.workspaceId,
        project_id: snapshot.session.projectId,
        launch_scope_key: snapshot.session.launchScope?.key,
        launch_root: snapshot.session.launchScope?.root,
        created_at: record.createdAt,
        last_activity_at: snapshot.session.lastActivityAt,
        is_resume_session: record.sessionId === this.resumeSessionId,
        turn_state: snapshot.turn.state,
        turn_message: snapshot.turn.message,
        queued_count: snapshot.queue.length,
        pending_approval_count: pendingApprovalCount,
        running_task_count: runningTaskCount,
        approvalMode: snapshot.approvalPolicy.mode,
        approval_mode: snapshot.approvalPolicy.mode,
        ...pluginSummary.props,
      };
    }

    const approvalMode = this.approvalModeForSession(record.sessionId) ?? "normal";
    return {
      sessionId: record.sessionId,
      providerId: record.providerId,
      runtimeStatus: "dormant",
      workspaceRoot: record.workspaceRoot,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      launchScopeKey: record.launchScopeKey,
      launchRoot: record.launchRoot,
      title: record.title,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      session_id: record.sessionId,
      provider_id: record.providerId,
      runtime_status: "dormant",
      workspace_root: record.workspaceRoot,
      workspace_id: record.workspaceId,
      project_id: record.projectId,
      launch_scope_key: record.launchScopeKey,
      launch_root: record.launchRoot,
      created_at: record.createdAt,
      last_activity_at: record.lastActivityAt,
      is_resume_session: record.sessionId === this.resumeSessionId,
      approvalMode,
      approval_mode: approvalMode,
    };
  }

  async handleConnectionInvoke(
    owner: object,
    path: string,
    actionName: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    if (path === "/session") {
      if (actionName === "create_session") {
        return this.publicSessionRecord(
          await this.createSession(sessionScopeInputFromParams(params), owner),
        );
      }
      if (actionName === "select_session") {
        const sessionId = stringParam(params, "session_id");
        if (!sessionId) {
          throw new Error("session_id is required.");
        }
        return this.publicSessionRecord(await this.selectSession(sessionId, owner));
      }
      if (actionName === "register_client_lease") {
        return this.registerClientLease(owner, params);
      }
      if (actionName === "update_client_lease") {
        return this.updateClientLease(owner, params);
      }
      if (actionName === "unregister_client_lease") {
        return this.unregisterClientLease(owner);
      }
    }
    const sessionMatch = path.match(/^\/sessions\/(.+)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      if (actionName === "select_session") {
        return this.publicSessionRecord(await this.selectSession(sessionId, owner));
      }
      if (actionName === "stop_session") {
        return this.stopSession(sessionId, owner);
      }
    }
    const scopeMatch = path.match(/^\/scopes\/(.+)$/);
    if (scopeMatch && actionName === "create_session") {
      // Scope item creation needs the tracked connection owner so approval mode
      // can inherit from the caller's selected Session lease.
      await this.ensureInitialized();
      const scopeId = decodeURIComponent(scopeMatch[1] ?? "");
      const config = await this.baseConfig();
      const scope = this.scopesFromConfig(config).find((item) => item.id === scopeId);
      if (!scope) {
        throw new Error(`Unknown scope: ${scopeId}`);
      }
      return this.publicSessionRecord(
        await this.createSession(
          {
            workspace_id: scope.workspaceId,
            project_id: scope.projectId,
            title: stringParam(params, "title"),
            session_id: stringParam(params, "session_id"),
            approval_mode: approvalModeParam(params, "approval_mode"),
          },
          owner,
        ),
      );
    }
    return null;
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
      this.server.refresh();
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
        providerId: service.providerId,
        socketPath: service.socketPath,
        webSocketUrl: service.webSocketUrl,
        runtimeStatus: "live",
        createdAt: options.createdAt,
        lastActivityAt: snapshot.session.lastActivityAt,
      } satisfies SessionRecord);
    record.providerId = service.providerId;
    record.socketPath = service.socketPath;
    record.webSocketUrl = service.webSocketUrl;
    record.runtimeStatus = "live";
    record.service = service;
    record.snapshotPath =
      options.snapshotPath ?? snapshot.session.persistencePath ?? record.snapshotPath;
    this.syncRecordFromService(record);
    const refresh = () => {
      this.syncRecordFromService(record);
      this.persistRegistry();
      this.server.refresh();
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

  private scopesFromConfig(config: SloppyConfig): ScopeRecord[] {
    const registry = config.workspaces;
    if (!registry) {
      return [];
    }

    const scopes: ScopeRecord[] = [];
    for (const [workspaceId, workspace] of Object.entries(registry.items)) {
      scopes.push({
        id: workspaceId,
        workspaceId,
        name: workspace.name ?? workspaceId,
        description: workspace.description,
        root: workspace.root,
        configPath: workspace.configPath,
      });
      for (const [projectId, project] of Object.entries(workspace.projects)) {
        scopes.push({
          id: `${workspaceId}/${projectId}`,
          workspaceId,
          projectId,
          name: project.name ?? `${workspace.name ?? workspaceId}/${projectId}`,
          description: project.description,
          root: project.root,
          configPath: project.configPath,
        });
      }
    }
    return scopes.sort((left, right) => left.id.localeCompare(right.id));
  }

  private buildSessionDescriptor() {
    const resume = this.resumeSessionId ? this.records.get(this.resumeSessionId) : undefined;
    return {
      type: "context",
      props: {
        session_count: this.records.size,
        live_session_count: [...this.records.values()].filter(
          (record) => record.runtimeStatus === "live",
        ).length,
        resume_session_id: resume?.sessionId ?? null,
        resume_socket_path: resume?.runtimeStatus === "live" ? resume.socketPath : null,
        client_lease_count: this.clientLeases.size,
        auto_close_enabled: this.options.autoCloseEnabled === true,
        launch_scope_key: this.options.launchScope?.key,
        launch_root: this.options.launchScope?.root,
        registry_path: this.registryPath,
        home_config_path: this.options.homeConfigPath ?? getHomeConfigPath(),
        workspace_config_path:
          this.options.workspaceConfigPath ??
          getWorkspaceConfigPath(resolve(this.options.cwd ?? process.cwd())),
      },
      summary: "Supervisor for multiple Sloppy session providers.",
      actions: {
        create_session: action(
          {
            workspace_id: { type: "string", optional: true },
            project_id: { type: "string", optional: true },
            title: { type: "string", optional: true },
            session_id: { type: "string", optional: true },
            approval_mode: {
              type: "string",
              optional: true,
              description: "Initial approval mode: normal or auto.",
            },
          },
          async (input) =>
            this.publicSessionRecord(
              await this.createSession({
                ...input,
                approval_mode: approvalModeParam(input, "approval_mode"),
              }),
            ),
          {
            label: "New Session",
            description: "Start a new scoped session provider and select it.",
            estimate: "slow",
          },
        ),
        select_session: action(
          { session_id: "string" },
          async ({ session_id }) => this.publicSessionRecord(await this.selectSession(session_id)),
          {
            label: "Select Session",
            description: "Select or restore a session.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        reload_config: action(async () => this.reloadConfig(), {
          label: "Reload Config",
          description: "Reload supervisor config and refresh available workspace/project scopes.",
          estimate: "fast",
        }),
        register_client_lease: action(
          {
            selected_session_id: { type: "string", optional: true },
            label: { type: "string", optional: true },
          },
          async () => {
            throw new Error("Client leases require the tracked supervisor listener.");
          },
          {
            label: "Register Client Lease",
            description: "Register this supervisor client connection.",
            estimate: "instant",
          },
        ),
        update_client_lease: action(
          {
            selected_session_id: { type: "string", optional: true },
            label: { type: "string", optional: true },
          },
          async () => {
            throw new Error("Client leases require the tracked supervisor listener.");
          },
          {
            label: "Update Client Lease",
            description: "Update this supervisor client connection lease.",
            estimate: "instant",
          },
        ),
        unregister_client_lease: action(
          async () => {
            throw new Error("Client leases require the tracked supervisor listener.");
          },
          {
            label: "Unregister Client Lease",
            description: "Clear this supervisor client connection lease.",
            estimate: "instant",
          },
        ),
      },
    };
  }

  private buildSessionsDescriptor() {
    const items: ItemDescriptor[] = [...this.records.values()]
      .filter((record) => !record.archived)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => this.buildSessionItem(record));
    return {
      type: "collection",
      props: {
        count: items.length,
        resume_session_id: this.resumeSessionId,
      },
      summary: "Sloppy sessions managed by this supervisor.",
      items,
    };
  }

  private buildSessionItem(record: SessionRecord): ItemDescriptor {
    const publicRecord = this.publicSessionRecord(record);
    const summaryParts = [
      `status=${publicRecord.runtime_status}`,
      ...(publicRecord.turn_state ? [`turn=${publicRecord.turn_state}`] : []),
      ...(typeof publicRecord.queued_count === "number"
        ? [`queued=${publicRecord.queued_count}`]
        : []),
      ...(publicRecord.approval_mode ? [`approval=${publicRecord.approval_mode}`] : []),
    ];
    const actions: Record<string, Action> = {
      select_session: action(
        async () => this.publicSessionRecord(await this.selectSession(record.sessionId)),
        {
          label: "Select",
          description: "Select or restore this session.",
          idempotent: true,
          estimate: record.runtimeStatus === "live" ? "instant" : "slow",
        },
      ),
    };
    if (record.runtimeStatus === "live") {
      actions.stop_session = action(async () => this.stopSession(record.sessionId), {
        label: "Stop Session",
        description: "Stop this live session process while keeping its history restorable.",
        dangerous: true,
        idempotent: true,
        estimate: "fast",
      });
    }
    return {
      id: encodeURIComponent(record.sessionId),
      props: {
        session_id: record.sessionId,
        provider_id: record.providerId,
        socket_path: publicRecord.socket_path ?? null,
        web_socket_url: publicRecord.web_socket_url ?? null,
        ws_url: publicRecord.ws_url ?? null,
        runtime_status: publicRecord.runtime_status,
        workspace_root: publicRecord.workspace_root ?? null,
        workspace_id: publicRecord.workspace_id ?? null,
        project_id: publicRecord.project_id ?? null,
        launch_scope_key: publicRecord.launch_scope_key ?? null,
        launch_root: publicRecord.launch_root ?? null,
        title: publicRecord.title ?? null,
        created_at: publicRecord.created_at,
        last_activity_at: publicRecord.last_activity_at,
        is_resume_session: publicRecord.is_resume_session,
        turn_state: publicRecord.turn_state ?? null,
        turn_message: publicRecord.turn_message ?? null,
        queued_count: publicRecord.queued_count ?? null,
        pending_approval_count: publicRecord.pending_approval_count ?? null,
        running_task_count: publicRecord.running_task_count ?? null,
        approval_mode: publicRecord.approval_mode ?? null,
      },
      summary: `${publicRecord.title ?? record.sessionId}: ${summaryParts.join(" ")}`,
      actions,
    };
  }

  private buildScopesDescriptor() {
    if (!this.cachedConfig && !this.scopeError) {
      void this.baseConfig()
        .then(() => this.server.refresh())
        .catch(() => this.server.refresh());
    }

    return {
      type: "collection",
      props: {
        ready: this.cachedConfig !== null,
        count: this.cachedConfig ? this.scopesFromConfig(this.cachedConfig).length : 0,
        error: this.scopeError,
      },
      summary: "Configured workspace/project scopes available for new sessions.",
      actions: {
        refresh: action(
          async () => {
            this.cachedConfig = null;
            this.scopeError = null;
            const config = await this.baseConfig();
            this.server.refresh();
            return { count: this.scopesFromConfig(config).length };
          },
          {
            label: "Refresh Scopes",
            description: "Reload configured workspace/project scopes.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
      items: this.cachedConfig
        ? this.scopesFromConfig(this.cachedConfig).map((scope) => this.buildScopeItem(scope))
        : [],
    };
  }

  private buildScopeItem(scope: ScopeRecord): ItemDescriptor {
    return {
      id: encodeURIComponent(scope.id),
      props: {
        id: scope.id,
        workspace_id: scope.workspaceId,
        project_id: scope.projectId ?? null,
        name: scope.name,
        description: scope.description ?? null,
        root: scope.root,
        config_path: scope.configPath,
      },
      summary: scope.description ?? `${scope.name}: ${scope.root}`,
      actions: {
        create_session: action(
          {
            title: { type: "string", optional: true },
            session_id: { type: "string", optional: true },
            approval_mode: {
              type: "string",
              optional: true,
              description: "Initial approval mode: normal or auto.",
            },
          },
          async ({ title, session_id, approval_mode }) =>
            this.publicSessionRecord(
              await this.createSession({
                workspace_id: scope.workspaceId,
                project_id: scope.projectId,
                title,
                session_id,
                approval_mode: approvalModeParam({ approval_mode }, "approval_mode"),
              }),
            ),
          {
            label: "New Session",
            description: "Start a new session in this scope.",
            estimate: "slow",
          },
        ),
      },
    };
  }
}

export async function startSessionSupervisor(options: {
  socketPath: string;
  webSocket?: WebSocketListenOptions;
  initial?: SessionScopeInput | false;
  cwd?: string;
  launchScope?: LaunchScope;
  register?: boolean;
  autoClose?: {
    enabled: boolean;
    idleTimeoutMs?: number;
    onClose?: () => void;
  };
}): Promise<{
  provider: SessionSupervisorProvider;
  listener: Listener;
  webSocketUrl?: string;
  initialSession?: SessionRecord;
}> {
  const provider = new SessionSupervisorProvider({
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
    provider.stop();
    options.autoClose?.onClose?.();
  };
  const scheduleAutoClose = () => {
    if (options.autoClose?.enabled !== true) {
      return;
    }
    if (!provider.canAutoClose()) {
      clearAutoCloseTimer();
      return;
    }
    if (!autoCloseTimer) {
      autoCloseTimer = setTimeout(closeForIdle, options.autoClose.idleTimeoutMs ?? 5000);
    }
  };
  provider.onLifecycleChange(scheduleAutoClose);

  let initialSession: SessionRecord | undefined;
  try {
    if (options.initial !== false) {
      initialSession = await provider.startInitialSession(options.initial ?? {});
    }
  } catch (error) {
    provider.stop();
    throw error;
  }
  const unixListener = listenSessionSupervisor(provider, options.socketPath, {
    register: options.register ?? true,
  });
  const webSocketListener = options.webSocket
    ? listenSessionSupervisorWebSocket(provider, options.webSocket)
    : undefined;
  const listener: Listener = {
    close: () => {
      clearAutoCloseTimer();
      webSocketListener?.close();
      unixListener.close();
    },
  };
  scheduleAutoClose();
  return {
    provider,
    listener,
    webSocketUrl: webSocketListener?.url,
    initialSession,
  };
}

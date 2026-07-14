import type { ResultMessage } from "@slop-ai/consumer";
import {
  type SupervisorClientSnapshot as ApiSupervisorSnapshot,
  type PublicSessionRecord,
  type ScopeRecord,
  SupervisorApiClient,
} from "sloppy/session";

import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  type ReconnectOptions,
  ReconnectScheduler,
} from "./connect-support";
import type { ApprovalMode, ConnectionStatus } from "./slop-types";

export type SupervisorSessionItem = {
  id: string;
  title?: string;
  socketPath: string;
  runtimeStatus: "live" | "stopping" | "dormant";
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  launchScopeKey?: string;
  launchRoot?: string;
  turnState?: string;
  turnMessage?: string;
  goalStatus?: string;
  goalObjective?: string;
  goalTotalTokens: number;
  queuedCount: number;
  pendingApprovalCount: number;
  runningTaskCount: number;
  approvalMode: ApprovalMode;
  lastActivityAt?: string;
  isResumeSession: boolean;
  createdAt?: string;
  canSwitch: boolean;
  canStop: boolean;
};

export type SupervisorScopeItem = {
  id: string;
  name: string;
  root: string;
  workspaceId: string;
  projectId?: string;
  description?: string;
  canCreate: boolean;
};

export type SupervisorSnapshot = {
  connection: {
    status: ConnectionStatus;
    socketPath: string;
    error?: string;
    reconnectAttempt?: number;
  };
  resumeSessionId?: string;
  resumeSocketPath?: string;
  autoCloseEnabled: boolean;
  clientLeaseCount: number;
  sessions: SupervisorSessionItem[];
  scopes: SupervisorScopeItem[];
};

export type SupervisorClientEvent =
  | { type: "snapshot"; snapshot: SupervisorSnapshot }
  | { type: "result"; result: ResultMessage }
  | { type: "error"; message: string };

export type SupervisorClientListener = (event: SupervisorClientEvent) => void;

export type SessionSupervisorClientOptions = {
  leaseLabel?: string;
  connectTimeoutMs?: number;
  reconnect?: ReconnectOptions | false;
};

function emptySnapshot(endpoint: string): SupervisorSnapshot {
  return {
    connection: { status: "idle", socketPath: endpoint },
    autoCloseEnabled: false,
    clientLeaseCount: 0,
    sessions: [],
    scopes: [],
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapSessionRecord(
  record: PublicSessionRecord,
  resumeSessionId?: string,
): SupervisorSessionItem {
  const clientEndpoint = record.socketPath ?? "";
  const runtimeStatus = record.runtimeStatus;
  return {
    id: record.sessionId,
    title: stringValue(record.title),
    socketPath: clientEndpoint,
    runtimeStatus,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    launchScopeKey: record.launchScopeKey,
    launchRoot: record.launchRoot,
    turnState: record.turnState,
    turnMessage: record.turnMessage,
    goalStatus: record.goalStatus,
    goalObjective: record.goalObjective,
    goalTotalTokens: record.goalTotalTokens ?? 0,
    queuedCount: record.queuedCount ?? 0,
    pendingApprovalCount: record.pendingApprovalCount ?? 0,
    runningTaskCount: record.runningTaskCount ?? 0,
    approvalMode: record.approvalMode === "auto" ? "auto" : "normal",
    lastActivityAt: record.lastActivityAt,
    isResumeSession: record.isResumeSession || record.sessionId === resumeSessionId,
    createdAt: record.createdAt,
    canSwitch: runtimeStatus !== "stopping",
    canStop: runtimeStatus === "live",
  };
}

function mapScope(scope: ScopeRecord): SupervisorScopeItem {
  return {
    id: scope.id,
    name: scope.name,
    root: scope.root,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    description: scope.description,
    canCreate: true,
  };
}

function mapSnapshot(
  snapshot: ApiSupervisorSnapshot,
  endpoint: string,
  connection: SupervisorSnapshot["connection"],
): SupervisorSnapshot {
  const resumeSessionId = snapshot.supervisor.resumeSessionId ?? undefined;
  const sessions = snapshot.sessions.map((record) => mapSessionRecord(record, resumeSessionId));
  return {
    connection: { ...connection, socketPath: endpoint },
    resumeSessionId,
    resumeSocketPath: sessions.find((session) => session.id === resumeSessionId)?.socketPath,
    autoCloseEnabled: snapshot.supervisor.autoCloseEnabled,
    clientLeaseCount: snapshot.supervisor.clientLeaseCount,
    sessions,
    scopes: snapshot.scopes.map(mapScope),
  };
}

export class SessionSupervisorClient {
  private api: SupervisorApiClient | null = null;
  private connectPromise: Promise<SupervisorSnapshot> | null = null;
  private snapshot: SupervisorSnapshot;
  private listeners = new Set<SupervisorClientListener>();
  private readonly endpoint: string;
  private readonly leaseLabel: string;
  private readonly connectTimeoutMs: number;
  private readonly reconnect: ReconnectScheduler | null;
  private suppressReconnect = false;

  constructor(
    readonly socketPath: string,
    options: SessionSupervisorClientOptions = {},
  ) {
    this.endpoint = socketPath;
    this.leaseLabel = options.leaseLabel ?? "tui";
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnect = options.reconnect === false ? null : new ReconnectScheduler(options.reconnect);
    this.snapshot = emptySnapshot(this.endpoint);
  }

  getSnapshot(): SupervisorSnapshot {
    return this.snapshot;
  }

  on(listener: SupervisorClientListener): () => void {
    this.listeners.add(listener);
    this.dispatch(listener, { type: "snapshot", snapshot: this.snapshot });
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<SupervisorSnapshot> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.suppressReconnect = true;
    this.reconnect?.reset();
    const api = this.api;
    this.api = null;
    api?.disconnect();
    this.updateConnection("disconnected");
  }

  async createSession(
    input: {
      workspaceId?: string;
      projectId?: string;
      title?: string;
      sessionId?: string;
      approvalMode?: ApprovalMode;
    } = {},
  ): Promise<SupervisorSessionItem> {
    const record = await this.ensureApi().createSession({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      title: input.title,
      sessionId: input.sessionId,
      approvalMode: input.approvalMode,
    });
    return mapSessionRecord(record, record.sessionId);
  }

  async createSessionInScope(
    scopeId: string,
    input: { title?: string; sessionId?: string; approvalMode?: ApprovalMode } = {},
  ): Promise<SupervisorSessionItem> {
    const scope = this.snapshot.scopes.find((candidate) => candidate.id === scopeId);
    if (!scope) throw new Error(`Unknown session scope: ${scopeId}`);
    const record = await this.ensureApi().createScopedSession({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      title: input.title,
      sessionId: input.sessionId,
      approvalMode: input.approvalMode,
    });
    return mapSessionRecord(record, record.sessionId);
  }

  reloadConfig(): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().reloadConfig());
  }

  async switchSession(sessionId: string): Promise<SupervisorSessionItem> {
    const record = await this.ensureApi().selectSession(sessionId);
    return mapSessionRecord(record, sessionId);
  }

  stopSession(sessionId: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().stopSession(sessionId));
  }

  registerClientLease(selectedSessionId?: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().registerLease(selectedSessionId, this.leaseLabel));
  }

  updateClientLease(selectedSessionId?: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().updateLease(selectedSessionId, this.leaseLabel));
  }

  unregisterClientLease(): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().unregisterLease());
  }

  private async connectInternal(): Promise<SupervisorSnapshot> {
    const previous = this.api;
    this.api = null;
    previous?.disconnect();
    this.updateConnection("connecting", undefined);
    try {
      const api = new SupervisorApiClient(this.endpoint);
      this.api = api;
      api.onSnapshot((snapshot) => {
        if (this.api !== api) return;
        this.updateSnapshot(
          mapSnapshot(snapshot, this.endpoint, {
            status: "connected",
            socketPath: this.endpoint,
          }),
        );
      });
      api.onDisconnect((error) => {
        if (this.api !== api) return;
        this.api = null;
        if (error) this.emit({ type: "error", message: error.message });
        if (this.suppressReconnect || !this.reconnect) this.updateConnection("disconnected");
        else this.scheduleReconnect();
      });
      const initial = await api.connect(this.connectTimeoutMs);
      this.reconnect?.reset();
      this.updateSnapshot(
        mapSnapshot(initial, this.endpoint, { status: "connected", socketPath: this.endpoint }),
      );
      return this.snapshot;
    } catch (error) {
      const api = this.api;
      this.api = null;
      api?.disconnect();
      const message = error instanceof Error ? error.message : String(error);
      this.updateConnection("error", message);
      throw error;
    }
  }

  private ensureApi(): SupervisorApiClient {
    if (!this.api) throw new Error("Supervisor client is not connected.");
    return this.api;
  }

  private async call(run: () => Promise<unknown>): Promise<ResultMessage> {
    const data = await run();
    const result: ResultMessage = {
      type: "result",
      id: crypto.randomUUID(),
      status: "ok",
      data,
    };
    this.emit({ type: "result", result });
    return result;
  }

  private updateConnection(status: ConnectionStatus, error?: string): void {
    this.updateSnapshot({
      ...this.snapshot,
      connection: { ...this.snapshot.connection, status, error },
    });
  }

  private updateSnapshot(snapshot: SupervisorSnapshot): void {
    this.snapshot = snapshot;
    this.emit({ type: "snapshot", snapshot });
  }

  private scheduleReconnect(): void {
    if (!this.reconnect) return;
    const scheduled = this.reconnect.schedule(() => {
      this.connect().catch(() => {
        if (!this.suppressReconnect) this.scheduleReconnect();
      });
    });
    if (!scheduled) {
      const attempts = this.reconnect.attemptCount;
      this.reconnect.reset();
      this.updateConnection("disconnected");
      this.emit({
        type: "error",
        message: `Lost connection to ${this.endpoint}; gave up after ${attempts} attempts.`,
      });
      return;
    }
    this.updateSnapshot({
      ...this.snapshot,
      connection: {
        ...this.snapshot.connection,
        status: "reconnecting",
        reconnectAttempt: this.reconnect.attemptCount,
      },
    });
  }

  private emit(event: SupervisorClientEvent): void {
    for (const listener of this.listeners) this.dispatch(listener, event);
  }

  private dispatch(listener: SupervisorClientListener, event: SupervisorClientEvent): void {
    try {
      listener(event);
    } catch {
      if (process.env.SLOPPY_TUI_DEBUG) {
        console.error("[sloppy-tui] supervisor listener threw on event:", event.type);
      }
    }
  }
}

/** Derives the typed Session API endpoint for a selected session. */
export function endpointForSession(
  session: { id: string; socketPath: string },
  supervisorEndpoint: string | null | undefined,
): string {
  const isWebSocket =
    supervisorEndpoint?.startsWith("ws://") === true ||
    supervisorEndpoint?.startsWith("wss://") === true;
  if (!isWebSocket || !supervisorEndpoint) return session.socketPath;
  const url = new URL(supervisorEndpoint);
  url.pathname =
    url.pathname.replace(/\/api\/supervisor\/?$/, "") +
    `/api/sessions/${encodeURIComponent(session.id)}`;
  return url.toString();
}

import {
  NodeSocketClientTransport,
  type ResultMessage,
  SlopConsumer,
  type SlopNode,
  WebSocketClientTransport,
} from "@slop-ai/consumer";

import {
  connectWithTimeout,
  DEFAULT_CONNECT_TIMEOUT_MS,
  type ReconnectOptions,
  ReconnectScheduler,
} from "./connect-support";
import type { ApprovalMode, ConnectionStatus } from "./slop-types";

export type SupervisorSessionItem = {
  id: string;
  title?: string;
  socketPath: string;
  wsUrl?: string;
  runtimeStatus: "live" | "dormant";
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

const SUBSCRIPTIONS: Array<{ path: string; depth: number }> = [
  { path: "/session", depth: 1 },
  { path: "/sessions", depth: 2 },
  { path: "/scopes", depth: 2 },
];

function props(node: SlopNode | null | undefined): Record<string, unknown> {
  return (node?.properties ?? {}) as Record<string, unknown>;
}

function children(node: SlopNode | null | undefined): SlopNode[] {
  return node?.children ?? [];
}

function stringProp(props: Record<string, unknown>, name: string, fallback = ""): string {
  const value = props[name];
  return typeof value === "string" ? value : fallback;
}

function optionalStringProp(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanProp(props: Record<string, unknown>, name: string): boolean {
  return props[name] === true;
}

function numberProp(props: Record<string, unknown>, name: string, fallback = 0): number {
  const value = props[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function approvalModeProp(data: Record<string, unknown>): ApprovalMode {
  const value =
    optionalStringProp(data, "approvalMode") ?? optionalStringProp(data, "approval_mode");
  if (value === "normal" || value === "auto") {
    return value;
  }
  return "normal";
}

function affordanceActions(node: SlopNode): Set<string> {
  return new Set(node.affordances?.map((affordance) => affordance.action) ?? []);
}

function emptySnapshot(socketPath: string): SupervisorSnapshot {
  return {
    connection: {
      status: "idle",
      socketPath,
    },
    autoCloseEnabled: false,
    clientLeaseCount: 0,
    sessions: [],
    scopes: [],
  };
}

function mapSessionItem(node: SlopNode): SupervisorSessionItem {
  const p = props(node);
  const actions = affordanceActions(node);
  return mapSessionRecord(p, {
    id: stringProp(p, "session_id", node.id),
    isResumeSession: booleanProp(p, "is_resume_session"),
    canSwitch: actions.has("select_session"),
    canStop: actions.has("stop_session"),
  });
}

function mapScopeItem(node: SlopNode): SupervisorScopeItem {
  const p = props(node);
  return {
    id: stringProp(p, "id", node.id),
    name: stringProp(p, "name", node.id),
    description: optionalStringProp(p, "description"),
    root: stringProp(p, "root"),
    workspaceId: stringProp(p, "workspace_id"),
    projectId: optionalStringProp(p, "project_id"),
    canCreate: affordanceActions(node).has("create_session"),
  };
}

function resultRecord(result: ResultMessage): Record<string, unknown> {
  if (result.status === "error") {
    throw new Error(result.error?.message ?? "Supervisor action failed.");
  }
  if (result.status !== "ok" || !result.data || typeof result.data !== "object") {
    return {};
  }
  return result.data as Record<string, unknown>;
}

function mapSessionRecord(
  data: Record<string, unknown>,
  overrides: Partial<SupervisorSessionItem> & Pick<SupervisorSessionItem, "id">,
): SupervisorSessionItem {
  return {
    id: overrides.id,
    title: optionalStringProp(data, "title"),
    socketPath: stringProp(data, "socketPath", stringProp(data, "socket_path")),
    wsUrl:
      optionalStringProp(data, "webSocketUrl") ??
      optionalStringProp(data, "web_socket_url") ??
      optionalStringProp(data, "ws_url"),
    runtimeStatus:
      stringProp(data, "runtimeStatus", stringProp(data, "runtime_status")) === "dormant"
        ? "dormant"
        : "live",
    workspaceRoot:
      optionalStringProp(data, "workspaceRoot") ?? optionalStringProp(data, "workspace_root"),
    workspaceId:
      optionalStringProp(data, "workspaceId") ?? optionalStringProp(data, "workspace_id"),
    projectId: optionalStringProp(data, "projectId") ?? optionalStringProp(data, "project_id"),
    launchScopeKey:
      optionalStringProp(data, "launchScopeKey") ?? optionalStringProp(data, "launch_scope_key"),
    launchRoot: optionalStringProp(data, "launchRoot") ?? optionalStringProp(data, "launch_root"),
    turnState: optionalStringProp(data, "turnState") ?? optionalStringProp(data, "turn_state"),
    turnMessage:
      optionalStringProp(data, "turnMessage") ?? optionalStringProp(data, "turn_message"),
    goalStatus: optionalStringProp(data, "goalStatus") ?? optionalStringProp(data, "goal_status"),
    goalObjective:
      optionalStringProp(data, "goalObjective") ?? optionalStringProp(data, "goal_objective"),
    goalTotalTokens: numberProp(data, "goalTotalTokens", numberProp(data, "goal_total_tokens")),
    queuedCount: numberProp(data, "queuedCount", numberProp(data, "queued_count")),
    pendingApprovalCount: numberProp(
      data,
      "pendingApprovalCount",
      numberProp(data, "pending_approval_count"),
    ),
    runningTaskCount: numberProp(data, "runningTaskCount", numberProp(data, "running_task_count")),
    approvalMode: approvalModeProp(data),
    lastActivityAt:
      optionalStringProp(data, "lastActivityAt") ?? optionalStringProp(data, "last_activity_at"),
    isResumeSession: overrides.isResumeSession ?? booleanProp(data, "is_resume_session"),
    createdAt: optionalStringProp(data, "createdAt") ?? optionalStringProp(data, "created_at"),
    canSwitch: overrides.canSwitch ?? true,
    canStop: overrides.canStop ?? true,
  };
}

export class SessionSupervisorClient {
  private consumer: SlopConsumer | null = null;
  private connectPromise: Promise<SupervisorSnapshot> | null = null;
  private snapshot: SupervisorSnapshot;
  private listeners = new Set<SupervisorClientListener>();
  private pathBySubscriptionId = new Map<string, string>();

  private readonly leaseLabel: string;
  private readonly connectTimeoutMs: number;
  private readonly reconnect: ReconnectScheduler | null;
  private suppressReconnect = false;

  constructor(
    readonly socketPath: string,
    options: SessionSupervisorClientOptions = {},
  ) {
    this.leaseLabel = options.leaseLabel ?? "tui";
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnect = options.reconnect === false ? null : new ReconnectScheduler(options.reconnect);
    this.snapshot = emptySnapshot(socketPath);
  }

  getSnapshot(): SupervisorSnapshot {
    return this.snapshot;
  }

  on(listener: SupervisorClientListener): () => void {
    this.listeners.add(listener);
    this.dispatch(listener, { type: "snapshot", snapshot: this.snapshot });
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<SupervisorSnapshot> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.suppressReconnect = true;
    this.reconnect?.reset();
    this.consumer?.disconnect();
    this.consumer = null;
    this.pathBySubscriptionId.clear();
    this.updateSnapshot({
      ...this.snapshot,
      connection: {
        ...this.snapshot.connection,
        status: "disconnected",
      },
    });
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
    const result = await this.invoke("/session", "create_session", {
      ...(input.workspaceId && { workspace_id: input.workspaceId }),
      ...(input.projectId && { project_id: input.projectId }),
      ...(input.title && { title: input.title }),
      ...(input.sessionId && { session_id: input.sessionId }),
      ...(input.approvalMode && { approval_mode: input.approvalMode }),
    });
    const data = resultRecord(result);
    return mapSessionRecord(data, {
      id: stringProp(data, "sessionId", stringProp(data, "session_id")),
      isResumeSession: true,
      canSwitch: true,
      canStop: true,
    });
  }

  async createSessionInScope(
    scopeId: string,
    input: {
      title?: string;
      sessionId?: string;
      approvalMode?: ApprovalMode;
    } = {},
  ): Promise<SupervisorSessionItem> {
    const result = await this.invoke(`/scopes/${encodeURIComponent(scopeId)}`, "create_session", {
      ...(input.title && { title: input.title }),
      ...(input.sessionId && { session_id: input.sessionId }),
      ...(input.approvalMode && { approval_mode: input.approvalMode }),
    });
    const data = resultRecord(result);
    return mapSessionRecord(data, {
      id: stringProp(data, "sessionId", stringProp(data, "session_id")),
      isResumeSession: true,
      canSwitch: true,
      canStop: true,
    });
  }

  async reloadConfig(): Promise<ResultMessage> {
    return this.invoke("/session", "reload_config");
  }

  async switchSession(sessionId: string): Promise<SupervisorSessionItem> {
    const result = await this.invoke(
      `/sessions/${encodeURIComponent(sessionId)}`,
      "select_session",
    );
    const data = resultRecord(result);
    return mapSessionRecord(data, {
      id: stringProp(data, "sessionId", stringProp(data, "session_id", sessionId)),
      isResumeSession: true,
      canSwitch: true,
      canStop: true,
    });
  }

  async stopSession(sessionId: string): Promise<ResultMessage> {
    const result = await this.invoke(`/sessions/${encodeURIComponent(sessionId)}`, "stop_session");
    resultRecord(result);
    return result;
  }

  async registerClientLease(selectedSessionId?: string): Promise<ResultMessage> {
    return this.invoke("/session", "register_client_lease", {
      label: this.leaseLabel,
      ...(selectedSessionId && { selected_session_id: selectedSessionId }),
    });
  }

  async updateClientLease(selectedSessionId?: string): Promise<ResultMessage> {
    return this.invoke("/session", "update_client_lease", {
      label: this.leaseLabel,
      ...(selectedSessionId && { selected_session_id: selectedSessionId }),
    });
  }

  async unregisterClientLease(): Promise<ResultMessage> {
    return this.invoke("/session", "unregister_client_lease");
  }

  private async connectInternal(): Promise<SupervisorSnapshot> {
    this.consumer?.disconnect();
    this.consumer = null;
    this.pathBySubscriptionId.clear();
    this.updateSnapshot({
      ...this.snapshot,
      connection: {
        ...this.snapshot.connection,
        status: "connecting",
        error: undefined,
      },
    });

    try {
      const consumer = new SlopConsumer(createTransportFromEndpoint(this.socketPath));
      this.consumer = consumer;
      await connectWithTimeout(consumer, this.connectTimeoutMs, this.socketPath);
      this.reconnect?.reset();
      this.updateSnapshot({
        ...this.snapshot,
        connection: {
          ...this.snapshot.connection,
          status: "connected",
          error: undefined,
          reconnectAttempt: undefined,
        },
      });

      consumer.on("patch", (subscriptionId: string) => {
        const path = this.pathBySubscriptionId.get(subscriptionId);
        const tree = consumer.getTree(subscriptionId);
        if (path && tree) {
          this.applyPath(path, tree);
        }
      });
      consumer.on("disconnect", () => {
        if (this.consumer !== consumer) {
          return;
        }
        this.consumer = null;
        this.pathBySubscriptionId.clear();
        if (this.suppressReconnect || !this.reconnect) {
          this.updateSnapshot({
            ...this.snapshot,
            connection: {
              ...this.snapshot.connection,
              status: "disconnected",
            },
          });
          return;
        }
        this.scheduleReconnect();
      });
      consumer.onError((error) => {
        this.emit({ type: "error", message: error.message });
      });

      for (const subscription of SUBSCRIPTIONS) {
        const { id, snapshot } = await consumer.subscribe(subscription.path, subscription.depth);
        this.pathBySubscriptionId.set(id, subscription.path);
        this.applyPath(subscription.path, snapshot);
      }

      return this.snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateSnapshot({
        ...this.snapshot,
        connection: {
          ...this.snapshot.connection,
          status: "error",
          error: message,
        },
      });
      throw error;
    }
  }

  private async invoke(
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    const result = await (await this.ensureConsumer()).invoke(path, action, params);
    this.emit({ type: "result", result });
    return result;
  }

  private async ensureConsumer(): Promise<SlopConsumer> {
    if (!this.consumer) {
      await this.connect();
    }
    if (!this.consumer) {
      throw new Error("Supervisor client is not connected.");
    }
    return this.consumer;
  }

  private applyPath(path: string, node: SlopNode): void {
    if (path === "/session") {
      const p = props(node);
      this.updateSnapshot({
        ...this.snapshot,
        resumeSessionId: optionalStringProp(p, "resume_session_id"),
        resumeSocketPath: optionalStringProp(p, "resume_socket_path"),
        autoCloseEnabled: booleanProp(p, "auto_close_enabled"),
        clientLeaseCount: numberProp(p, "client_lease_count"),
      });
      return;
    }

    if (path === "/sessions") {
      this.updateSnapshot({
        ...this.snapshot,
        sessions: children(node).map(mapSessionItem),
      });
      return;
    }

    if (path === "/scopes") {
      this.updateSnapshot({
        ...this.snapshot,
        scopes: children(node).map(mapScopeItem),
      });
    }
  }

  private updateSnapshot(snapshot: SupervisorSnapshot): void {
    this.snapshot = snapshot;
    this.emit({ type: "snapshot", snapshot });
  }

  private scheduleReconnect(): void {
    if (!this.reconnect) {
      return;
    }
    const scheduled = this.reconnect.schedule(() => {
      this.connect().catch(() => {
        // connectInternal already published status "error"; keep retrying
        // until the budget runs out.
        if (!this.suppressReconnect) {
          this.scheduleReconnect();
        }
      });
    });
    if (!scheduled) {
      const attempts = this.reconnect.attemptCount;
      this.reconnect.reset();
      this.updateSnapshot({
        ...this.snapshot,
        connection: {
          ...this.snapshot.connection,
          status: "disconnected",
          reconnectAttempt: undefined,
        },
      });
      this.emit({
        type: "error",
        message: `Lost connection to ${this.socketPath}; gave up after ${attempts} attempts.`,
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
    for (const listener of this.listeners) {
      this.dispatch(listener, event);
    }
  }

  private dispatch(listener: SupervisorClientListener, event: SupervisorClientEvent): void {
    try {
      listener(event);
    } catch {
      // Deliberately swallowed: a throwing UI listener must not break event
      // fan-out or crash the client, and stderr writes would corrupt the
      // TUI screen. Set SLOPPY_TUI_DEBUG=1 and redirect stderr to inspect.
      if (process.env.SLOPPY_TUI_DEBUG) {
        console.error("[sloppy-tui] supervisor listener threw on event:", event.type);
      }
    }
  }
}

function createTransportFromEndpoint(endpoint: string) {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    return new WebSocketClientTransport(endpoint);
  }
  return new NodeSocketClientTransport(endpoint);
}

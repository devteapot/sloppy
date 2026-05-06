import {
  NodeSocketClientTransport,
  type ResultMessage,
  SlopConsumer,
  type SlopNode,
} from "@slop-ai/consumer";

export type SupervisorSessionItem = {
  id: string;
  title?: string;
  socketPath: string;
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  turnState?: string;
  turnMessage?: string;
  goalStatus?: string;
  goalObjective?: string;
  goalTotalTokens: number;
  queuedCount: number;
  pendingApprovalCount: number;
  runningTaskCount: number;
  lastActivityAt?: string;
  selected: boolean;
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
    status: "idle" | "connecting" | "connected" | "disconnected" | "error";
    socketPath: string;
    error?: string;
  };
  activeSessionId?: string;
  activeSocketPath?: string;
  sessions: SupervisorSessionItem[];
  scopes: SupervisorScopeItem[];
};

export type SupervisorClientEvent =
  | { type: "snapshot"; snapshot: SupervisorSnapshot }
  | { type: "result"; result: ResultMessage }
  | { type: "error"; message: string };

export type SupervisorClientListener = (event: SupervisorClientEvent) => void;

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

function affordanceActions(node: SlopNode): Set<string> {
  return new Set(node.affordances?.map((affordance) => affordance.action) ?? []);
}

function emptySnapshot(socketPath: string): SupervisorSnapshot {
  return {
    connection: {
      status: "idle",
      socketPath,
    },
    sessions: [],
    scopes: [],
  };
}

function mapSessionItem(node: SlopNode): SupervisorSessionItem {
  const p = props(node);
  const actions = affordanceActions(node);
  return mapSessionRecord(p, {
    id: stringProp(p, "session_id", node.id),
    selected: booleanProp(p, "selected"),
    canSwitch: actions.has("set_active"),
    canStop: actions.has("stop"),
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
    workspaceRoot:
      optionalStringProp(data, "workspaceRoot") ?? optionalStringProp(data, "workspace_root"),
    workspaceId:
      optionalStringProp(data, "workspaceId") ?? optionalStringProp(data, "workspace_id"),
    projectId: optionalStringProp(data, "projectId") ?? optionalStringProp(data, "project_id"),
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
    lastActivityAt:
      optionalStringProp(data, "lastActivityAt") ?? optionalStringProp(data, "last_activity_at"),
    selected: overrides.selected ?? false,
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

  constructor(readonly socketPath: string) {
    this.snapshot = emptySnapshot(socketPath);
  }

  getSnapshot(): SupervisorSnapshot {
    return this.snapshot;
  }

  on(listener: SupervisorClientListener): () => void {
    this.listeners.add(listener);
    listener({ type: "snapshot", snapshot: this.snapshot });
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
    input: { workspaceId?: string; projectId?: string; title?: string; sessionId?: string } = {},
  ): Promise<SupervisorSessionItem> {
    const result = await this.invoke("/session", "create_session", {
      ...(input.workspaceId && { workspace_id: input.workspaceId }),
      ...(input.projectId && { project_id: input.projectId }),
      ...(input.title && { title: input.title }),
      ...(input.sessionId && { session_id: input.sessionId }),
    });
    const data = resultRecord(result);
    return mapSessionRecord(data, {
      id: stringProp(data, "sessionId", stringProp(data, "session_id")),
      selected: true,
      canSwitch: true,
      canStop: true,
    });
  }

  async switchSession(sessionId: string): Promise<SupervisorSessionItem> {
    const result = await this.invoke(`/sessions/${encodeURIComponent(sessionId)}`, "set_active");
    const data = resultRecord(result);
    return mapSessionRecord(data, {
      id: stringProp(data, "sessionId", stringProp(data, "session_id", sessionId)),
      selected: true,
      canSwitch: true,
      canStop: true,
    });
  }

  async stopSession(sessionId: string): Promise<ResultMessage> {
    return this.invoke(`/sessions/${encodeURIComponent(sessionId)}`, "stop");
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
      const consumer = new SlopConsumer(new NodeSocketClientTransport(this.socketPath));
      this.consumer = consumer;
      await consumer.connect();
      this.updateSnapshot({
        ...this.snapshot,
        connection: {
          ...this.snapshot.connection,
          status: "connected",
          error: undefined,
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
        this.updateSnapshot({
          ...this.snapshot,
          connection: {
            ...this.snapshot.connection,
            status: "disconnected",
          },
        });
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
        activeSessionId: optionalStringProp(p, "active_session_id"),
        activeSocketPath: optionalStringProp(p, "active_socket_path"),
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

  private emit(event: SupervisorClientEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

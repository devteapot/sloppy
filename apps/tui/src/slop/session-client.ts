import {
  NodeSocketClientTransport,
  type ResultMessage,
  SlopConsumer,
  type SlopNode,
  WebSocketClientTransport,
} from "@slop-ai/consumer";

import {
  applyPathSnapshot,
  EMPTY_SESSION_VIEW,
  withConnectionState,
  withInspectResult,
  withInspectTree,
} from "./node-mappers";
import type {
  InspectQueryOptions,
  SaveProfileInput,
  SessionClientEvent,
  SessionClientListener,
  SessionViewSnapshot,
} from "./types";

const SUBSCRIPTIONS: Array<{ path: string; depth: number }> = [
  { path: "/session", depth: 1 },
  { path: "/llm", depth: 2 },
  { path: "/turn", depth: 1 },
  { path: "/composer", depth: 1 },
  { path: "/transcript", depth: 3 },
  { path: "/activity", depth: 2 },
  { path: "/approvals", depth: 2 },
  { path: "/tasks", depth: 2 },
  { path: "/apps", depth: 2 },
  { path: "/queue", depth: 2 },
];

export class SessionClient {
  private consumer: SlopConsumer | null = null;
  private connectPromise: Promise<SessionViewSnapshot> | null = null;
  private snapshot: SessionViewSnapshot;
  private listeners = new Set<SessionClientListener>();
  private pathBySubscriptionId = new Map<string, string>();
  private inspectConsumers = new Map<string, SlopConsumer>();

  constructor(readonly socketPath: string) {
    this.snapshot = withConnectionState(EMPTY_SESSION_VIEW, {
      socketPath,
    });
  }

  getSnapshot(): SessionViewSnapshot {
    return this.snapshot;
  }

  on(listener: SessionClientListener): () => void {
    this.listeners.add(listener);
    listener({ type: "snapshot", snapshot: this.snapshot });
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<SessionViewSnapshot> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<SessionViewSnapshot> {
    this.consumer?.disconnect();
    this.consumer = null;
    this.pathBySubscriptionId.clear();
    this.updateSnapshot(
      withConnectionState(this.snapshot, {
        status: "connecting",
        error: undefined,
      }),
    );

    try {
      const consumer = new SlopConsumer(new NodeSocketClientTransport(this.socketPath));
      this.consumer = consumer;
      const hello = await consumer.connect();
      this.updateSnapshot(
        withConnectionState(this.snapshot, {
          status: "connected",
          providerId: hello.provider.id,
          providerName: hello.provider.name,
          error: undefined,
        }),
      );

      consumer.on("patch", (subscriptionId: string) => {
        const path = this.pathBySubscriptionId.get(subscriptionId);
        const tree = consumer.getTree(subscriptionId);
        if (path && tree) {
          this.updateSnapshot(applyPathSnapshot(this.snapshot, path, tree));
        }
      });
      consumer.on("disconnect", () => {
        if (this.consumer !== consumer) {
          return;
        }
        this.consumer = null;
        this.pathBySubscriptionId.clear();
        this.updateSnapshot(
          withConnectionState(this.snapshot, {
            status: "disconnected",
          }),
        );
      });
      consumer.onError((error) => {
        this.emit({
          type: "error",
          message: error.message,
        });
      });

      for (const subscription of SUBSCRIPTIONS) {
        const { id, snapshot } = await consumer.subscribe(subscription.path, subscription.depth);
        this.pathBySubscriptionId.set(id, subscription.path);
        this.updateSnapshot(applyPathSnapshot(this.snapshot, subscription.path, snapshot));
      }

      return this.snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateSnapshot(
        withConnectionState(this.snapshot, {
          status: "error",
          error: message,
        }),
      );
      throw error;
    }
  }

  disconnect(): void {
    this.consumer?.disconnect();
    this.consumer = null;
    for (const consumer of this.inspectConsumers.values()) {
      consumer.disconnect();
    }
    this.inspectConsumers.clear();
    this.pathBySubscriptionId.clear();
    this.updateSnapshot(
      withConnectionState(this.snapshot, {
        status: "disconnected",
      }),
    );
  }

  async sendMessage(text: string): Promise<ResultMessage> {
    return this.invoke("/composer", "send_message", { text });
  }

  async cancelTurn(): Promise<ResultMessage> {
    return this.invoke("/turn", "cancel_turn");
  }

  async approveApproval(id: string): Promise<ResultMessage> {
    return this.invoke(`/approvals/${id}`, "approve");
  }

  async rejectApproval(id: string, reason?: string): Promise<ResultMessage> {
    return this.invoke(`/approvals/${id}`, "reject", reason ? { reason } : undefined);
  }

  async cancelTask(id: string): Promise<ResultMessage> {
    return this.invoke(`/tasks/${id}`, "cancel");
  }

  async cancelQueuedMessage(id: string): Promise<ResultMessage> {
    return this.invoke(`/queue/${id}`, "cancel");
  }

  async saveProfile(input: SaveProfileInput): Promise<ResultMessage> {
    return this.invoke("/llm", "save_profile", {
      ...(input.profileId && { profile_id: input.profileId }),
      ...(input.label && { label: input.label }),
      provider: input.provider,
      ...(input.model && { model: input.model }),
      ...(input.reasoningEffort && { reasoning_effort: input.reasoningEffort }),
      ...(input.adapterId && { adapter_id: input.adapterId }),
      ...(input.baseUrl && { base_url: input.baseUrl }),
      ...(input.apiKey && { api_key: input.apiKey }),
      ...(input.makeDefault !== undefined && { make_default: input.makeDefault }),
    });
  }

  async setDefaultProfile(profileId: string): Promise<ResultMessage> {
    return this.invoke("/llm", "set_default_profile", { profile_id: profileId });
  }

  async deleteProfile(profileId: string): Promise<ResultMessage> {
    return this.invoke("/llm", "delete_profile", { profile_id: profileId });
  }

  async deleteApiKey(profileId: string): Promise<ResultMessage> {
    return this.invoke("/llm", "delete_api_key", { profile_id: profileId });
  }

  async queryInspect(
    path: string,
    depth: number,
    targetId = "session",
    options?: InspectQueryOptions,
  ): Promise<SlopNode> {
    const target = await this.resolveInspectTarget(targetId);
    const tree = await target.consumer.query(path, depth, {
      ...(options?.maxNodes !== undefined && { max_nodes: options.maxNodes }),
      ...(options?.window && { window: options.window }),
    });
    this.updateSnapshot(
      withInspectTree(this.snapshot, {
        targetId: target.id,
        targetName: target.name,
        targetTransport: target.transport,
        path,
        depth,
        window: options?.window,
        maxNodes: options?.maxNodes,
        tree,
        error: undefined,
      }),
    );
    return tree;
  }

  async invokeInspect(
    path: string,
    action: string,
    params?: Record<string, unknown>,
    targetId = "session",
  ): Promise<ResultMessage> {
    const target = await this.resolveInspectTarget(targetId);
    const result =
      target.id === "session"
        ? await this.invoke(path, action, params)
        : await target.consumer.invoke(path, action, params);
    this.updateSnapshot(
      withInspectTree(this.snapshot, {
        targetId: target.id,
        targetName: target.name,
        targetTransport: target.transport,
        path,
      }),
    );
    this.updateSnapshot(withInspectResult(this.snapshot, result));
    return result;
  }

  private async invoke(
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    const result = await (await this.ensureConsumer()).invoke(path, action, params);
    this.emit({
      type: "result",
      result,
    });
    return result;
  }

  private async ensureConsumer(): Promise<SlopConsumer> {
    if (this.consumer) {
      return this.consumer;
    }

    await this.connect();
    return this.requireConsumer();
  }

  private requireConsumer(): SlopConsumer {
    if (!this.consumer) {
      throw new Error("Session client is not connected.");
    }
    return this.consumer;
  }

  private async resolveInspectTarget(targetId: string): Promise<{
    id: string;
    name: string;
    transport?: string;
    consumer: SlopConsumer;
  }> {
    if (!targetId || targetId === "session") {
      return {
        id: "session",
        name: this.snapshot.connection.providerName ?? "Session",
        transport: this.snapshot.connection.socketPath
          ? `unix:${this.snapshot.connection.socketPath}`
          : undefined,
        consumer: await this.ensureConsumer(),
      };
    }

    const app = this.snapshot.apps.find(
      (item) => item.id === targetId || item.providerId === targetId || item.name === targetId,
    );
    if (!app) {
      throw new Error(`Unknown inspect target: ${targetId}`);
    }
    if (app.status !== "connected") {
      throw new Error(`Inspect target is not connected: ${app.name}`);
    }

    const cacheKey = `${app.id}:${app.transport}`;
    const existing = this.inspectConsumers.get(cacheKey);
    if (existing) {
      return {
        id: app.id,
        name: app.name,
        transport: app.transport,
        consumer: existing,
      };
    }

    const consumer = new SlopConsumer(createTransportFromLabel(app.transport));
    const hello = await consumer.connect();
    consumer.onError((error) => {
      this.emit({
        type: "error",
        message: `${hello.provider.name}: ${error.message}`,
      });
    });
    consumer.on("disconnect", () => {
      this.inspectConsumers.delete(cacheKey);
    });
    this.inspectConsumers.set(cacheKey, consumer);
    return {
      id: app.id,
      name: hello.provider.name || app.name,
      transport: app.transport,
      consumer,
    };
  }

  private updateSnapshot(snapshot: SessionViewSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    this.invalidateStaleInspectConsumers(previous, snapshot);
    this.emit({ type: "snapshot", snapshot });
  }

  private invalidateStaleInspectConsumers(
    previous: SessionViewSnapshot,
    next: SessionViewSnapshot,
  ): void {
    if (previous.apps === next.apps) {
      return;
    }
    if (this.inspectConsumers.size === 0) {
      return;
    }
    const liveByCacheKey = new Map<string, "connected" | "other">();
    for (const app of next.apps) {
      liveByCacheKey.set(
        `${app.id}:${app.transport}`,
        app.status === "connected" ? "connected" : "other",
      );
    }
    for (const [key, consumer] of [...this.inspectConsumers]) {
      const status = liveByCacheKey.get(key);
      if (status === undefined || status === "other") {
        consumer.disconnect();
        this.inspectConsumers.delete(key);
      }
    }
  }

  private emit(event: SessionClientEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createTransportFromLabel(label: string) {
  if (label.startsWith("unix:")) {
    return new NodeSocketClientTransport(label.slice("unix:".length));
  }

  if (label.startsWith("ws:")) {
    return new WebSocketClientTransport(label.slice("ws:".length));
  }

  throw new Error(`Unsupported inspect transport: ${label}`);
}

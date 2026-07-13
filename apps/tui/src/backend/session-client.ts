import type { ResultMessage, SlopNode } from "@slop-ai/consumer";
import { SessionApiClient } from "sloppy/session";

import { type ReconnectOptions, ReconnectScheduler } from "./connect-support";
import {
  EMPTY_SESSION_VIEW,
  mapClientSnapshot,
  withConnectionState,
  withInspectResult,
  withInspectTree,
} from "./node-mappers";
import type {
  ApprovalMode,
  CreateGoalInput,
  InspectQueryOptions,
  SaveProfileInput,
  SessionClientEvent,
  SessionClientListener,
  SessionViewSnapshot,
} from "./slop-types";

export type SessionClientOptions = {
  connectTimeoutMs?: number;
  reconnect?: ReconnectOptions | false;
};

export class SessionClient {
  private api: SessionApiClient | null = null;
  private connectPromise: Promise<SessionViewSnapshot> | null = null;
  private snapshot: SessionViewSnapshot;
  private listeners = new Set<SessionClientListener>();
  private readonly connectTimeoutMs: number;
  private readonly reconnect: ReconnectScheduler | null;
  private suppressReconnect = false;
  private socketPath: string;

  constructor(socketPath: string, options: SessionClientOptions = {}) {
    this.socketPath = socketPath;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.reconnect = options.reconnect === false ? null : new ReconnectScheduler(options.reconnect);
    this.snapshot = withConnectionState(EMPTY_SESSION_VIEW, { socketPath: this.socketPath });
  }

  getSnapshot(): SessionViewSnapshot {
    return this.snapshot;
  }

  on(listener: SessionClientListener): () => void {
    this.listeners.add(listener);
    this.dispatch(listener, { type: "snapshot", snapshot: this.snapshot });
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<SessionViewSnapshot> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<SessionViewSnapshot> {
    this.api?.disconnect();
    this.api = null;
    this.updateSnapshot(
      withConnectionState(this.snapshot, { status: "connecting", error: undefined }),
    );
    try {
      const api = new SessionApiClient(this.socketPath);
      this.api = api;
      api.onSnapshot((snapshot) => {
        if (this.api !== api) return;
        this.updateSnapshot(
          withConnectionState(mapClientSnapshot(snapshot, this.snapshot), {
            status: "connected",
            socketPath: this.socketPath,
            providerId: snapshot.session.session.sessionId,
            providerName: "Session",
            error: undefined,
            reconnectAttempt: undefined,
          }),
        );
      });
      api.onDisconnect((error) => {
        if (this.api !== api) return;
        this.api = null;
        if (error) this.emit({ type: "error", message: error.message });
        if (this.suppressReconnect || !this.reconnect) {
          this.updateSnapshot(withConnectionState(this.snapshot, { status: "disconnected" }));
        } else {
          this.scheduleReconnect();
        }
      });
      const initial = await api.connect(this.connectTimeoutMs);
      this.reconnect?.reset();
      this.updateSnapshot(
        withConnectionState(mapClientSnapshot(initial, this.snapshot), {
          status: "connected",
          socketPath: this.socketPath,
          providerId: initial.session.session.sessionId,
          providerName: "Session",
          error: undefined,
          reconnectAttempt: undefined,
        }),
      );
      return this.snapshot;
    } catch (error) {
      if (this.api) {
        this.api.disconnect();
        this.api = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.updateSnapshot(withConnectionState(this.snapshot, { status: "error", error: message }));
      throw error;
    }
  }

  disconnect(): void {
    this.suppressReconnect = true;
    this.reconnect?.reset();
    const api = this.api;
    this.api = null;
    api?.disconnect();
    this.updateSnapshot(withConnectionState(this.snapshot, { status: "disconnected" }));
  }

  async switchSocket(socketPath: string): Promise<SessionViewSnapshot> {
    this.suppressReconnect = true;
    this.reconnect?.reset();
    const api = this.api;
    this.api = null;
    api?.disconnect();
    this.socketPath = socketPath;
    this.updateSnapshot(
      withConnectionState(EMPTY_SESSION_VIEW, { socketPath: this.socketPath, status: "idle" }),
    );
    this.suppressReconnect = false;
    return this.connect();
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
      this.updateSnapshot(
        withConnectionState(this.snapshot, {
          status: "disconnected",
          reconnectAttempt: undefined,
        }),
      );
      this.emit({
        type: "error",
        message: `Lost connection to ${this.socketPath}; gave up after ${attempts} attempts.`,
      });
      return;
    }
    this.updateSnapshot(
      withConnectionState(this.snapshot, {
        status: "reconnecting",
        reconnectAttempt: this.reconnect.attemptCount,
      }),
    );
  }

  async sendMessage(text: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().sendMessage(text));
  }

  async cancelTurn(): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().cancelTurn());
  }

  async approveApproval(id: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().approveApproval(id));
  }

  async rejectApproval(id: string, reason?: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().rejectApproval(id, reason));
  }

  async setApprovalMode(mode: ApprovalMode): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().setApprovalMode(mode));
  }

  async reloadConfig(): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().reloadConfig());
  }

  async cancelTask(id: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().cancelTask(id));
  }

  async cancelQueuedMessage(id: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().cancelQueuedMessage(id));
  }

  async createGoal(input: CreateGoalInput): Promise<ResultMessage> {
    return this.invokePlugin("persistent-goal", "create", {
      objective: input.objective,
      ...(input.tokenBudget !== undefined && { token_budget: input.tokenBudget }),
    });
  }

  async pauseGoal(message?: string): Promise<ResultMessage> {
    return this.invokePlugin("persistent-goal", "pause", message ? { message } : undefined);
  }

  async resumeGoal(message?: string): Promise<ResultMessage> {
    return this.invokePlugin("persistent-goal", "resume", message ? { message } : undefined);
  }

  async completeGoal(message?: string): Promise<ResultMessage> {
    return this.invokePlugin("persistent-goal", "complete", message ? { message } : undefined);
  }

  async clearGoal(): Promise<ResultMessage> {
    return this.invokePlugin("persistent-goal", "clear");
  }

  async invokePlugin(
    pluginId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().invokePlugin(pluginId, command, params));
  }

  async saveProfile(input: SaveProfileInput): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().saveLlmProfile(input));
  }

  async setDefaultProfile(profileId: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().setDefaultLlmProfile(profileId));
  }

  async deleteProfile(profileId: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().deleteLlmProfile(profileId));
  }

  async deleteApiKey(profileId: string): Promise<ResultMessage> {
    return this.call(() => this.ensureApi().deleteLlmApiKey(profileId));
  }

  async queryInspect(
    path: string,
    depth: number,
    targetId = "session",
    options?: InspectQueryOptions,
  ): Promise<SlopNode> {
    if (targetId === "session") {
      const tree = typedSessionInspectNode(this.ensureApi().getSnapshot(), path);
      this.updateSnapshot(
        withInspectTree(this.snapshot, {
          targetId: "session",
          targetName: "Session",
          targetTransport: endpointTransportLabel(this.socketPath),
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
    const providerId = providerIdFromTarget(targetId);
    const tree = await this.ensureApi().queryProvider({
      providerId,
      path,
      depth,
      maxNodes: options?.maxNodes,
      window: options?.window,
    });
    this.updateSnapshot(
      withInspectTree(this.snapshot, {
        targetId,
        targetName: providerId === "meta-runtime" ? "Meta Runtime" : providerId,
        targetTransport: `session-provider:${providerId}`,
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
    if (targetId === "session") {
      throw new Error(
        "The Session uses typed commands. Use a session command or target a provider explicitly.",
      );
    }
    const providerId = providerIdFromTarget(targetId);
    const result = await this.ensureApi().invokeProvider({ providerId, path, action, params });
    this.updateSnapshot(
      withInspectTree(this.snapshot, {
        targetId,
        targetName: providerId === "meta-runtime" ? "Meta Runtime" : providerId,
        targetTransport: `session-provider:${providerId}`,
        path,
      }),
    );
    this.updateSnapshot(withInspectResult(this.snapshot, result));
    this.emit({ type: "result", result });
    return result;
  }

  private ensureApi(): SessionApiClient {
    if (!this.api) throw new Error("Session client is not connected.");
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

  private updateSnapshot(snapshot: SessionViewSnapshot): void {
    this.snapshot = snapshot;
    this.emit({ type: "snapshot", snapshot });
  }

  private emit(event: SessionClientEvent): void {
    for (const listener of this.listeners) this.dispatch(listener, event);
  }

  private dispatch(listener: SessionClientListener, event: SessionClientEvent): void {
    try {
      listener(event);
    } catch {
      if (process.env.SLOPPY_TUI_DEBUG) {
        console.error("[sloppy-tui] session listener threw on event:", event.type);
      }
    }
  }
}

function providerIdFromTarget(targetId: string): string {
  return targetId.startsWith("session-proxy:") ? targetId.slice("session-proxy:".length) : targetId;
}

function typedSessionInspectNode(
  snapshot: import("sloppy/session").SessionClientSnapshot | null,
  path: string,
): SlopNode {
  const value = path === "/" ? snapshot : readPath(snapshot, path);
  return {
    id: path === "/" ? "session" : (path.split("/").filter(Boolean).at(-1) ?? "session"),
    type: "context",
    properties: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
    children: [],
  };
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split("/").filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function endpointTransportLabel(endpoint: string): string {
  return endpoint.startsWith("ws://") || endpoint.startsWith("wss://")
    ? `ws:${endpoint}`
    : `unix:${endpoint}`;
}

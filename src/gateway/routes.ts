/**
 * Session routing for the WS gateway: one SLOP consumer connection to the
 * supervisor's unix socket, subscribed to /sessions, mapping session ids to
 * per-session unix socket paths. The data path never goes through this
 * consumer — it only answers "where does /sessions/<id> dial to?".
 */

import { SlopConsumer, type SlopNode } from "@slop-ai/consumer";

// The repo's Bun-native transport rejects cleanly when the socket path is
// missing; the SDK's node:net-based transport leaks an unhandled error event
// under Bun before its error listener attaches.
import { NodeSocketClientTransport } from "../providers/node-socket";

export type SessionRoute =
  | { status: "live"; socketPath: string }
  | { status: "dormant" }
  | { status: "unknown" };

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
const REFRESH_TIMEOUT_MS = 2_000;

export class SessionRouteTable {
  private consumer: SlopConsumer | null = null;
  private subscriptionId: string | null = null;
  private stopped = false;
  private retryDelayMs = INITIAL_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;

  constructor(private readonly options: { supervisorSocketPath: string }) {}

  /** Begins connecting in the background; failures retry with capped backoff. */
  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.consumer?.disconnect();
    this.consumer = null;
    this.subscriptionId = null;
  }

  get connected(): boolean {
    return this.consumer !== null;
  }

  async resolve(sessionId: string): Promise<SessionRoute> {
    const mirrored = lookupSession(this.currentTree(), sessionId);
    if (mirrored.status === "live") {
      return mirrored;
    }
    // The supervisor refreshes its tree synchronously inside invoke handling,
    // so a bounded re-query closes the select_session → immediate-dial race
    // where our subscription patch hasn't arrived yet.
    const fresh = await this.queryFresh();
    if (fresh) {
      return lookupSession(fresh, sessionId);
    }
    return mirrored;
  }

  private currentTree(): SlopNode | null {
    if (!this.consumer || !this.subscriptionId) {
      return null;
    }
    return this.consumer.getTree(this.subscriptionId);
  }

  private async queryFresh(): Promise<SlopNode | null> {
    const consumer = this.consumer;
    if (!consumer) {
      return null;
    }
    try {
      return await Promise.race([
        consumer.query("/sessions", 2),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), REFRESH_TIMEOUT_MS)),
      ]);
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.consumer) {
      return;
    }
    this.connecting = true;
    try {
      const consumer = new SlopConsumer(
        new NodeSocketClientTransport(this.options.supervisorSocketPath),
      );
      await consumer.connect();
      const { id } = await consumer.subscribe("/sessions", 2);
      if (this.stopped) {
        consumer.disconnect();
        return;
      }
      this.consumer = consumer;
      this.subscriptionId = id;
      this.retryDelayMs = INITIAL_RETRY_MS;
      consumer.on("disconnect", () => {
        if (this.consumer === consumer) {
          this.consumer = null;
          this.subscriptionId = null;
        }
        this.scheduleReconnect();
      });
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}

function lookupSession(tree: SlopNode | null, sessionId: string): SessionRoute {
  if (!tree) {
    return { status: "unknown" };
  }
  for (const child of tree.children ?? []) {
    const props = (child.properties ?? {}) as Record<string, unknown>;
    const id = typeof props.session_id === "string" ? props.session_id : safeDecode(child.id);
    if (id !== sessionId) {
      continue;
    }
    const socketPath = typeof props.socket_path === "string" ? props.socket_path : "";
    if (props.runtime_status === "dormant" || socketPath.length === 0) {
      return { status: "dormant" };
    }
    return { status: "live", socketPath };
  }
  return { status: "unknown" };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

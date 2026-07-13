/** Session routing for the typed WebSocket gateway. */

import type { PublicSessionRecord, SupervisorClientSnapshot } from "../session";
import { SupervisorApiClient } from "../session/client-protocol";

export type SessionRoute =
  | { status: "live"; socketPath: string }
  | { status: "dormant" }
  | { status: "unknown" };

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
const REFRESH_TIMEOUT_MS = 2_000;

export class SessionRouteTable {
  private client: SupervisorApiClient | null = null;
  private snapshot: SupervisorClientSnapshot | null = null;
  private stopped = false;
  private retryDelayMs = INITIAL_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;

  constructor(private readonly supervisorSocketPath: string) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    client?.disconnect();
  }

  async resolve(sessionId: string): Promise<SessionRoute> {
    const mirrored = lookupTypedSession(this.snapshot, sessionId);
    if (mirrored.status === "live") return mirrored;
    const client = this.client;
    if (!client) return mirrored;
    try {
      const fresh = await Promise.race([
        client.refreshSnapshot(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), REFRESH_TIMEOUT_MS)),
      ]);
      if (fresh) {
        this.snapshot = fresh;
        return lookupTypedSession(fresh, sessionId);
      }
    } catch {
      // The disconnect listener owns reconnect scheduling.
    }
    return mirrored;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.client) return;
    this.connecting = true;
    try {
      const client = new SupervisorApiClient(this.supervisorSocketPath);
      client.onSnapshot((snapshot) => {
        if (this.client === client) this.snapshot = snapshot;
      });
      client.onDisconnect(() => {
        if (this.client !== client) return;
        this.client = null;
        this.scheduleReconnect();
      });
      const snapshot = await client.connect();
      if (this.stopped) {
        client.disconnect();
        return;
      }
      this.client = client;
      this.snapshot = snapshot;
      this.retryDelayMs = INITIAL_RETRY_MS;
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}

function lookupTypedSession(
  snapshot: SupervisorClientSnapshot | null,
  sessionId: string,
): SessionRoute {
  const record = snapshot?.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!record) return { status: "unknown" };
  return typedSessionRoute(record);
}

function typedSessionRoute(record: PublicSessionRecord): SessionRoute {
  const socketPath = record.socketPath ?? "";
  const runtimeStatus = record.runtimeStatus;
  return runtimeStatus === "dormant" || !socketPath
    ? { status: "dormant" }
    : { status: "live", socketPath };
}

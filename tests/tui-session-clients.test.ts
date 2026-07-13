import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServer } from "node:net";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";
import { listenClientProtocol } from "../src/session/client-protocol/rpc-server";
import {
  CLIENT_PROTOCOL_VERSION,
  SESSION_CLIENT_PROTOCOL,
  type SessionClientSnapshot,
  SUPERVISOR_CLIENT_PROTOCOL,
  type SupervisorClientSnapshot,
} from "../src/session/client-protocol/types";
import { SessionStore } from "../src/session/store";

const listeners: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.close();
});

async function waitFor<T>(check: () => T | null, timeoutMs = 2_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result !== null) return result;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition.");
}

function sessionSnapshot(overrides: Partial<SessionClientSnapshot> = {}): SessionClientSnapshot {
  const store = new SessionStore({
    sessionId: "sess-typed",
    modelProvider: "openai",
    model: "test-model",
  });
  return {
    session: store.getSnapshot(),
    controls: {
      canSendMessage: true,
      canCancelTurn: false,
      canReloadConfig: true,
    },
    plugins: [],
    ...overrides,
  };
}

function listenMockSession(
  socketPath: string,
  options: {
    snapshot?: SessionClientSnapshot;
    handleRequest?: (method: string, params: Record<string, unknown>) => unknown;
  } = {},
): { publish(): void; close(): void } {
  let snapshot = options.snapshot ?? sessionSnapshot();
  const subscribers = new Set<() => void>();
  const listener = listenClientProtocol<SessionClientSnapshot>({
    socketPath,
    protocol: SESSION_CLIENT_PROTOCOL,
    version: CLIENT_PROTOCOL_VERSION,
    snapshot: () => snapshot,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    handleRequest: (_owner, method, params) => {
      if (method === "approval.setMode") {
        snapshot = {
          ...snapshot,
          session: {
            ...snapshot.session,
            approvalPolicy: {
              mode: params.mode === "auto" ? "auto" : "normal",
              updatedAt: new Date().toISOString(),
            },
          },
        };
        for (const subscriber of subscribers) subscriber();
      }
      return options.handleRequest?.(method, params) ?? { ok: true };
    },
  });
  return {
    publish: () => {
      for (const subscriber of subscribers) subscriber();
    },
    close: () => listener.close(),
  };
}

function supervisorSnapshot(): SupervisorClientSnapshot {
  return {
    supervisor: {
      resumeSessionId: null,
      clientLeaseCount: 0,
      autoCloseEnabled: false,
    },
    sessions: [],
    scopes: [],
  };
}

describe("SessionClient typed protocol", () => {
  test("connects without optional plugin state", async () => {
    const socketPath = `/tmp/slop/tui-typed-minimal-${crypto.randomUUID()}.sock`;
    listeners.push(listenMockSession(socketPath));
    const client = new SessionClient(socketPath, { reconnect: false });
    try {
      const snapshot = await client.connect();
      expect(snapshot.connection.status).toBe("connected");
      expect(snapshot.session.sessionId).toBe("sess-typed");
      expect(snapshot.goal.exists).toBe(false);
      expect(snapshot.plugins).toEqual([]);
    } finally {
      client.disconnect();
    }
  });

  test("receives client-agnostic plugin contributions with server-computed availability", async () => {
    const socketPath = `/tmp/slop/tui-typed-plugin-${crypto.randomUUID()}.sock`;
    listeners.push(
      listenMockSession(socketPath, {
        snapshot: sessionSnapshot({
          plugins: [
            {
              id: "custom-plugin",
              version: "1.0.0",
              status: "active",
              providerIds: [],
              extensionNamespaces: [],
              contributions: {
                actions: [
                  {
                    id: "custom:run",
                    label: "Run Custom",
                    description: "Run a custom command",
                    command: "run",
                    available: true,
                  },
                ],
                indicators: [],
                notifications: [],
              },
            },
          ],
        }),
      }),
    );
    const client = new SessionClient(socketPath, { reconnect: false });
    try {
      const snapshot = await client.connect();
      expect(snapshot.plugins[0]?.ui.actions[0]).toMatchObject({
        command: "run",
        available: true,
      });
    } finally {
      client.disconnect();
    }
  });

  test("uses typed commands for messages, approval mode, and plugin actions", async () => {
    const socketPath = `/tmp/slop/tui-typed-commands-${crypto.randomUUID()}.sock`;
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    listeners.push(
      listenMockSession(socketPath, {
        handleRequest: (method, params) => {
          calls.push({ method, params });
          return { method };
        },
      }),
    );
    const client = new SessionClient(socketPath, { reconnect: false });
    try {
      await client.connect();
      await client.sendMessage("hello from tui");
      await client.setApprovalMode("auto");
      await client.invokePlugin("custom-plugin", "run", { target: "prod" });
      await waitFor(() => (client.getSnapshot().approvalMode === "auto" ? true : null));
      expect(calls).toEqual([
        { method: "session.sendMessage", params: { text: "hello from tui" } },
        { method: "approval.setMode", params: { mode: "auto" } },
        {
          method: "plugin.invoke",
          params: { pluginId: "custom-plugin", command: "run", params: { target: "prod" } },
        },
      ]);
    } finally {
      client.disconnect();
    }
  });
});

describe("typed client resilience", () => {
  test("rejects when a server accepts but never sends hello", async () => {
    const socketPath = `/tmp/slop/tui-typed-timeout-${crypto.randomUUID()}.sock`;
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
    const client = new SessionClient(socketPath, { connectTimeoutMs: 50, reconnect: false });
    try {
      await expect(client.connect()).rejects.toThrow(/Timed out waiting/);
      expect(client.getSnapshot().connection.status).toBe("error");
    } finally {
      client.disconnect();
      silent.close();
      rmSync(socketPath, { force: true });
    }
  });

  test("isolates throwing listeners", async () => {
    const socketPath = `/tmp/slop/tui-typed-listener-${crypto.randomUUID()}.sock`;
    listeners.push(listenMockSession(socketPath));
    const client = new SessionClient(socketPath, { reconnect: false });
    const seen: string[] = [];
    try {
      client.on(() => {
        throw new Error("listener boom");
      });
      client.on((event) => seen.push(event.type));
      await client.connect();
      expect(seen).toContain("snapshot");
      expect(client.getSnapshot().connection.status).toBe("connected");
    } finally {
      client.disconnect();
    }
  });

  test("reconnects after the typed session endpoint returns", async () => {
    const socketPath = `/tmp/slop/tui-typed-reconnect-${crypto.randomUUID()}.sock`;
    let listener = listenMockSession(socketPath);
    const client = new SessionClient(socketPath, {
      connectTimeoutMs: 200,
      reconnect: { initialDelayMs: 10, maxDelayMs: 50, maxAttempts: 20 },
    });
    try {
      await client.connect();
      listener.close();
      await waitFor(() =>
        client.getSnapshot().connection.status === "reconnecting" ? true : null,
      );
      listener = listenMockSession(socketPath);
      await waitFor(
        () => (client.getSnapshot().connection.status === "connected" ? true : null),
        5_000,
      );
      expect(client.getSnapshot().session.sessionId).toBe("sess-typed");
    } finally {
      client.disconnect();
      listener.close();
    }
  });

  test("supervisor wrapper uses the typed lease command and configured label", async () => {
    const socketPath = `/tmp/slop/tui-typed-supervisor-${crypto.randomUUID()}.sock`;
    const labels: unknown[] = [];
    listeners.push(
      listenClientProtocol<SupervisorClientSnapshot>({
        socketPath,
        protocol: SUPERVISOR_CLIENT_PROTOCOL,
        version: CLIENT_PROTOCOL_VERSION,
        snapshot: supervisorSnapshot,
        subscribe: () => () => {},
        handleRequest: (_owner, method, params) => {
          if (method === "lease.register") labels.push(params.label);
          return { ok: true };
        },
      }),
    );
    const client = new SessionSupervisorClient(socketPath, {
      leaseLabel: "tui-test",
      reconnect: false,
    });
    try {
      await client.connect();
      await client.registerClientLease();
      expect(labels).toEqual(["tui-test"]);
    } finally {
      client.disconnect();
    }
  });
});

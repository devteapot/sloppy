import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";
import {
  applySnapshotPatch,
  createSnapshotPatch,
  InProcessSessionApi,
  RpcSnapshotClient,
  SessionApiClient,
} from "../src/session/client-protocol";
import { listenClientProtocol } from "../src/session/client-protocol/rpc-server";
import {
  CLIENT_PROTOCOL_VERSION,
  SESSION_CLIENT_PROTOCOL,
  type SessionClientSnapshot,
  SUPERVISOR_CLIENT_PROTOCOL,
  type SupervisorClientSnapshot,
} from "../src/session/client-protocol/types";
import type { SessionRuntime } from "../src/session/runtime";
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
  test("streams growing snapshot text as a compact append patch", () => {
    const previous = { transcript: [{ text: "a".repeat(10_000) }] };
    const next = { transcript: [{ text: `${"a".repeat(10_000)}tail` }] };
    const operations = createSnapshotPatch(previous, next);
    expect(operations).toEqual([{ op: "append", path: ["transcript", 0, "text"], value: "tail" }]);
    expect(applySnapshotPatch(previous, operations)).toEqual(next);
    expect(JSON.stringify(operations).length).toBeLessThan(JSON.stringify(next).length / 10);
  });

  test("coalesces rapid snapshot publications to their latest state", async () => {
    const socketPath = `/tmp/slop/tui-typed-coalesce-${crypto.randomUUID()}.sock`;
    const subscribers = new Set<() => void>();
    let snapshot = { text: "" };
    listeners.push(
      listenClientProtocol({
        socketPath,
        protocol: "sloppy.test-client",
        version: CLIENT_PROTOCOL_VERSION,
        snapshot: () => snapshot,
        subscribe: (subscriber) => {
          subscribers.add(subscriber);
          return () => subscribers.delete(subscriber);
        },
        handleRequest: () => ({ ok: true }),
      }),
    );
    await waitFor(() => (existsSync(socketPath) ? true : null));
    const client = new RpcSnapshotClient<{ text: string }>(socketPath, "sloppy.test-client");
    const seen: string[] = [];
    client.onSnapshot((next) => seen.push(next.text));
    try {
      await client.connect();
      await Bun.sleep(30);
      seen.length = 0;
      for (let index = 0; index < 100; index += 1) {
        snapshot = { text: `${snapshot.text}x` };
        for (const subscriber of subscribers) subscriber();
      }
      await waitFor(() => (client.getSnapshot()?.text.length === 100 ? true : null));
      expect(seen.length).toBeLessThanOrEqual(2);
      expect(client.getSnapshot()?.text).toBe("x".repeat(100));
    } finally {
      client.disconnect();
    }
  });

  test("does not report a committed command as failed when snapshot publication fails", async () => {
    const socketPath = `/tmp/slop/tui-typed-projection-failure-${crypto.randomUUID()}.sock`;
    let count = 0;
    let projectionFails = false;
    listeners.push(
      listenClientProtocol({
        socketPath,
        protocol: "sloppy.test-client",
        version: CLIENT_PROTOCOL_VERSION,
        snapshot: () => {
          if (projectionFails) throw new Error("projection boom");
          return { count };
        },
        subscribe: () => () => {},
        handleRequest: () => {
          count += 1;
          projectionFails = true;
          return { count };
        },
      }),
    );
    await waitFor(() => (existsSync(socketPath) ? true : null));
    const client = new RpcSnapshotClient<{ count: number }>(socketPath, "sloppy.test-client");
    try {
      await client.connect();
      await expect(client.request("increment")).resolves.toEqual({ count: 1 });
      expect(count).toBe(1);
    } finally {
      projectionFails = false;
      client.disconnect();
    }
  });

  test("serializes concurrent in-process connects and cancels a pending connect", async () => {
    let releaseStart: (() => void) | undefined;
    let startCalls = 0;
    let registrations = 0;
    let unregistrations = 0;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime = {
      start: () => {
        startCalls += 1;
        return startGate;
      },
      getClientSnapshot: () => sessionSnapshot(),
      store: {
        registerClient: () => {
          registrations += 1;
        },
        unregisterClient: () => {
          unregistrations += 1;
        },
        onChange: () => () => {},
      },
    } as unknown as SessionRuntime;
    const api = new InProcessSessionApi(runtime);
    const first = api.connect();
    const second = api.connect();
    expect(startCalls).toBe(1);
    releaseStart?.();
    await expect(first).resolves.toEqual(await second);
    expect(registrations).toBe(1);
    api.disconnect();
    expect(unregistrations).toBe(1);

    let releaseCancelledStart: (() => void) | undefined;
    const cancelledGate = new Promise<void>((resolve) => {
      releaseCancelledStart = resolve;
    });
    const cancelledRuntime = {
      ...runtime,
      start: () => cancelledGate,
    } as unknown as SessionRuntime;
    const cancelledApi = new InProcessSessionApi(cancelledRuntime);
    const cancelled = cancelledApi.connect();
    const cancelledResult = cancelled.then(
      () => null,
      (error: unknown) => error,
    );
    cancelledApi.disconnect();
    releaseCancelledStart?.();
    expect(await cancelledResult).toBeInstanceOf(Error);
    expect(registrations).toBe(1);

    const failingRuntime = {
      ...runtime,
      start: () => Promise.resolve(),
      getClientSnapshot: () => {
        throw new Error("snapshot projection failed");
      },
    } as unknown as SessionRuntime;
    const failingApi = new InProcessSessionApi(failingRuntime);
    await expect(failingApi.connect()).rejects.toThrow("snapshot projection failed");
    expect(registrations).toBe(2);
    expect(unregistrations).toBe(2);
  });

  test("allows the same SDK client to retry after its first dial fails", async () => {
    const socketPath = `/tmp/slop/tui-typed-retry-${crypto.randomUUID()}.sock`;
    const client = new SessionApiClient(socketPath);
    try {
      await expect(client.connect(50)).rejects.toThrow();
      listeners.push(listenMockSession(socketPath));
      await waitFor(() => (existsSync(socketPath) ? true : null));
      const snapshot = await client.connect(500);
      expect(snapshot.session.session.sessionId).toBe("sess-typed");
    } finally {
      client.disconnect();
    }
  });

  test("does not register a client that disconnects before hello is ready", async () => {
    const socketPath = `/tmp/slop/tui-typed-late-hello-${crypto.randomUUID()}.sock`;
    let resolveSnapshot: ((snapshot: SessionClientSnapshot) => void) | undefined;
    const connected: object[] = [];
    const disconnected: object[] = [];
    listeners.push(
      listenClientProtocol<SessionClientSnapshot>({
        socketPath,
        protocol: SESSION_CLIENT_PROTOCOL,
        version: CLIENT_PROTOCOL_VERSION,
        snapshot: () =>
          new Promise<SessionClientSnapshot>((resolve) => {
            resolveSnapshot = resolve;
          }),
        subscribe: () => () => {},
        handleRequest: () => ({ ok: true }),
        onConnect: (owner) => connected.push(owner),
        onDisconnect: (owner) => disconnected.push(owner),
      }),
    );
    await waitFor(() => (existsSync(socketPath) ? true : null));
    const client = new SessionApiClient(socketPath);
    const connecting = client.connect(500);
    const connectionError = connecting.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => (resolveSnapshot ? true : null));
    client.disconnect();
    await Bun.sleep(20);
    resolveSnapshot?.(sessionSnapshot());
    const error = await connectionError;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/disconnected/);
    await Bun.sleep(20);
    expect(connected).toEqual([]);
    expect(disconnected).toEqual([]);
  });

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

  test("times out a WebSocket that never completes its upgrade", async () => {
    const stalled = createServer(() => {});
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test address.");
    const client = new RpcSnapshotClient<SessionClientSnapshot>(
      `ws://127.0.0.1:${address.port}/api/session`,
      SESSION_CLIENT_PROTOCOL,
    );
    const startedAt = Date.now();
    try {
      await expect(client.connect(50)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      client.disconnect();
      stalled.close();
    }
  });

  test("rejects a malformed hello without publishing an undefined snapshot", async () => {
    const socketPath = `/tmp/slop/tui-typed-malformed-hello-${crypto.randomUUID()}.sock`;
    const malformed = createServer((socket) => {
      socket.write(
        `${JSON.stringify({ type: "hello", protocol: SESSION_CLIENT_PROTOCOL, version: 1 })}\n`,
      );
    });
    await new Promise<void>((resolve) => malformed.listen(socketPath, resolve));
    const client = new SessionApiClient(socketPath);
    try {
      await expect(client.connect(200)).rejects.toThrow(/Invalid .* hello/);
      expect(client.getSnapshot()).toBeNull();
    } finally {
      client.disconnect();
      malformed.close();
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

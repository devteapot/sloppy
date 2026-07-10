import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServer } from "node:net";

import { action, createSlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";

const listeners: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    listener.close();
  }
});

async function waitFor<T>(check: () => T | null, timeoutMs = 1000, intervalMs = 10): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = check();
    if (result !== null) {
      return result;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error("Timed out waiting for condition.");
}

function registerMinimalSessionNodes(
  server: ReturnType<typeof createSlopServer>,
  options: { includeGoal?: boolean } = {},
): void {
  server.register("session", { type: "context", props: { session_id: "sess-minimal" } });
  server.register("llm", { type: "collection", props: { status: "ready" }, items: [] });
  server.register("usage", { type: "context", props: {} });
  server.register("turn", { type: "status", props: { state: "idle" } });
  if (options.includeGoal) {
    server.register("goal", { type: "control", props: { exists: false, status: "none" } });
  }
  server.register("composer", { type: "control", props: { ready: true } });
  server.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
  server.register("activity", { type: "collection", props: { count: 0 }, items: [] });
  server.register("approvals", {
    type: "collection",
    props: { count: 0, approval_mode: "normal" },
    items: [],
  });
  server.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
  server.register("apps", { type: "collection", props: { count: 0 }, items: [] });
  server.register("queue", { type: "collection", props: { count: 0 }, items: [] });
}

describe("SessionClient", () => {
  test("connects when plugin-owned goal path is absent", async () => {
    const socketPath = `/tmp/slop/tui-no-goal-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server);
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();

      expect(snapshot.connection.status).toBe("connected");
      expect(snapshot.goal.exists).toBe(false);
      expect(snapshot.plugins).toEqual([]);
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("subscribes to active plugin manifest paths for action gating", async () => {
    const socketPath = `/tmp/slop/tui-plugin-subscriptions-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server);
    server.register("plugins", {
      type: "collection",
      props: { count: 1, ui_manifest_version: 2 },
      items: [
        {
          id: "custom-plugin",
          props: {
            id: "custom-plugin",
            version: "1.0.0",
            status: "active",
            ui: {
              subscriptions: [{ path: "/custom", depth: 1 }],
              actions: [
                {
                  id: "custom:run",
                  label: "Run Custom Action",
                  description: "Invoke a plugin-owned custom affordance",
                  invoke: { path: "/custom", action: "do_it" },
                  whenAvailable: "do_it",
                },
              ],
            },
          },
        },
      ],
    });
    server.register("custom", {
      type: "control",
      props: { ready: true },
      actions: {
        do_it: action({}, async () => ({ ok: true }), { label: "Do It" }),
      },
    });
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();

      expect(snapshot.actionsByPath["/custom"]).toEqual(["do_it"]);
      expect(snapshot.plugins[0]?.ui.actions?.[0]).toMatchObject({
        id: "custom:run",
        invoke: { path: "/custom", action: "do_it" },
      });
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("subscribes to the public session provider shape and invokes composer affordances", async () => {
    const socketPath = `/tmp/slop/tui-client-test-${crypto.randomUUID()}.sock`;
    const sentMessages: string[] = [];
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server, { includeGoal: true });
    server.register("composer", {
      type: "control",
      props: { ready: true, accepts_attachments: false, max_attachments: 0 },
      actions: {
        send_message: action(
          { text: "string" },
          async ({ text }) => {
            sentMessages.push(text);
            return { turnId: "turn-1" };
          },
          { label: "Send Message" },
        ),
      },
    });

    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();
      expect(snapshot.connection.status).toBe("connected");
      expect(snapshot.composer.canSend).toBe(true);

      const result = await client.sendMessage("hello from tui");
      expect(result.status).toBe("ok");
      expect(sentMessages).toEqual(["hello from tui"]);
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("updates approval mode from the connected provider snapshot", async () => {
    const socketPath = `/tmp/slop/tui-approval-mode-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });
    let approvalMode = "normal";

    registerMinimalSessionNodes(server, { includeGoal: true });
    server.register("approvals", () => ({
      type: "collection",
      props: { count: 0, approval_mode: approvalMode },
      actions: {
        set_mode: action(
          { mode: "string" },
          async ({ mode }) => {
            approvalMode = mode === "auto" ? "auto" : "normal";
            server.refresh();
            return { mode: approvalMode };
          },
          { label: "Set Approval Mode" },
        ),
      },
      items: [],
    }));
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();
      expect(snapshot.approvalMode).toBe("normal");

      const result = await client.setApprovalMode("auto");
      expect(result.status).toBe("ok");

      await waitFor(() => (client.getSnapshot().approvalMode === "auto" ? true : null));
      expect(client.getSnapshot().approvalMode).toBe("auto");
    } finally {
      client.disconnect();
      server.stop();
    }
  });
});

describe("client resilience", () => {
  function registerSupervisorNodes(
    server: ReturnType<typeof createSlopServer>,
    onLease?: (label: string) => void,
  ): void {
    server.register("session", {
      type: "control",
      props: { auto_close_enabled: false, client_lease_count: 0 },
      actions: {
        register_client_lease: action(
          { label: "string" },
          async ({ label }) => {
            onLease?.(label);
            return { ok: true };
          },
          { label: "Register Lease" },
        ),
      },
    });
    server.register("sessions", { type: "collection", props: {}, items: [] });
    server.register("scopes", { type: "collection", props: {}, items: [] });
  }

  test("session connect rejects when the server accepts but never sends hello", async () => {
    const socketPath = `/tmp/slop/tui-timeout-test-${crypto.randomUUID()}.sock`;
    const silent = createServer(() => {
      // Accept the connection, say nothing: the SDK handshake never settles.
    });
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));

    const client = new SessionClient(socketPath, { connectTimeoutMs: 100, reconnect: false });
    try {
      await expect(client.connect()).rejects.toThrow(/Timed out connecting/);
      expect(client.getSnapshot().connection.status).toBe("error");
    } finally {
      client.disconnect();
      silent.close();
    }
  });

  test("supervisor connect rejects when the server accepts but never sends hello", async () => {
    const socketPath = `/tmp/slop/tui-supervisor-timeout-test-${crypto.randomUUID()}.sock`;
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));

    const client = new SessionSupervisorClient(socketPath, {
      connectTimeoutMs: 100,
      reconnect: false,
    });
    try {
      await expect(client.connect()).rejects.toThrow(/Timed out connecting/);
      expect(client.getSnapshot().connection.status).toBe("error");
    } finally {
      client.disconnect();
      silent.close();
    }
  });

  test("a throwing listener does not break event fan-out", async () => {
    const socketPath = `/tmp/slop/tui-listener-isolation-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });
    registerMinimalSessionNodes(server);
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath, { reconnect: false });
    const seen: string[] = [];
    try {
      client.on(() => {
        throw new Error("listener boom");
      });
      client.on((event) => {
        seen.push(event.type);
      });
      await client.connect();
      expect(seen).toContain("snapshot");
      expect(client.getSnapshot().connection.status).toBe("connected");
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("session client reconnects with backoff after the server drops and returns", async () => {
    const socketPath = `/tmp/slop/tui-reconnect-test-${crypto.randomUUID()}.sock`;
    let server = createSlopServer({ id: "mock-session", name: "Mock Session" });
    registerMinimalSessionNodes(server);
    let listener = listenUnix(server, socketPath, { register: false });

    const client = new SessionClient(socketPath, {
      connectTimeoutMs: 1000,
      reconnect: { initialDelayMs: 20, maxDelayMs: 100, maxAttempts: 20 },
    });
    try {
      await client.connect();
      expect(client.getSnapshot().connection.status).toBe("connected");

      listener.close();
      server.stop();
      await waitFor(() =>
        client.getSnapshot().connection.status === "reconnecting" ? true : null,
      );

      rmSync(socketPath, { force: true });
      server = createSlopServer({ id: "mock-session", name: "Mock Session" });
      registerMinimalSessionNodes(server);
      listener = listenUnix(server, socketPath, { register: false });

      await waitFor(
        () => (client.getSnapshot().connection.status === "connected" ? true : null),
        5000,
      );
      // Re-subscription proof: session state is repopulated from the new server.
      expect(client.getSnapshot().session.sessionId).toBe("sess-minimal");
      expect(client.getSnapshot().connection.reconnectAttempt).toBeUndefined();
    } finally {
      client.disconnect();
      listener.close();
      server.stop();
    }
  });

  test("user-initiated disconnect never triggers reconnect", async () => {
    const socketPath = `/tmp/slop/tui-no-reconnect-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });
    registerMinimalSessionNodes(server);
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath, {
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 5 },
    });
    const statuses: string[] = [];
    try {
      client.on((event) => {
        if (event.type === "snapshot") {
          statuses.push(event.snapshot.connection.status);
        }
      });
      await client.connect();
      client.disconnect();
      await Bun.sleep(100);
      expect(client.getSnapshot().connection.status).toBe("disconnected");
      expect(statuses).not.toContain("reconnecting");
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("gives up after bounded attempts when the endpoint stays dead", async () => {
    const socketPath = `/tmp/slop/tui-give-up-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });
    registerMinimalSessionNodes(server);
    const listener = listenUnix(server, socketPath, { register: false });

    const client = new SessionClient(socketPath, {
      connectTimeoutMs: 200,
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
    });
    const errors: string[] = [];
    try {
      client.on((event) => {
        if (event.type === "error") {
          errors.push(event.message);
        }
      });
      await client.connect();
      listener.close();
      server.stop();
      rmSync(socketPath, { force: true });

      await waitFor(
        () => (errors.some((message) => message.includes("gave up")) ? true : null),
        5000,
      );
      expect(client.getSnapshot().connection.status).toBe("disconnected");
    } finally {
      client.disconnect();
    }
  });

  test("supervisor client reconnects and registers leases with a custom label", async () => {
    const socketPath = `/tmp/slop/tui-supervisor-reconnect-test-${crypto.randomUUID()}.sock`;
    const leaseLabels: string[] = [];
    let server = createSlopServer({ id: "mock-supervisor", name: "Mock Supervisor" });
    registerSupervisorNodes(server, (label) => leaseLabels.push(label));
    let listener = listenUnix(server, socketPath, { register: false });

    const client = new SessionSupervisorClient(socketPath, {
      leaseLabel: "tui-test",
      connectTimeoutMs: 1000,
      reconnect: { initialDelayMs: 20, maxDelayMs: 100, maxAttempts: 20 },
    });
    try {
      await client.connect();
      await client.registerClientLease();
      expect(leaseLabels).toEqual(["tui-test"]);

      listener.close();
      server.stop();
      await waitFor(() =>
        client.getSnapshot().connection.status === "reconnecting" ? true : null,
      );

      rmSync(socketPath, { force: true });
      server = createSlopServer({ id: "mock-supervisor", name: "Mock Supervisor" });
      registerSupervisorNodes(server, (label) => leaseLabels.push(label));
      listener = listenUnix(server, socketPath, { register: false });

      await waitFor(
        () => (client.getSnapshot().connection.status === "connected" ? true : null),
        5000,
      );
    } finally {
      client.disconnect();
      listener.close();
      server.stop();
    }
  });
});

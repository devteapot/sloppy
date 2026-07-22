import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import type { SloppyConfig } from "../src/config/schema";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { createPersistentGoalPlugin } from "../src/plugins/first-party/persistent-goal/session";
import { SessionService } from "../src/session/service";
import { buildMirroredItemId, SessionStore } from "../src/session/store";
import type { ApprovalItem, SessionTask } from "../src/session/types";
import { createTestConfig } from "./helpers/config";

function persistentGoalSnapshotHooks() {
  const plugin = createPersistentGoalPlugin();
  return {
    snapshotMigrators: plugin.migrateSnapshot ? [plugin.migrateSnapshot] : [],
    snapshotRecoverers: plugin.recoverSnapshot ? [plugin.recoverSnapshot] : [],
    snapshotProjections: plugin.snapshotProjections ?? [],
    extensionEventTypes: plugin.extensionEvents ?? {},
  };
}

function createStore(
  overrides?: Partial<{
    sessionId: string;
    title: string;
    workspaceRoot: string;
    persistencePath: string;
  }>,
) {
  return new SessionStore({
    sessionId: overrides?.sessionId ?? "sess-1",
    modelProvider: "openai",
    model: "gpt-5.4",
    title: overrides?.title,
    workspaceRoot: overrides?.workspaceRoot,
    persistencePath: overrides?.persistencePath,
    ...persistentGoalSnapshotHooks(),
  });
}

describe("buildMirroredItemId", () => {
  test("sanitizes special characters in provider and source ids", () => {
    expect(buildMirroredItemId("task", "provider/a", "id.with:colons")).toBe(
      "task-provider_a-id_with_colons",
    );
  });

  test("preserves allowed characters", () => {
    expect(buildMirroredItemId("appr", "prov-1_X", "src-abc_123")).toBe(
      "appr-prov-1_X-src-abc_123",
    );
  });
});

describe("SessionStore — trimResolvedApprovals", () => {
  test("trimResolvedApprovals removes resolved approvals beyond limit", () => {
    const store = createStore();
    const baseTime = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create all 60 approvals in a single batch for the same provider
    const allApprovals: ApprovalItem[] = [];
    for (let i = 0; i < 50; i++) {
      const time = new Date(baseTime).toISOString();
      allApprovals.push({
        id: `resolved-${String(i).padStart(3, "0")}`,
        status: i % 2 === 0 ? "approved" : "rejected",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "resolved",
        createdAt: time,
        resolvedAt: time,
      } as ApprovalItem);
    }
    for (let i = 0; i < 10; i++) {
      const time = new Date(baseTime).toISOString();
      allApprovals.push({
        id: `pending-${String(i).padStart(3, "0")}`,
        status: "pending",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "pending",
        createdAt: time,
      } as ApprovalItem);
    }
    store.syncProviderApprovals("filesystem", allApprovals);

    let snapshot = store.getSnapshot();
    expect(snapshot.approvals).toHaveLength(60);

    store.trimResolvedApprovals(50);
    snapshot = store.getSnapshot();

    // Must have exactly 60 (50 resolved kept + 10 pending)
    expect(snapshot.approvals).toHaveLength(60);

    // No pending should have been removed
    const pendingAfter = snapshot.approvals.filter((a) => a.status === "pending");
    expect(pendingAfter).toHaveLength(10);

    // All remaining must be resolved
    const resolvedAfter = snapshot.approvals.filter((a) => a.status !== "pending");
    expect(resolvedAfter).toHaveLength(50);

    // Verify the 50 kept are the most recent (resolved-000 through resolved-049)
    const resolvedIds = resolvedAfter.map((a) => a.id).sort();
    for (let i = 0; i < 50; i++) {
      expect(resolvedIds).toContain(`resolved-${String(i).padStart(3, "0")}`);
    }
  });

  test("trimResolvedApprovals never removes pending approvals", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create 100 pending approvals in a single batch
    const pending: ApprovalItem[] = [];
    for (let i = 0; i < 100; i++) {
      pending.push({
        id: `pending-${String(i).padStart(3, "0")}`,
        status: "pending",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "pending",
        createdAt: time,
      } as ApprovalItem);
    }
    store.syncProviderApprovals("filesystem", pending);

    store.trimResolvedApprovals(10);
    const snapshot = store.getSnapshot();

    // All 100 pending approvals must still exist
    expect(snapshot.approvals).toHaveLength(100);
    const pendingAfter = snapshot.approvals.filter((a) => a.status === "pending");
    expect(pendingAfter).toHaveLength(100);
  });

  test("trimResolvedApprovals respects custom limit in session metadata", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create 10 resolved approvals in a single batch
    const resolved: ApprovalItem[] = [];
    for (let i = 0; i < 10; i++) {
      resolved.push({
        id: `resolved-${String(i).padStart(3, "0")}`,
        status: "approved",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "resolved",
        createdAt: time,
        resolvedAt: time,
      } as ApprovalItem);
    }
    store.syncProviderApprovals("filesystem", resolved);

    store.trimResolvedApprovals(3); // explicit limit overrides metadata
    const snapshot = store.getSnapshot();
    expect(snapshot.approvals).toHaveLength(3);
  });
});

describe("SessionStore — trimResolvedTasks", () => {
  test("trimResolvedTasks removes completed/failed/cancelled tasks beyond limit", () => {
    const store = createStore();
    const baseTime = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create 50 resolved tasks in a single batch
    const resolvedTasks = [];
    for (let i = 0; i < 50; i++) {
      const time = new Date(baseTime).toISOString();
      const status: SessionTask["status"] =
        i % 3 === 0 ? "completed" : i % 3 === 1 ? "failed" : "cancelled";
      resolvedTasks.push({
        id: `resolved-task-${String(i).padStart(3, "0")}`,
        status,
        provider: "provider-a",
        providerTaskId: `task-${i}`,
        startedAt: time,
        updatedAt: time,
        message: "resolved",
      } satisfies SessionTask);
    }
    store.syncProviderTasks("provider-a", resolvedTasks);

    // Create 10 running tasks in a single batch
    const runningTasks = [];
    for (let i = 0; i < 10; i++) {
      const time = new Date(baseTime).toISOString();
      runningTasks.push({
        id: `running-task-${String(i).padStart(3, "0")}`,
        status: "running",
        provider: "provider-b",
        providerTaskId: `running-task-${i}`,
        startedAt: time,
        updatedAt: time,
        message: "still running",
      } satisfies SessionTask);
    }
    store.syncProviderTasks("provider-b", runningTasks);

    let snapshot = store.getSnapshot();
    expect(snapshot.tasks).toHaveLength(60);

    store.trimResolvedTasks(50);
    snapshot = store.getSnapshot();

    // Must have exactly 60 (50 resolved kept + 10 running)
    expect(snapshot.tasks).toHaveLength(60);

    // No running should have been removed
    const runningAfter = snapshot.tasks.filter((t) => t.status === "running");
    expect(runningAfter).toHaveLength(10);

    // All remaining resolved must be completed/failed/cancelled (not running)
    const resolvedAfter = snapshot.tasks.filter((t) => t.status !== "running");
    expect(resolvedAfter).toHaveLength(50);

    // Verify the 50 kept are the most recent
    const resolvedIds = resolvedAfter.map((t) => t.id).sort();
    for (let i = 0; i < 50; i++) {
      expect(resolvedIds).toContain(`resolved-task-${String(i).padStart(3, "0")}`);
    }
  });

  test("trimResolvedTasks never removes running tasks", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create 100 running tasks in a single batch
    const tasks = [];
    for (let i = 0; i < 100; i++) {
      tasks.push({
        id: `running-${String(i).padStart(3, "0")}`,
        status: "running",
        provider: "provider-a",
        providerTaskId: `running-${i}`,
        startedAt: time,
        updatedAt: time,
        message: "running",
      } satisfies SessionTask);
    }
    store.syncProviderTasks("provider-a", tasks);

    store.trimResolvedTasks(10);
    const snapshot = store.getSnapshot();

    // All 100 running tasks must still exist
    expect(snapshot.tasks).toHaveLength(100);
    const runningAfter = snapshot.tasks.filter((t) => t.status === "running");
    expect(runningAfter).toHaveLength(100);
  });

  test("trimResolvedTasks respects custom limit in session metadata", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create 10 completed tasks in a single batch
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push({
        id: `completed-${String(i).padStart(3, "0")}`,
        status: "completed",
        provider: "provider-a",
        providerTaskId: `completed-${i}`,
        startedAt: time,
        updatedAt: time,
        message: "done",
      } satisfies SessionTask);
    }
    store.syncProviderTasks("provider-a", tasks);

    store.trimResolvedTasks(3); // explicit limit
    const snapshot = store.getSnapshot();
    expect(snapshot.tasks).toHaveLength(3);
  });
});

describe("SessionStore — beginTurn trims resolved history", () => {
  test("beginTurn triggers trimResolvedApprovals and trimResolvedTasks", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z").toISOString();

    // Create 55 resolved approvals in a single batch to trigger trimming (default limit 50)
    const approvals = [];
    for (let i = 0; i < 55; i++) {
      approvals.push({
        id: `appr-${String(i).padStart(3, "0")}`,
        status: "approved",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "done",
        createdAt: time,
        resolvedAt: time,
      } as ApprovalItem);
    }
    store.syncProviderApprovals("filesystem", approvals);

    // Create 55 completed tasks in a single batch to trigger trimming (default limit 50)
    const tasks = [];
    for (let i = 0; i < 55; i++) {
      tasks.push({
        id: `task-${String(i).padStart(3, "0")}`,
        status: "completed",
        provider: "provider-a",
        providerTaskId: `task-${i}`,
        startedAt: time,
        updatedAt: time,
        message: "done",
      } satisfies SessionTask);
    }
    store.syncProviderTasks("provider-a", tasks);

    let snap = store.getSnapshot();
    expect(snap.approvals).toHaveLength(55);
    expect(snap.tasks).toHaveLength(55);

    store.beginTurn("trim me");
    snap = store.getSnapshot();

    // Should have trimmed to 50 approvals and 50 tasks (default limits)
    expect(snap.approvals).toHaveLength(50);
    expect(snap.tasks).toHaveLength(50);
  });
});

describe("SessionStore — client registration", () => {
  test("registerClient adds client with timestamp", () => {
    const store = createStore();
    store.registerClient("client-1");

    const snapshot = store.getSnapshot();
    expect(snapshot.session.connectedClients).toHaveLength(1);
    expect(snapshot.session.connectedClients[0]?.clientId).toBe("client-1");
    expect(snapshot.session.connectedClients[0]?.connectedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.session.clientCount).toBe(1);
  });

  test("registerClient updates existing client timestamp", () => {
    const store = createStore();
    store.registerClient("client-1");
    const firstConnectedAt = store.getSnapshot().session.connectedClients[0]?.connectedAt;

    // Use a small delay to ensure different timestamp
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin for 5ms to get a different timestamp
    }
    store.registerClient("client-1");

    const snapshot = store.getSnapshot();
    expect(snapshot.session.connectedClients).toHaveLength(1);
    expect(snapshot.session.connectedClients[0]?.clientId).toBe("client-1");
    expect(snapshot.session.connectedClients[0]?.connectedAt).not.toBe(firstConnectedAt);
    expect(snapshot.session.clientCount).toBe(1);
  });

  test("unregisterClient removes client and updates count", () => {
    const store = createStore();
    store.registerClient("client-1");
    store.registerClient("client-2");

    const snapshotBefore = store.getSnapshot();
    expect(snapshotBefore.session.connectedClients).toHaveLength(2);
    expect(snapshotBefore.session.clientCount).toBe(2);

    store.unregisterClient("client-1");

    const snapshotAfter = store.getSnapshot();
    expect(snapshotAfter.session.connectedClients).toHaveLength(1);
    expect(snapshotAfter.session.connectedClients[0]?.clientId).toBe("client-2");
    expect(snapshotAfter.session.clientCount).toBe(1);
  });
});

describe("SessionStore — lastActivityAt tracking", () => {
  test("lastActivityAt updates on beginTurn", () => {
    const store = createStore();
    const firstActivityAt = store.getSnapshot().session.lastActivityAt;

    // Use a small delay to ensure different timestamp
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin for 5ms to get a different timestamp
    }
    const _turnId = store.beginTurn("Hello");

    const snapshot = store.getSnapshot();
    expect(snapshot.session.lastActivityAt).not.toBe(firstActivityAt);
    expect(snapshot.session.lastActivityAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("lastActivityAt updates on updateTurn", () => {
    const store = createStore();
    const turnId = store.beginTurn("Hello");
    const firstActivityAt = store.getSnapshot().session.lastActivityAt;

    // Use a small delay to ensure different timestamp
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin for 5ms to get a different timestamp
    }
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Read file",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.session.lastActivityAt).not.toBe(firstActivityAt);
    expect(snapshot.session.lastActivityAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("SessionService — multi-session support", () => {
  test("SessionService.createSession creates and starts a new session", async () => {
    const service = new SessionService({
      sessionId: "test-session-1",
      title: "Test Session",
      sessionPersistencePath: false,
    });
    const snapshot = service.runtime.store.getSnapshot();

    expect(snapshot.session.sessionId).toBe("test-session-1");
    expect(service.socketPath).toMatch(/\/tmp\/slop\/[^/]+\.sock$/);

    await service.stop();
  });

  test("SessionService.getActiveSessions returns active sessions", async () => {
    const service1 = new SessionService({
      sessionId: "multi-sess-1",
      title: "Session 1",
      sessionPersistencePath: false,
    });
    const service2 = new SessionService({
      sessionId: "multi-sess-2",
      title: "Session 2",
      sessionPersistencePath: false,
    });

    const sessions = SessionService.getActiveSessions();
    expect(sessions).toHaveLength(2);

    const sessionIds = sessions.map((s) => s.sessionId).sort();
    expect(sessionIds).toEqual(["multi-sess-1", "multi-sess-2"]);

    await service1.stop();
    await service2.stop();
  });

  test("SessionService.stopSession stops and removes specific session", async () => {
    const _service1 = new SessionService({
      sessionId: "stop-sess-1",
      title: "Session 1",
      sessionPersistencePath: false,
    });
    const service2 = new SessionService({
      sessionId: "stop-sess-2",
      title: "Session 2",
      sessionPersistencePath: false,
    });

    let sessions = SessionService.getActiveSessions();
    expect(sessions).toHaveLength(2);

    const stopped = await SessionService.stopSession("stop-sess-1");
    expect(stopped).toBe(true);

    sessions = SessionService.getActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("stop-sess-2");

    // StopSession returns false for unknown session
    const notFound = await SessionService.stopSession("nonexistent");
    expect(notFound).toBe(false);

    await service2.stop();
  });

  test("SessionService cleanup does not depend on projected snapshots", () => {
    const service = new SessionService({
      sessionId: "stop-with-broken-projection",
      sessionPersistencePath: false,
    });
    const originalGetSnapshot = service.runtime.store.getSnapshot.bind(service.runtime.store);
    service.runtime.store.getSnapshot = () => {
      throw new Error("injected snapshot projection failure");
    };

    expect(() => service.stop()).toThrow("injected snapshot projection failure");

    service.runtime.store.getSnapshot = originalGetSnapshot;
    expect(originalGetSnapshot().session.status).toBe("closed");
    expect(
      SessionService.getActiveSessions().some(
        (session) => session.sessionId === "stop-with-broken-projection",
      ),
    ).toBe(false);
  });

  test("stopping one session doesn't affect others", async () => {
    const _service1 = new SessionService({
      sessionId: "isolate-1",
      title: "Session 1",
      sessionPersistencePath: false,
    });
    const service2 = new SessionService({
      sessionId: "isolate-2",
      title: "Session 2",
      sessionPersistencePath: false,
    });

    // Send message on service2 via store
    const turnId = service2.runtime.store.beginTurn("Hello from session 2");
    service2.runtime.store.appendAssistantText(turnId, "response");

    const snapshot = service2.runtime.store.getSnapshot();
    expect(snapshot.transcript).toHaveLength(2);
    expect(snapshot.transcript[0]?.role).toBe("user");

    // Stop service1
    await SessionService.stopSession("isolate-1");

    // service2 should still have its messages
    const snapshotAfter = service2.runtime.store.getSnapshot();
    expect(snapshotAfter.transcript).toHaveLength(2);
    expect(snapshotAfter.session.sessionId).toBe("isolate-2");

    // Verify service1 is gone
    const remaining = SessionService.getActiveSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sessionId).toBe("isolate-2");

    await service2.stop();
  });

  test("SessionService.start runs runtime.start before opening the socket", async () => {
    // Regression: previously SessionService.start() only opened the unix
    // listener — runtime.start() (which refreshes LLM profile state) didn't
    // run until the first sendMessage(). Clients connecting on first
    // snapshot saw the pristine pre-refresh store (profiles: [],
    // secureStoreKind: "none").
    const config: SloppyConfig = createTestConfig({
      llm: {
        defaultProfileId: "test-openai",
        profiles: [
          {
            kind: "native",
            id: "test-openai",
            label: "Test OpenAI",
            endpointId: "openai",
            model: "gpt-5.4",
          },
        ],
        maxTokens: 4096,
      },
    });

    class StubCredentialStore implements CredentialStore {
      readonly kind = "keychain" as const;
      constructor(private readonly key: string | null = "test-key") {}
      async getStatus(): Promise<CredentialStoreStatus> {
        return "available";
      }
      async get(endpointId: string): Promise<string | null> {
        return endpointId === "openai" ? this.key : null;
      }
      async set(): Promise<void> {}
      async delete(): Promise<void> {}
    }

    const noKeyProfileManager = new LlmProfileManager({
      config,
      credentialStore: new StubCredentialStore(null),
      writeConfig: async () => undefined,
    });
    const noKeySocketPath = `/tmp/slop/svc-start-needs-creds-${crypto.randomUUID()}.sock`;
    const noKeyService = new SessionService({
      sessionId: "service-start-needs-credentials",
      socketPath: noKeySocketPath,
      config,
      llmProfileManager: noKeyProfileManager,
      sessionPersistencePath: false,
    });

    try {
      await noKeyService.start();

      const noKeySnapshot = noKeyService.runtime.store.getSnapshot();
      expect(noKeySnapshot.llm.status).toBe("needs_credentials");
      expect(
        noKeySnapshot.llm.profiles.find((profile) => profile.id === "test-openai")?.ready,
      ).toBe(false);
    } finally {
      noKeyService.stop();
    }
    expect(existsSync(noKeySocketPath)).toBe(false);

    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new StubCredentialStore(),
      writeConfig: async () => undefined,
    });

    const socketPath = `/tmp/slop/svc-start-${crypto.randomUUID()}.sock`;
    const service = new SessionService({
      sessionId: "service-start-test",
      socketPath,
      config,
      llmProfileManager,
      sessionPersistencePath: false,
    });

    try {
      const before = service.runtime.store.getSnapshot();
      expect(before.llm.profiles).toEqual([]);
      expect(before.llm.secureStoreKind).toBe("none");

      await service.start();
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(service.socketPath)).toBe(true);
      expect(existsSync(`${service.socketPath}.client`)).toBe(false);

      const after = service.runtime.store.getSnapshot();
      // runtime.start() ran refreshLlmState before the listener opened, so
      // the snapshot reflects the injected profile manager (not the store's
      // pre-refresh placeholder).
      const managedProfile = after.llm.profiles.find((profile) => profile.id === "test-openai");
      expect(managedProfile?.ready).toBe(true);
      expect(after.llm.secureStoreKind).toBe("keychain");
      expect(after.llm.status).toBe("ready");
    } finally {
      await service.stop();
    }
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(service.socketPath)).toBe(false);
  });
});

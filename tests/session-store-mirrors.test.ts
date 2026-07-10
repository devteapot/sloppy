import { describe, expect, test } from "bun:test";
import { createPersistentGoalPlugin } from "../src/plugins/first-party/persistent-goal/session";
import { buildMirroredItemId, SessionStore } from "../src/session/store";
import type {
  AgentSessionSnapshot,
  ApprovalItem,
  ExternalAppSnapshot,
  LlmStateSnapshot,
  SessionTask,
} from "../src/session/types";

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

describe("SessionStore — tool lifecycle", () => {
  test("recordToolStart adds running activity and tool phase", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Reading /README.md",
      provider: "filesystem",
      path: "/workspace",
      action: "read",
      label: "Read File",
    });

    const snapshot = store.getSnapshot();
    const toolCall = snapshot.activity.find((item) => item.kind === "tool_call");
    expect(toolCall?.status).toBe("running");
    expect(toolCall?.provider).toBe("filesystem");
    expect(toolCall?.path).toBe("/workspace");
    expect(toolCall?.action).toBe("read");
    expect(toolCall?.label).toBe("Read File");
    expect(toolCall?.toolUseId).toBe("tu-1");

    expect(snapshot.turn.phase).toBe("tool_use");
    expect(snapshot.turn.waitingOn).toBe("tool");
  });

  test("recordToolCompletion updates linked tool_call and pushes a tool_result", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Reading",
      provider: "filesystem",
    });
    store.recordToolCompletion(turnId, {
      toolUseId: "tu-1",
      summary: "Read OK",
      status: "ok",
      provider: "filesystem",
      label: "Read File",
      result: {
        kind: "json",
        data: { ok: true },
      },
    });

    const snapshot = store.getSnapshot();
    const toolCall = snapshot.activity.find((item) => item.kind === "tool_call");
    expect(toolCall?.status).toBe("ok");
    expect(toolCall?.completedAt).toEqual(expect.any(String));

    const toolResult = snapshot.activity.find((item) => item.kind === "tool_result");
    expect(toolResult?.status).toBe("ok");
    expect(toolResult?.summary).toBe("Read OK");
    expect(toolResult?.toolUseId).toBe("tu-1");
    expect(toolResult?.label).toBe("Read File");
    expect(toolResult?.result).toEqual({ kind: "json", data: { ok: true } });

    expect(snapshot.turn.phase).toBe("model");
    expect(snapshot.turn.waitingOn).toBe("model");
  });

  test("stamps monotonic seq across transcript and activity", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Reading",
    });
    store.recordToolCompletion(turnId, {
      toolUseId: "tu-1",
      summary: "Read OK",
      status: "ok",
    });
    store.appendAssistantText(turnId, "done");

    const snapshot = store.getSnapshot();
    expect(snapshot.transcript.map((item) => item.seq)).toEqual([1, 5]);
    expect(snapshot.activity.map((item) => item.seq)).toEqual([2, 3, 4]);
  });

  test("recordToolCompletion with accepted status creates a mirrored task", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Launching task",
      provider: "delegation",
    });
    store.recordToolCompletion(turnId, {
      toolUseId: "tu-1",
      summary: "Task accepted",
      status: "accepted",
      provider: "delegation",
      taskId: "task-abc",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.tasks).toHaveLength(1);
    const [task] = snapshot.tasks;
    expect(task?.provider).toBe("delegation");
    expect(task?.providerTaskId).toBe("task-abc");
    expect(task?.sourcePath).toBe("/tasks/task-abc");
    expect(task?.status).toBe("running");
    expect(task?.linkedActivityId).toEqual(expect.any(String));
    expect(task?.turnId).toBe(turnId);
  });

  test("recordToolCompletion without a matching start still records the result", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolCompletion(turnId, {
      toolUseId: "tu-unknown",
      summary: "stray result",
      status: "error",
    });

    const snapshot = store.getSnapshot();
    const toolResult = snapshot.activity.find((item) => item.kind === "tool_result");
    expect(toolResult?.status).toBe("error");
    expect(toolResult?.toolUseId).toBe("tu-unknown");
    // No tool_call was ever created
    expect(snapshot.activity.find((item) => item.kind === "tool_call")).toBeUndefined();
  });

  test("cancelTurn marks an in-flight tool activity cancelled when toolUseId is given", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Running",
    });
    store.cancelTurn(turnId, { toolUseId: "tu-1", message: "stop" });

    const snapshot = store.getSnapshot();
    const toolCall = snapshot.activity.find((item) => item.kind === "tool_call");
    expect(toolCall?.status).toBe("cancelled");
    expect(toolCall?.summary).toBe("stop");
  });
});

describe("SessionStore — approvals", () => {
  test("recordApprovalRequested flips state to waiting_approval", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordApprovalRequested(turnId, {
      toolUseId: "tu-1",
      summary: "write",
      provider: "filesystem",
      path: "/workspace",
      action: "write",
      reason: "Needs permission to write",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.turn.state).toBe("waiting_approval");
    expect(snapshot.turn.phase).toBe("awaiting_result");
    expect(snapshot.turn.waitingOn).toBe("approval");
    expect(snapshot.turn.message).toBe("Needs permission to write");

    const approvalActivity = snapshot.activity.find(
      (item) => item.kind === "approval" && item.status === "running",
    );
    expect(approvalActivity?.summary).toBe("Needs permission to write");
    expect(approvalActivity?.provider).toBe("filesystem");
  });

  test("syncProviderApprovals stores pending approvals without emitting activity", () => {
    const store = createStore();
    const pending: ApprovalItem = {
      id: "appr-1",
      status: "pending",
      provider: "filesystem",
      path: "/workspace",
      action: "write",
      reason: "confirm",
      createdAt: new Date().toISOString(),
    };

    const initialActivityCount = store.getSnapshot().activity.length;
    store.syncProviderApprovals("filesystem", [pending]);

    const snapshot = store.getSnapshot();
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.approvals[0]?.id).toBe("appr-1");
    // No activity appended because status is pending
    expect(snapshot.activity.length).toBe(initialActivityCount);
  });

  test("syncProviderApprovals emits an activity and resolves the running approval activity on transition", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordApprovalRequested(turnId, {
      toolUseId: "tu-1",
      summary: "write",
      provider: "filesystem",
      path: "/workspace",
      action: "write",
      reason: "confirm",
    });

    const created = new Date().toISOString();
    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-1",
        status: "pending",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "confirm",
        createdAt: created,
      },
    ]);

    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-1",
        status: "approved",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "confirm",
        createdAt: created,
        resolvedAt: new Date().toISOString(),
      },
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.approvals[0]?.status).toBe("approved");

    const approvedActivities = snapshot.activity.filter(
      (item) => item.kind === "approval" && item.status === "ok",
    );
    // The running approval activity is resolved to ok, and a new ok activity is pushed
    expect(approvedActivities.length).toBeGreaterThanOrEqual(1);
    const trackedByApprovalId = approvedActivities.find((item) => item.approvalId === "appr-1");
    expect(trackedByApprovalId).toBeDefined();

    // No more "running" approval activities
    const stillRunning = snapshot.activity.filter(
      (item) => item.kind === "approval" && item.status === "running",
    );
    expect(stillRunning).toHaveLength(0);
  });

  test("syncProviderApprovals maps rejected to cancelled and expired to error", () => {
    const store = createStore();
    const created = new Date().toISOString();

    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-r",
        status: "rejected",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "no",
        createdAt: created,
        resolvedAt: new Date().toISOString(),
      },
    ]);
    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-e",
        status: "expired",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "timeout",
        createdAt: created,
        resolvedAt: new Date().toISOString(),
      },
    ]);

    const snapshot = store.getSnapshot();
    // Rejected approval replaced by expired approval (same provider, replace-style merge)
    expect(snapshot.approvals.map((a) => a.id)).toEqual(["appr-e"]);

    const approvalActivities = snapshot.activity.filter((item) => item.kind === "approval");
    const rejected = approvalActivities.find((item) => item.status === "cancelled");
    const expired = approvalActivities.find((item) => item.status === "error");
    expect(rejected).toBeDefined();
    expect(expired).toBeDefined();
  });

  test("syncProviderApprovals scope: other providers are preserved", () => {
    const store = createStore();
    const createdAt = new Date().toISOString();

    store.syncProviderApprovals("filesystem", [
      {
        id: "fs-1",
        status: "pending",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "a",
        createdAt,
      },
    ]);
    store.syncProviderApprovals("terminal", [
      {
        id: "term-1",
        status: "pending",
        provider: "terminal",
        path: "/shell",
        action: "exec",
        reason: "b",
        createdAt,
      },
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.approvals.map((a) => a.id).sort()).toEqual(["fs-1", "term-1"]);

    // Resyncing filesystem with empty list should remove fs approvals but keep terminal
    store.syncProviderApprovals("filesystem", []);
    const after = store.getSnapshot();
    expect(after.approvals.map((a) => a.id)).toEqual(["term-1"]);
  });

  test("cancelTurn with approvalId resolves a pending approval", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    const createdAt = new Date().toISOString();
    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-1",
        status: "pending",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "confirm",
        createdAt,
      },
    ]);

    store.cancelTurn(turnId, { approvalId: "appr-1", approvalStatus: "rejected" });

    const approval = store.getApproval("appr-1");
    expect(approval?.status).toBe("rejected");
    expect(approval?.resolvedAt).toEqual(expect.any(String));
    expect(approval?.canApprove).toBe(false);
    expect(approval?.canReject).toBe(false);
  });

  test("cancelTurn does not overwrite an already-resolved approval", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    const createdAt = new Date().toISOString();
    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-1",
        status: "approved",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "confirm",
        createdAt,
        resolvedAt: createdAt,
      },
    ]);

    store.cancelTurn(turnId, { approvalId: "appr-1", approvalStatus: "rejected" });
    expect(store.getApproval("appr-1")?.status).toBe("approved");
  });

  test("getApproval returns undefined for unknown id", () => {
    const store = createStore();
    expect(store.getApproval("nope")).toBeUndefined();
  });
});

describe("SessionStore — tasks and apps", () => {
  test("syncProviderTasks merges with previous state, preserving linkedActivityId and turnId", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "delegating",
      provider: "delegation",
    });
    store.recordToolCompletion(turnId, {
      toolUseId: "tu-1",
      summary: "accepted",
      status: "accepted",
      provider: "delegation",
      taskId: "task-1",
    });

    const mirroredId = buildMirroredItemId("task", "delegation", "task-1");
    const before = store.getTask(mirroredId);
    expect(before?.linkedActivityId).toEqual(expect.any(String));
    expect(before?.turnId).toBe(turnId);

    store.syncProviderTasks("delegation", [
      {
        id: mirroredId,
        status: "completed",
        provider: "delegation",
        providerTaskId: "task-1",
        startedAt: before!.startedAt,
        updatedAt: new Date().toISOString(),
        message: "done",
      } satisfies SessionTask,
    ]);

    const after = store.getTask(mirroredId);
    expect(after?.status).toBe("completed");
    expect(after?.message).toBe("done");
    // Preserved from previous
    expect(after?.linkedActivityId).toBe(before?.linkedActivityId);
    expect(after?.turnId).toBe(turnId);
  });

  test("syncProviderTasks replaces tasks scoped to provider only", () => {
    const store = createStore();
    const now = new Date().toISOString();

    store.syncProviderTasks("provider-a", [
      {
        id: "task-a",
        status: "running",
        provider: "provider-a",
        providerTaskId: "a",
        startedAt: now,
        updatedAt: now,
        message: "",
      },
    ]);
    store.syncProviderTasks("provider-b", [
      {
        id: "task-b",
        status: "running",
        provider: "provider-b",
        providerTaskId: "b",
        startedAt: now,
        updatedAt: now,
        message: "",
      },
    ]);

    expect(
      store
        .getSnapshot()
        .tasks.map((t) => t.id)
        .sort(),
    ).toEqual(["task-a", "task-b"]);

    store.syncProviderTasks("provider-a", []);
    expect(store.getSnapshot().tasks.map((t) => t.id)).toEqual(["task-b"]);
  });

  test("clearProviderMirrors removes approvals and tasks for a provider", () => {
    const store = createStore();
    const now = new Date().toISOString();

    store.syncProviderApprovals("provider-a", [
      {
        id: "appr-a",
        status: "pending",
        provider: "provider-a",
        path: "/",
        action: "x",
        reason: "r",
        createdAt: now,
      },
    ]);
    store.syncProviderTasks("provider-a", [
      {
        id: "task-a",
        status: "running",
        provider: "provider-a",
        providerTaskId: "a",
        startedAt: now,
        updatedAt: now,
        message: "",
      },
    ]);
    store.syncProviderApprovals("provider-b", [
      {
        id: "appr-b",
        status: "pending",
        provider: "provider-b",
        path: "/",
        action: "x",
        reason: "r",
        createdAt: now,
      },
    ]);

    store.clearProviderMirrors("provider-a");

    const snapshot = store.getSnapshot();
    expect(snapshot.approvals.map((a) => a.id)).toEqual(["appr-b"]);
    expect(snapshot.tasks).toEqual([]);
  });

  test("clearProviderMirrors is a no-op when nothing matches", () => {
    const store = createStore();
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });
    store.clearProviderMirrors("nobody");
    expect(changes).toBe(0);
  });

  test("syncApps stores apps sorted by name, then id", () => {
    const store = createStore();
    const apps: ExternalAppSnapshot[] = [
      { id: "z", name: "Zeta", transport: "stdio", status: "connected" },
      { id: "a2", name: "Alpha", transport: "stdio", status: "connected" },
      { id: "a1", name: "Alpha", transport: "stdio", status: "connected" },
    ];
    store.syncApps(apps);

    const stored = store.getSnapshot().apps;
    expect(stored.map((app) => app.id)).toEqual(["a1", "a2", "z"]);
  });
});

describe("SessionStore — LLM state", () => {
  test("syncLlmState mirrors provider/model into session metadata", () => {
    const store = createStore();
    const next: LlmStateSnapshot = {
      status: "ready",
      message: "ready",
      activeProfileId: "p1",
      selectedEndpointId: "anthropic",
      selectedProtocol: "anthropic-messages",
      selectedModel: "claude-opus-4-7",
      secureStoreKind: "keychain",
      secureStoreStatus: "available",
      profiles: [
        {
          kind: "native",
          id: "p1",
          endpointId: "anthropic",
          protocol: "anthropic-messages",
          model: "claude-opus-4-7",
          isDefault: true,
          hasKey: true,
          keySource: "secure_store",
          ready: true,
          managed: true,
          origin: "managed",
          canDeleteProfile: true,
          canDeleteApiKey: true,
        },
      ],
    };

    store.syncLlmState(next);

    const snapshot = store.getSnapshot();
    expect(snapshot.llm.status).toBe("ready");
    expect(snapshot.llm.profiles).toHaveLength(1);
    expect(snapshot.session.modelProvider).toBe("anthropic");
    expect(snapshot.session.model).toBe("claude-opus-4-7");
  });
});

describe("SessionStore — usage accounting", () => {
  test("records session-owned usage without mirroring counters into llm state", () => {
    const store = createStore();

    store.recordUsage({
      turnId: "turn-1",
      inputTokens: 42,
      inputTokenSource: "reported",
      outputTokenSource: "unavailable",
      stateContextTokens: 1200,
      stateContextTokenSource: "provider",
    });
    store.recordUsage({
      turnId: "turn-1",
      inputTokens: 3,
      outputTokens: 2,
      thinkingTokens: 7,
      inputTokenSource: "reported",
      outputTokenSource: "reported",
      thinkingTokenSource: "reported",
      stateContextTokens: 1300,
      stateContextTokenSource: "provider",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.usage.lastTurnId).toBe("turn-1");
    expect(snapshot.usage.lastModelCallInputTokens).toBe(3);
    expect(snapshot.usage.lastModelCallOutputTokens).toBe(2);
    expect(snapshot.usage.currentTurnInputTokens).toBe(45);
    expect(snapshot.usage.currentTurnOutputTokens).toBe(2);
    expect(snapshot.usage.currentTurnThinkingTokens).toBe(7);
    expect(snapshot.usage.currentTurnModelCalls).toBe(2);
    expect(snapshot.usage.totalInputTokens).toBe(45);
    expect(snapshot.usage.totalOutputTokens).toBe(2);
    expect(snapshot.usage.totalThinkingTokens).toBe(7);
    expect(snapshot.usage.lastModelCallThinkingTokens).toBe(7);
    expect(snapshot.usage.lastModelCallThinkingSource).toBe("reported");
    expect(snapshot.usage.lastStateContextTokens).toBe(1300);
    expect(snapshot.usage.lastStateContextTokenSource).toBe("provider");
    expect("usage" in snapshot.llm).toBe(false);
  });

  test("syncs model context window without counting a model call", () => {
    const store = createStore();

    store.syncUsageModelContext({
      modelContextWindowTokens: 123_456,
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.usage.modelContextWindowTokens).toBe(123_456);
    expect(snapshot.usage.currentTurnModelCalls).toBe(0);
  });
});

describe("SessionStore — listeners", () => {
  test("onChange fires on every mutation and returns an unsubscribe fn", () => {
    const store = createStore();
    const events: number[] = [];
    const unsub = store.onChange((snap) => {
      events.push(snap.transcript.length);
    });

    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "x");
    store.completeTurn(turnId, "final");

    expect(events.length).toBeGreaterThanOrEqual(3);

    unsub();
    store.beginTurn("again");
    const after = events.length;
    const currentTurn = store.getSnapshot().turn;
    expect(currentTurn.turnId).toBeDefined();
    store.appendAssistantText(currentTurn.turnId!, "y");
    expect(events.length).toBe(after);
  });

  test("close marks session closed and notifies listeners", () => {
    const store = createStore();
    const received: AgentSessionSnapshot[] = [];
    store.onChange((snap) => {
      received.push(snap);
    });
    store.close();
    expect(received.at(-1)?.session.status).toBe("closed");
  });

  test("onTurnChange fires when turn state changes", () => {
    const store = createStore();
    const events: Array<{ type: string; snapshot: AgentSessionSnapshot }> = [];
    const unsub = store.onTurnChange((event) => {
      events.push(event);
    });

    const turnId = store.beginTurn("hi");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("turn");
    expect(events[0].snapshot.turn.state).toBe("running");

    store.appendAssistantText(turnId, "x");
    expect(events.length).toBe(2);
    expect(events[1].type).toBe("turn");

    unsub();
    store.completeTurn(turnId, "done");
    expect(events.length).toBe(2);
  });

  test("onTranscriptChange fires when assistant text is appended", () => {
    const store = createStore();
    const events: Array<{ type: string }> = [];
    store.onTranscriptChange((event) => {
      events.push(event);
    });

    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "hello");

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)?.type).toBe("transcript");
    expect(store.getSnapshot().transcript).toHaveLength(2);
  });

  test("onActivityChange fires on tool recording", () => {
    const store = createStore();
    const events: Array<{ type: string }> = [];
    store.onActivityChange((event) => {
      events.push(event);
    });

    const turnId = store.beginTurn("hi");
    store.recordToolStart(turnId, {
      toolUseId: "tu-1",
      summary: "Read file",
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)?.type).toBe("activity");
    expect(store.getSnapshot().activity).toHaveLength(2);
  });

  test("onApprovalsChange fires on approval sync", () => {
    const store = createStore();
    const events: Array<{ type: string }> = [];
    store.onApprovalsChange((event) => {
      events.push(event);
    });

    const createdAt = new Date().toISOString();
    store.syncProviderApprovals("filesystem", [
      {
        id: "appr-1",
        status: "pending",
        provider: "filesystem",
        path: "/workspace",
        action: "write",
        reason: "confirm",
        createdAt,
      },
    ]);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("approvals");
    expect(store.getSnapshot().approvals).toHaveLength(1);
  });

  test("onChange backward compatible", () => {
    const store = createStore();
    const changeEvents: AgentSessionSnapshot[] = [];
    store.onChange((snap) => {
      changeEvents.push(snap);
    });

    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "x");
    store.completeTurn(turnId, "done");

    expect(changeEvents.length).toBeGreaterThanOrEqual(3);
    // First event should have a user message
    expect(changeEvents[0].transcript).toHaveLength(1);
    // Last event should be complete
    expect(changeEvents.at(-1)?.turn.state).toBe("idle");
  });

  test("unsubscribe works for granular listeners", () => {
    const store = createStore();
    const turnEvents: Array<{ type: string }> = [];
    const unsub = store.onTurnChange((event) => {
      turnEvents.push(event);
    });

    const turnId = store.beginTurn("first");
    store.completeTurn(turnId, "done");
    expect(turnEvents.length).toBe(2);

    unsub();

    const turnId2 = store.beginTurn("second");
    store.completeTurn(turnId2, "done2");
    expect(turnEvents.length).toBe(2);
  });
});

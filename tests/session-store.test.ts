import { describe, expect, test } from "bun:test";

import { buildMirroredItemId, SessionStore } from "../src/session/store";
import type {
  AgentSessionSnapshot,
  ApprovalItem,
  ExternalAppSnapshot,
  LlmStateSnapshot,
  SessionTask,
} from "../src/session/types";

function createStore(overrides?: Partial<{ sessionId: string; title: string; workspaceRoot: string }>) {
  return new SessionStore({
    sessionId: overrides?.sessionId ?? "sess-1",
    modelProvider: "openai",
    model: "gpt-5.4",
    title: overrides?.title,
    workspaceRoot: overrides?.workspaceRoot,
  });
}

function textBlock(snapshot: AgentSessionSnapshot, messageIndex: number): string {
  const message = snapshot.transcript[messageIndex];
  if (!message) {
    throw new Error(`no message at index ${messageIndex}`);
  }
  const [block] = message.content;
  if (!block) {
    throw new Error("message has no content blocks");
  }
  return block.text;
}

describe("SessionStore — initial state", () => {
  test("constructs an idle session snapshot", () => {
    const store = createStore({ title: "hello", workspaceRoot: "/tmp/ws" });
    const snapshot = store.getSnapshot();

    expect(snapshot.session.sessionId).toBe("sess-1");
    expect(snapshot.session.status).toBe("active");
    expect(snapshot.session.modelProvider).toBe("openai");
    expect(snapshot.session.model).toBe("gpt-5.4");
    expect(snapshot.session.title).toBe("hello");
    expect(snapshot.session.workspaceRoot).toBe("/tmp/ws");
    expect(snapshot.session.clientCount).toBe(0);

    expect(snapshot.turn.turnId).toBeNull();
    expect(snapshot.turn.state).toBe("idle");
    expect(snapshot.turn.phase).toBe("none");
    expect(snapshot.turn.iteration).toBe(0);
    expect(snapshot.turn.startedAt).toBeNull();
    expect(snapshot.turn.message).toBe("Idle");

    expect(snapshot.transcript).toEqual([]);
    expect(snapshot.activity).toEqual([]);
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.apps).toEqual([]);

    expect(snapshot.llm.status).toBe("needs_credentials");
    expect(snapshot.llm.selectedProvider).toBe("openai");
    expect(snapshot.llm.selectedModel).toBe("gpt-5.4");
  });

  test("getSnapshot returns an isolated clone", () => {
    const store = createStore();
    const snapshot = store.getSnapshot();

    // Mutate the clone
    snapshot.transcript.push({
      id: "msg-x",
      role: "assistant",
      state: "complete",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [],
    });
    snapshot.session.status = "closed";

    // Internal state should be untouched
    const fresh = store.getSnapshot();
    expect(fresh.transcript).toEqual([]);
    expect(fresh.session.status).toBe("active");
  });
});

describe("SessionStore — transcript & turn lifecycle", () => {
  test("beginTurn pushes a user message and sets running state", () => {
    const store = createStore();
    const turnId = store.beginTurn("Hello there");
    const snapshot = store.getSnapshot();

    expect(turnId).toMatch(/^turn-/);
    expect(snapshot.transcript).toHaveLength(1);

    const userMessage = snapshot.transcript[0]!;
    expect(userMessage.role).toBe("user");
    expect(userMessage.state).toBe("complete");
    expect(userMessage.turnId).toBe(turnId);
    expect(userMessage.author).toBe("user");
    expect(userMessage.content[0]?.text).toBe("Hello there");
    expect(userMessage.content[0]?.mime).toBe("text/plain");

    expect(snapshot.turn.turnId).toBe(turnId);
    expect(snapshot.turn.state).toBe("running");
    expect(snapshot.turn.phase).toBe("model");
    expect(snapshot.turn.iteration).toBe(1);
    expect(snapshot.turn.waitingOn).toBe("model");
    expect(snapshot.turn.startedAt).toEqual(expect.any(String));
    expect(snapshot.session.lastError).toBeUndefined();

    expect(snapshot.activity).toHaveLength(1);
    expect(snapshot.activity[0]?.kind).toBe("model_call");
    expect(snapshot.activity[0]?.status).toBe("running");
    expect(snapshot.activity[0]?.turnId).toBe(turnId);
  });

  test("beginTurn rejects while another turn is running", () => {
    const store = createStore();
    store.beginTurn("first");
    expect(() => store.beginTurn("second")).toThrow(/already running/);
  });

  test("beginTurn rejects while waiting on approval", () => {
    const store = createStore();
    const turnId = store.beginTurn("first");
    store.recordApprovalRequested(turnId, {
      toolUseId: "tool-1",
      summary: "write",
      reason: "Needs user approval",
    });
    expect(store.getSnapshot().turn.state).toBe("waiting_approval");
    expect(() => store.beginTurn("second")).toThrow(/already running/);
  });

  test("beginTurn allowed after error state", () => {
    const store = createStore();
    const firstTurn = store.beginTurn("first");
    store.failTurn(firstTurn, "boom");
    expect(store.getSnapshot().turn.state).toBe("error");

    const secondTurn = store.beginTurn("second");
    expect(secondTurn).not.toBe(firstTurn);
    expect(store.getSnapshot().turn.state).toBe("running");
    // lastError is cleared on new turn
    expect(store.getSnapshot().session.lastError).toBeUndefined();
  });

  test("appendAssistantText creates a streaming message and appends chunks", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "Hello ");
    store.appendAssistantText(turnId, "world");

    const snapshot = store.getSnapshot();
    expect(snapshot.transcript).toHaveLength(2);
    const assistant = snapshot.transcript[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.state).toBe("streaming");
    expect(assistant.author).toBe("gpt-5.4");
    expect(assistant.turnId).toBe(turnId);
    expect(textBlock(snapshot, 1)).toBe("Hello world");

    expect(snapshot.turn.phase).toBe("model");
    expect(snapshot.turn.waitingOn).toBe("model");
  });

  test("appendAssistantText with empty string is a no-op", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "");

    const snapshot = store.getSnapshot();
    // Only the user message exists
    expect(snapshot.transcript).toHaveLength(1);
    expect(snapshot.transcript[0]?.role).toBe("user");
  });

  test("completeTurn finalizes transcript, marks activity ok, returns to idle", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "stream partial");
    store.completeTurn(turnId, "final text");

    const snapshot = store.getSnapshot();
    const assistant = snapshot.transcript[1]!;
    expect(assistant.state).toBe("complete");
    expect(assistant.error).toBeUndefined();
    expect(textBlock(snapshot, 1)).toBe("final text");

    expect(snapshot.turn.turnId).toBeNull();
    expect(snapshot.turn.state).toBe("idle");
    expect(snapshot.turn.phase).toBe("none");
    expect(snapshot.turn.message).toBe("Idle");
    expect(snapshot.turn.waitingOn).toBeNull();

    const modelActivity = snapshot.activity.find((item) => item.kind === "model_call");
    expect(modelActivity?.status).toBe("ok");
    expect(modelActivity?.completedAt).toEqual(expect.any(String));
  });

  test("completeTurn with no streamed text creates and finalizes an assistant message", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.completeTurn(turnId, "synthesized");

    const snapshot = store.getSnapshot();
    expect(snapshot.transcript).toHaveLength(2);
    const assistant = snapshot.transcript[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.state).toBe("complete");
    expect(textBlock(snapshot, 1)).toBe("synthesized");
  });

  test("failTurn preserves startedAt, sets error state, marks assistant message errored", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    const startedAt = store.getSnapshot().turn.startedAt;
    store.appendAssistantText(turnId, "partial");
    store.failTurn(turnId, "model exploded");

    const snapshot = store.getSnapshot();
    expect(snapshot.turn.state).toBe("error");
    expect(snapshot.turn.phase).toBe("complete");
    expect(snapshot.turn.turnId).toBe(turnId);
    expect(snapshot.turn.startedAt).toBe(startedAt);
    expect(snapshot.turn.lastError).toBe("model exploded");
    expect(snapshot.turn.waitingOn).toBeNull();
    expect(snapshot.session.lastError).toBe("model exploded");

    const assistant = snapshot.transcript[1]!;
    expect(assistant.state).toBe("error");
    expect(assistant.error).toBe("model exploded");

    const modelActivity = snapshot.activity.find((item) => item.kind === "model_call");
    expect(modelActivity?.status).toBe("error");

    const errorActivity = snapshot.activity.find((item) => item.kind === "error");
    expect(errorActivity?.status).toBe("error");
    expect(errorActivity?.summary).toBe("model exploded");
  });

  test("cancelTurn returns to idle and marks assistant message complete", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.appendAssistantText(turnId, "partial");
    store.cancelTurn(turnId, { message: "user pressed stop" });

    const snapshot = store.getSnapshot();
    expect(snapshot.turn.state).toBe("idle");
    expect(snapshot.turn.turnId).toBeNull();
    expect(snapshot.turn.message).toBe("user pressed stop");

    const assistant = snapshot.transcript[1]!;
    expect(assistant.state).toBe("complete");
    expect(assistant.error).toBeUndefined();

    const modelActivity = snapshot.activity.find((item) => item.kind === "model_call");
    expect(modelActivity?.status).toBe("cancelled");
    expect(modelActivity?.summary).toBe("user pressed stop");
  });

  test("cancelTurn uses default message when none provided", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    store.cancelTurn(turnId);

    const snapshot = store.getSnapshot();
    expect(snapshot.turn.message).toBe("Turn cancelled by user.");
    const modelActivity = snapshot.activity.find((item) => item.kind === "model_call");
    expect(modelActivity?.summary).toBe("Turn cancelled by user.");
  });
});

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
    });

    const snapshot = store.getSnapshot();
    const toolCall = snapshot.activity.find((item) => item.kind === "tool_call");
    expect(toolCall?.status).toBe("running");
    expect(toolCall?.provider).toBe("filesystem");
    expect(toolCall?.path).toBe("/workspace");
    expect(toolCall?.action).toBe("read");
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
    });

    const snapshot = store.getSnapshot();
    const toolCall = snapshot.activity.find((item) => item.kind === "tool_call");
    expect(toolCall?.status).toBe("ok");
    expect(toolCall?.completedAt).toEqual(expect.any(String));

    const toolResult = snapshot.activity.find((item) => item.kind === "tool_result");
    expect(toolResult?.status).toBe("ok");
    expect(toolResult?.summary).toBe("Read OK");
    expect(toolResult?.toolUseId).toBe("tu-1");

    expect(snapshot.turn.phase).toBe("model");
    expect(snapshot.turn.waitingOn).toBe("model");
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
    store.recordToolStart(turnId, { toolUseId: "tu-1", summary: "delegating", provider: "delegation" });
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

    expect(store.getSnapshot().tasks.map((t) => t.id).sort()).toEqual(["task-a", "task-b"]);

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
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-7",
      secureStoreKind: "keychain",
      secureStoreStatus: "available",
      profiles: [
        {
          id: "p1",
          provider: "anthropic",
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
    store.appendAssistantText(store.getSnapshot().turn.turnId!, "y");
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
});

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

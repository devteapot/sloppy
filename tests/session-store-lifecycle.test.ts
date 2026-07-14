import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalSnapshotToExtension } from "../src/plugins/first-party/persistent-goal/goal-schema";
import { createPersistentGoalPlugin } from "../src/plugins/first-party/persistent-goal/session";
import { SessionStore } from "../src/session/store";
import type { AgentSessionSnapshot, SessionGoalSnapshot } from "../src/session/types";

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

function textBlock(snapshot: AgentSessionSnapshot, messageIndex: number): string {
  const message = snapshot.transcript[messageIndex];
  if (!message) {
    throw new Error(`no message at index ${messageIndex}`);
  }
  const [block] = message.content;
  if (!block) {
    throw new Error("message has no content blocks");
  }
  if (block.type === "media") {
    return block.summary ?? "";
  }
  return block.text;
}

function seedGoal(
  store: SessionStore,
  goal: Partial<SessionGoalSnapshot> & { objective: string },
): string {
  const timestamp = new Date().toISOString();
  const snapshot: SessionGoalSnapshot = {
    goalId: goal.goalId ?? `goal-${crypto.randomUUID()}`,
    objective: goal.objective,
    status: goal.status ?? "active",
    createdAt: goal.createdAt ?? timestamp,
    updatedAt: goal.updatedAt ?? timestamp,
    inputTokens: goal.inputTokens ?? 0,
    outputTokens: goal.outputTokens ?? 0,
    totalTokens: goal.totalTokens ?? 0,
    elapsedMs: goal.elapsedMs ?? 0,
    continuationCount: goal.continuationCount ?? 0,
    message: goal.message ?? "Goal active.",
  };
  if (goal.tokenBudget !== undefined) snapshot.tokenBudget = goal.tokenBudget;
  if (goal.lastTurnId) snapshot.lastTurnId = goal.lastTurnId;
  if (goal.evidence) snapshot.evidence = goal.evidence;
  if (goal.updateSource) snapshot.updateSource = goal.updateSource;
  if (goal.completionSource) snapshot.completionSource = goal.completionSource;
  if (goal.completedAt) snapshot.completedAt = goal.completedAt;
  store.upsertExtension(goalSnapshotToExtension(snapshot));
  return snapshot.goalId;
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

    expect(snapshot.queue).toEqual([]);
    expect(snapshot.transcript).toEqual([]);
    expect(snapshot.activity).toEqual([]);
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.apps).toEqual([]);

    expect(snapshot.llm.status).toBe("needs_credentials");
    expect(snapshot.llm.selectedEndpointId).toBe("openai");
    expect(snapshot.llm.selectedModel).toBe("gpt-5.4");
  });

  test("getSnapshot returns an isolated clone", () => {
    const store = createStore();
    const snapshot = store.getSnapshot();

    // Mutate the clone
    snapshot.transcript.push({
      id: "msg-x",
      seq: 1,
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

  test("isolates selected and profile capability metadata on ingestion and snapshot reads", () => {
    const store = createStore();
    const selectedCapabilities = { tools: true, images: false };
    const profileCapabilities = { tools: false, images: true };
    store.syncLlmState({
      status: "ready",
      message: "Ready",
      activeProfileId: "openai-main",
      selectedEndpointId: "openai",
      selectedProtocol: "openai-responses",
      selectedModel: "gpt-5.4",
      selectedCapabilities,
      selectedOwnsToolLoop: false,
      secureStoreKind: "none",
      secureStoreStatus: "unsupported",
      profiles: [
        {
          kind: "native",
          id: "openai-main",
          endpointId: "openai",
          protocol: "openai-responses",
          model: "gpt-5.4",
          capabilities: profileCapabilities,
          ownsToolLoop: false,
          isDefault: true,
          hasKey: false,
          keySource: "not_required",
          ready: true,
          managed: true,
          origin: "managed",
          canDeleteProfile: true,
          canDeleteApiKey: false,
        },
      ],
    });

    selectedCapabilities.tools = false;
    profileCapabilities.images = false;
    const first = store.getSnapshot();
    expect(first.llm.selectedCapabilities).toEqual({ tools: true, images: false });
    expect(first.llm.profiles[0]?.capabilities).toEqual({ tools: false, images: true });

    if (!first.llm.selectedCapabilities || !first.llm.profiles[0]?.capabilities) {
      throw new Error("Expected capability metadata in the Session snapshot.");
    }
    first.llm.selectedCapabilities.tools = false;
    first.llm.profiles[0].capabilities.images = false;

    const fresh = store.getSnapshot();
    expect(fresh.llm.selectedCapabilities).toEqual({ tools: true, images: false });
    expect(fresh.llm.profiles[0]?.capabilities).toEqual({ tools: false, images: true });
  });
});

describe("SessionStore — persistence", () => {
  test("persists and restores visible session snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-persist-"));
    try {
      const persistencePath = join(root, "sess-1.json");
      const store = createStore({ persistencePath });
      const turnId = store.beginTurn("remember this");
      store.enqueueMessage("next visible input");
      store.appendAssistantText(turnId, "partial");
      store.completeTurn(turnId, "restored response");

      const persisted = JSON.parse(await readFile(persistencePath, "utf8")) as {
        kind: string;
        schema_version: number;
        snapshot: AgentSessionSnapshot;
      };
      expect(persisted.kind).toBe("sloppy.session.snapshot");
      expect(persisted.schema_version).toBe(2);
      expect(persisted.snapshot.extensions).toEqual({});
      expect(persisted.snapshot.goal).toBeNull();
      expect(persisted.snapshot.transcript.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);

      const restored = createStore({ persistencePath }).getSnapshot();
      expect(restored.session.persistencePath).toBe(persistencePath);
      expect(restored.session.restoredAt).toEqual(expect.any(String));
      expect(restored.transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(textBlock(restored, 1)).toBe("restored response");
      expect(restored.queue.map((message) => message.text)).toEqual(["next visible input"]);
      expect(restored.turn.state).toBe("idle");
      expect(restored.session.clientCount).toBe(0);
      expect(restored.session.connectedClients).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsupported session snapshot schema envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-schema-"));
    try {
      const persistencePath = join(root, "sess-unsupported.json");
      await writeFile(
        persistencePath,
        `${JSON.stringify(
          {
            kind: "sloppy.session.snapshot",
            schema_version: 999,
            saved_at: "2026-05-06T00:00:00.000Z",
            snapshot: createStore().getSnapshot(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      expect(() => createStore({ persistencePath })).toThrow("unsupported schema_version 999");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers stale in-flight turns visibly after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-recover-"));
    try {
      const persistencePath = join(root, "sess-1.json");
      const store = createStore({ persistencePath });
      seedGoal(store, {
        objective: "recover cleanly",
        message: "Goal active.",
      });
      const turnId = store.beginTurn("needs approval");
      store.appendAssistantText(turnId, "half-written");
      store.recordApprovalRequested(turnId, {
        toolUseId: "tool-1",
        summary: "terminal:execute /session",
        provider: "terminal",
        path: "/session",
        action: "execute",
        reason: "Needs approval",
      });
      store.syncProviderApprovals("terminal", [
        {
          id: "approval-1",
          status: "pending",
          provider: "terminal",
          path: "/session",
          action: "execute",
          reason: "Needs approval",
          createdAt: new Date().toISOString(),
          canApprove: true,
          canReject: true,
          turnId,
        },
      ]);
      store.syncProviderTasks("terminal", [
        {
          id: "task-1",
          status: "running",
          provider: "terminal",
          providerTaskId: "provider-task-1",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "Running",
          turnId,
          canCancel: true,
        },
      ]);

      const restored = createStore({ persistencePath }).getSnapshot();
      expect(restored.session.recoveredAfterRestart).toBe(true);
      expect(restored.turn.state).toBe("error");
      expect(restored.turn.lastError).toContain("could not be resumed");
      expect(restored.transcript.find((message) => message.role === "assistant")?.state).toBe(
        "error",
      );
      expect(restored.approvals[0]?.status).toBe("expired");
      expect(restored.approvals[0]?.canApprove).toBe(false);
      expect(restored.tasks[0]?.status).toBe("superseded");
      expect(restored.tasks[0]?.error).toContain("could not be resumed");
      expect(restored.tasks[0]?.canCancel).toBe(false);
      expect(restored.goal?.status).toBe("paused");
      expect(restored.goal?.message).toContain("process restart");
      expect(restored.goal?.updateSource).toBe("runtime");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retains completed goal metadata until cleanup sweep expires it", () => {
    const store = createStore();
    seedGoal(store, {
      objective: "clean up extension state",
      status: "complete",
      message: "done",
      updateSource: "user",
      completionSource: "user",
      completedAt: new Date().toISOString(),
    });

    const completed = store.getSnapshot();
    const retainUntil = completed.extensions.goal?.retainUntil;
    expect(completed.goal?.status).toBe("complete");
    expect(completed.extensions.goal?.lifecycle).toBe("completed");
    expect(retainUntil).toEqual(expect.any(String));

    expect(store.sweepExtensions({ now: completed.extensions.goal?.updatedAt }).removed).toEqual(
      [],
    );
    expect(store.getSnapshot().goal?.status).toBe("complete");

    const afterRetention = new Date(Date.parse(retainUntil ?? "") + 1).toISOString();
    expect(store.sweepExtensions({ now: afterRetention }).removed).toEqual(["goal"]);
    expect(store.getSnapshot().goal).toBeNull();
    expect(store.getSnapshot().extensions.goal).toBeUndefined();
  });
});

describe("SessionStore — queued messages", () => {
  test("enqueueMessage stores shared FIFO input outside the transcript", () => {
    const store = createStore();
    const queued = store.enqueueMessage("run this after the current turn");
    const snapshot = store.getSnapshot();

    expect(queued.id).toMatch(/^queued-/);
    expect(queued.status).toBe("queued");
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.queue[0]?.text).toBe("run this after the current turn");
    expect(snapshot.queue[0]?.author).toBe("user");
    expect(snapshot.transcript).toEqual([]);
  });

  test("dequeueMessage returns messages in FIFO order", () => {
    const store = createStore();
    store.enqueueMessage("first");
    store.enqueueMessage("second");

    expect(store.dequeueMessage()?.text).toBe("first");
    expect(store.dequeueMessage()?.text).toBe("second");
    expect(store.dequeueMessage()).toBeUndefined();
    expect(store.getSnapshot().queue).toEqual([]);
  });

  test("removeQueuedMessage cancels one queued input", () => {
    const store = createStore();
    const first = store.enqueueMessage("first");
    const second = store.enqueueMessage("second");

    expect(store.removeQueuedMessage(first.id).text).toBe("first");
    expect(store.getSnapshot().queue.map((message) => message.id)).toEqual([second.id]);
    expect(() => store.removeQueuedMessage(first.id)).toThrow(/Unknown queued message/);
  });
});

describe("SessionStore — transcript & turn lifecycle", () => {
  test("beginTurn pushes a user message and sets running state", () => {
    const store = createStore();
    const turnId = store.beginTurn("Hello there");
    const snapshot = store.getSnapshot();

    expect(turnId).toMatch(/^turn-/);
    expect(snapshot.transcript).toHaveLength(1);

    const userMessage = snapshot.transcript[0];
    expect(userMessage.role).toBe("user");
    expect(userMessage.state).toBe("complete");
    expect(userMessage.turnId).toBe(turnId);
    expect(userMessage.author).toBe("user");
    const userBlock = userMessage.content[0];
    const userText =
      userBlock?.type === "text"
        ? userBlock.text
        : userBlock?.type === "media"
          ? (userBlock.summary ?? "")
          : "";
    expect(userText).toBe("Hello there");
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
    const assistant = snapshot.transcript[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.state).toBe("streaming");
    expect(assistant.author).toBe("gpt-5.4");
    expect(assistant.turnId).toBe(turnId);
    expect(textBlock(snapshot, 1)).toBe("Hello world");

    expect(snapshot.turn.phase).toBe("model");
    expect(snapshot.turn.waitingOn).toBe("model");
  });

  test("appendAssistantThinking keeps thinking separate from assistant text", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    const startedAt = "2026-05-21T10:00:00.000Z";
    const completedAt = "2026-05-21T10:00:02.000Z";

    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "raw",
      display: "hidden",
      delta: "checking",
      startedAt,
      tokenCount: 12,
      tokenCountSource: "reported",
    });
    store.appendAssistantText(turnId, "partial");
    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "raw",
      display: "hidden",
      delta: " state",
      completedAt,
      elapsedMs: 2000,
      tokenCount: 12,
      tokenCountSource: "reported",
      done: true,
    });
    store.completeTurn(turnId, "final text");

    const assistant = store.getSnapshot().transcript[1];
    expect(assistant?.content.map((block) => block.type)).toEqual(["thinking", "text"]);
    const thinking = assistant?.content[0];
    expect(thinking).toMatchObject({
      type: "thinking",
      id: "thinking-1",
      text: "checking state",
      display: "hidden",
      provider: "openai",
      model: "gpt-5.4",
      startedAt,
      completedAt,
      elapsedMs: 2000,
      tokenCount: 12,
      tokenCountSource: "reported",
    });
    const text = assistant?.content[1];
    expect(text).toMatchObject({ type: "text", text: "final text" });
  });

  test("appendAssistantThinking preserves stream order across repeated thinking phases", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    const completedAt = "2026-05-21T10:00:03.000Z";

    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "raw",
      display: "hidden",
      delta: "thinking 1",
    });
    store.appendAssistantText(turnId, "turn 1");
    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "raw",
      display: "hidden",
      delta: "thinking 2",
    });
    store.appendAssistantText(turnId, "turn 2");
    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "raw",
      display: "hidden",
      completedAt,
      elapsedMs: 3000,
      done: true,
    });
    store.completeTurn(turnId, "turn 1turn 2");

    const assistant = store.getSnapshot().transcript[1];
    expect(assistant?.content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "thinking",
      "text",
    ]);
    expect(assistant?.content.map((block) => ("text" in block ? block.text : ""))).toEqual([
      "thinking 1",
      "turn 1",
      "thinking 2",
      "turn 2",
    ]);
    expect(assistant?.content[0]?.id).toBe("thinking-1");
    expect(assistant?.content[2]?.id).not.toBe("thinking-1");
    expect(assistant?.content[2]).toMatchObject({
      type: "thinking",
      completedAt,
      elapsedMs: 3000,
    });
  });

  test("appendAssistantThinking starts a new block after tool activity", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");

    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "summary",
      display: "hidden",
      delta: "before tool",
    });
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
    store.appendAssistantThinking(turnId, {
      blockId: "thinking-1",
      provider: "openai",
      model: "gpt-5.4",
      format: "summary",
      display: "hidden",
      delta: "after tool",
    });
    store.appendAssistantText(turnId, "final");

    const snapshot = store.getSnapshot();
    const assistant = snapshot.transcript[1];
    const toolCall = snapshot.activity.find((item) => item.kind === "tool_call");
    const toolResult = snapshot.activity.find((item) => item.kind === "tool_result");
    expect(assistant?.content.map((block) => block.type)).toEqual(["thinking", "thinking", "text"]);
    expect(assistant?.content.map((block) => ("text" in block ? block.text : ""))).toEqual([
      "before tool",
      "after tool",
      "final",
    ]);
    expect(assistant?.content[0]?.seq).toBeLessThan(toolCall?.seq as number);
    expect(toolResult?.seq).toBeLessThan(assistant?.content[1]?.seq as number);
    expect(assistant?.content[1]?.seq).toBeLessThan(assistant?.content[2]?.seq as number);
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
    const assistant = snapshot.transcript[1];
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
    const assistant = snapshot.transcript[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.state).toBe("complete");
    expect(textBlock(snapshot, 1)).toBe("synthesized");
  });

  test("failTurn preserves startedAt, sets error state, marks assistant message errored", () => {
    const store = createStore();
    const turnId = store.beginTurn("hi");
    const startedAt = store.getSnapshot().turn.startedAt;
    store.appendAssistantText(turnId, "partial");
    store.failTurn(turnId, "model exploded", {
      errorCode: "rate_limit",
      retryable: true,
      requestId: "req-123",
      retryAfterMs: 1_500,
      httpStatus: 429,
      partialOutput: true,
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.turn.state).toBe("error");
    expect(snapshot.turn.phase).toBe("complete");
    expect(snapshot.turn.turnId).toBe(turnId);
    expect(snapshot.turn.startedAt).toBe(startedAt);
    expect(snapshot.turn.lastError).toBe("model exploded");
    expect(snapshot.turn.waitingOn).toBeNull();
    expect(snapshot.session.lastError).toBe("model exploded");

    const assistant = snapshot.transcript[1];
    expect(assistant.state).toBe("error");
    expect(assistant.error).toBe("model exploded");

    const modelActivity = snapshot.activity.find((item) => item.kind === "model_call");
    expect(modelActivity?.status).toBe("error");
    expect(modelActivity).toMatchObject({
      errorCode: "rate_limit",
      retryable: true,
      requestId: "req-123",
      retryAfterMs: 1_500,
      httpStatus: 429,
      partialOutput: true,
    });

    const errorActivity = snapshot.activity.find((item) => item.kind === "error");
    expect(errorActivity?.status).toBe("error");
    expect(errorActivity?.summary).toBe("model exploded");
    expect(errorActivity?.errorCode).toBe("rate_limit");
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

    const assistant = snapshot.transcript[1];
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

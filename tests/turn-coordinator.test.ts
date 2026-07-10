import { describe, expect, test } from "bun:test";
import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { AgentRunResult, AgentToolEvent, ResolvedApprovalToolResult } from "../src/core/agent";
import { LlmRequestError } from "../src/llm/types";
import { SessionPluginManager } from "../src/session/plugins";
import type { PluginRuntimeContext, SessionRuntimePlugin } from "../src/session/plugins/types";
import { SessionStore } from "../src/session/store";
import { type TurnAgentPort, TurnCoordinator } from "../src/session/turn-coordinator";
import type { ApprovalItem } from "../src/session/types";
import { createTestConfig } from "./helpers/config";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function okResult(data?: unknown): ResultMessage {
  return { type: "result", id: crypto.randomUUID(), status: "ok", data };
}

class FakeTurnAgent implements TurnAgentPort {
  chats: string[] = [];
  resumes: ResolvedApprovalToolResult[] = [];
  directApprovals: string[] = [];
  directRejections: Array<{ id: string; reason?: string }> = [];
  providerInvocations: Array<{
    providerId: string;
    path: string;
    action: string;
    params?: Record<string, unknown>;
  }> = [];
  cancelCalls = 0;
  clearPendingApprovalCalls = 0;

  private chatQueue: Array<ReturnType<typeof deferred<AgentRunResult>>> = [];
  private resumeQueue: Array<ReturnType<typeof deferred<AgentRunResult>>> = [];

  nextChat() {
    const next = deferred<AgentRunResult>();
    this.chatQueue.push(next);
    return next;
  }

  nextResume() {
    const next = deferred<AgentRunResult>();
    this.resumeQueue.push(next);
    return next;
  }

  async chat(userMessage: string): Promise<AgentRunResult> {
    this.chats.push(userMessage);
    const next = this.chatQueue.shift();
    if (!next) {
      return { status: "completed", response: `echo:${userMessage}` };
    }
    return next.promise;
  }

  async resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult> {
    this.resumes.push(result);
    const next = this.resumeQueue.shift();
    if (!next) {
      return { status: "completed", response: "resumed" };
    }
    return next.promise;
  }

  async invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    this.providerInvocations.push({ providerId, path, action, params });
    return okResult({ providerId, path, action });
  }

  async resolveApprovalDirect(approvalId: string): Promise<ResultMessage> {
    this.directApprovals.push(approvalId);
    return okResult({ approved: approvalId });
  }

  rejectApprovalDirect(approvalId: string, reason?: string): void {
    this.directRejections.push({ id: approvalId, reason });
  }

  cancelActiveTurn(): boolean {
    this.cancelCalls += 1;
    return true;
  }

  clearPendingApproval(): void {
    this.clearPendingApprovalCalls += 1;
  }
}

function makeStore() {
  return new SessionStore({
    sessionId: crypto.randomUUID(),
    modelProvider: "openai",
    model: "gpt-test",
  });
}

function makePlugins(plugins: SessionRuntimePlugin[] = []) {
  const store = makeStore();
  const ctx: PluginRuntimeContext = {
    config: () => createTestConfig(),
    store,
    snapshot: () => store.getSnapshot(),
    ensureReady: async () => undefined,
    getRuntimeService: () => undefined,
    invokeProvider: async () => okResult(),
    queryProvider: async () => ({ id: "root", type: "group" }),
    transientState: {
      read: () => undefined,
      replace: () => undefined,
      update: () => undefined,
      clear: () => undefined,
    },
    approvals: {
      request: () => {
        throw new Error("not used");
      },
      cancel: () => false,
    },
    turns: {
      submit: () => ({ status: "started", turnId: "turn-test" }),
      drainQueue: () => undefined,
    },
    startTurn: () => ({ status: "started", turnId: "turn-test" }),
    queueTurn: () => ({ status: "queued", queuedMessageId: "queued-test", position: 1 }),
    drainQueue: () => undefined,
    audit: () => undefined,
  };
  return new SessionPluginManager(plugins, () => ctx);
}

function makeCoordinator(options?: {
  store?: SessionStore;
  agent?: FakeTurnAgent;
  plugins?: SessionPluginManager;
  audit?: Array<Record<string, unknown> & { kind: string }>;
}) {
  const store = options?.store ?? makeStore();
  const agent = options?.agent ?? new FakeTurnAgent();
  const audit = options?.audit ?? [];
  const turns = new TurnCoordinator({
    store,
    plugins: options?.plugins ?? makePlugins(),
    agent: () => agent,
    audit: (event) => audit.push(event),
    previewToolParams: () => undefined,
    boundToolResult: (input) =>
      input
        ? { kind: input.kind, data: typeof input.data === "string" ? input.data : undefined }
        : undefined,
    buildToolResultBlock: (toolUseId, result) => ({
      type: "tool_result",
      toolUseId,
      content: JSON.stringify(result.data ?? null),
      isError: result.status === "error",
    }),
    isAbortError: (error) => error instanceof Error && error.name === "AbortError",
  });
  return { turns, store, agent, audit };
}

function approvalRequestedEvent(sourceApprovalId: string): AgentToolEvent {
  return {
    kind: "approval_requested",
    invocation: {
      toolUseId: "tool-1",
      toolName: "terminal__session__execute",
      kind: "affordance",
      providerId: "terminal",
      path: "/session",
      action: "execute",
      params: { command: "echo hi" },
      resultKind: "terminal",
    },
    summary: "Execute Command",
    errorCode: "approval_required",
    errorMessage: "Needs approval",
    approvalId: sourceApprovalId,
  };
}

function approvalItem(sourceApprovalId: string, turnId: string): ApprovalItem {
  return {
    id: "session-approval-1",
    status: "pending",
    provider: "terminal",
    path: "/approvals/approval-source-1",
    sourcePath: "/approvals/approval-source-1",
    sourceApprovalId,
    action: "execute",
    reason: "Needs approval",
    createdAt: new Date().toISOString(),
    canApprove: true,
    canReject: true,
    turnId,
  };
}

describe("TurnCoordinator", () => {
  test("submit(user) starts immediately and completes through the Agent", async () => {
    const { turns, store, agent, audit } = makeCoordinator();

    const result = turns.submit({ source: "user", text: "hello" });
    await turns.waitForIdle();

    expect(result.status).toBe("started");
    expect(agent.chats).toEqual(["hello"]);
    expect(store.getSnapshot().turn.state).toBe("idle");
    expect(store.getSnapshot().transcript.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(audit.some((event) => event.kind === "turn_started")).toBe(true);
    expect(audit.some((event) => event.kind === "turn_completed")).toBe(true);
  });

  test("submit(user) queues while active and drains FIFO after completion", async () => {
    const agent = new FakeTurnAgent();
    const first = agent.nextChat();
    const { turns, store } = makeCoordinator({ agent });

    const firstResult = turns.submit({ source: "user", text: "first" });
    const queued = turns.submit({ source: "user", text: "second" });

    expect(firstResult.status).toBe("started");
    expect(queued).toMatchObject({ status: "queued", position: 1 });
    expect(store.getSnapshot().queue).toHaveLength(1);
    expect(agent.chats).toEqual(["first"]);

    first.resolve({ status: "completed", response: "done first" });
    await turns.waitForIdle();

    expect(agent.chats).toEqual(["first", "second"]);
    expect(store.getSnapshot().queue).toHaveLength(0);
    expect(store.getSnapshot().turn.state).toBe("idle");
  });

  test("shutdown ignores late turn settlement and preserves queued input", async () => {
    const agent = new FakeTurnAgent();
    const first = agent.nextChat();
    const { turns, store, audit } = makeCoordinator({ agent });

    turns.submit({ source: "user", text: "first" });
    turns.submit({ source: "user", text: "second" });
    turns.shutdown();
    store.close();

    const abortError = new Error("stopped");
    abortError.name = "AbortError";
    first.reject(abortError);
    await Bun.sleep(0);

    const snapshot = store.getSnapshot();
    expect(snapshot.session.status).toBe("closed");
    expect(snapshot.turn.state).toBe("running");
    expect(snapshot.queue.map((message) => message.text)).toEqual(["second"]);
    expect(agent.chats).toEqual(["first"]);
    expect(audit.some((event) => event.kind === "turn_cancelled")).toBe(false);
    expect(() => turns.submit({ source: "user", text: "third" })).toThrow("shut down");
  });

  test("records structured model request failures in activity and audit state", async () => {
    const agent = new FakeTurnAgent();
    const chat = agent.nextChat();
    const { turns, store, audit } = makeCoordinator({ agent });

    turns.submit({ source: "user", text: "rate limited" });
    chat.reject(
      new LlmRequestError("Too many requests", {
        code: "rate_limit",
        retryable: true,
        status: 429,
        retryAfterMs: 2_000,
        requestId: "req-rate-limit",
      }),
    );
    await turns.waitForIdle();

    expect(store.getSnapshot().turn.state).toBe("error");
    const errorActivity = store.getSnapshot().activity.find((item) => item.kind === "error");
    expect(errorActivity).toMatchObject({
      errorCode: "rate_limit",
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 2_000,
      requestId: "req-rate-limit",
      partialOutput: false,
    });
    expect(audit.find((event) => event.kind === "turn_failed")).toMatchObject({
      errorCode: "rate_limit",
      requestId: "req-rate-limit",
    });
  });

  test("Plugin turns call completion hook exactly once", async () => {
    const completions: unknown[] = [];
    const plugin: SessionRuntimePlugin = {
      id: "test-plugin",
      version: "0.0.0",
      onTurnComplete: (event) => completions.push(event),
    };
    const { turns } = makeCoordinator({ plugins: makePlugins([plugin]) });

    turns.submit({
      source: "plugin",
      request: {
        pluginId: "test-plugin",
        runId: "run-1",
        text: "plugin work",
        author: "Test Plugin",
      },
    });
    await turns.waitForIdle();

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      pluginTurn: { pluginId: "test-plugin", runId: "run-1" },
      usedTools: false,
    });
  });

  test("submit(plugin) queues atomically while another Turn is active", async () => {
    const agent = new FakeTurnAgent();
    const active = agent.nextChat();
    const { turns, store } = makeCoordinator({ agent });

    turns.submit({ source: "user", text: "active user work" });
    const submitted = turns.submit({
      source: "plugin",
      request: {
        pluginId: "test-plugin",
        runId: "run-queued-atomically",
        text: "voice ingress",
        author: "Test Plugin",
      },
    });

    expect(submitted).toMatchObject({ status: "queued", position: 1 });
    expect(store.getSnapshot().queue[0]).toMatchObject({
      source: "plugin",
      pluginId: "test-plugin",
      pluginRunId: "run-queued-atomically",
    });

    active.resolve({ status: "completed", response: "done" });
    await turns.waitForIdle();
  });

  test("queued Plugin cancellation notifies its owner", () => {
    const cancelled: unknown[] = [];
    const plugin: SessionRuntimePlugin = {
      id: "test-plugin",
      version: "0.0.0",
      onQueuedTurnCancelled: (message) => cancelled.push(message),
    };
    const { turns } = makeCoordinator({ plugins: makePlugins([plugin]) });
    const queued = turns.queuePluginTurn({
      pluginId: "test-plugin",
      runId: "run-cancelled",
      text: "cancel me",
      author: "Test Plugin",
    });

    turns.cancelQueuedTurn(queued.queuedMessageId);

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ pluginId: "test-plugin", pluginRunId: "run-cancelled" });
  });

  test("queued Plugin cancellation stays committed when the owner callback throws", () => {
    const plugin: SessionRuntimePlugin = {
      id: "test-plugin",
      version: "0.0.0",
      onQueuedTurnCancelled: () => {
        throw new Error("cleanup failed");
      },
    };
    const audit: Array<Record<string, unknown> & { kind: string }> = [];
    const { turns, store } = makeCoordinator({ plugins: makePlugins([plugin]), audit });
    const queued = turns.queuePluginTurn({
      pluginId: "test-plugin",
      runId: "run-callback-fails",
      text: "cancel me anyway",
      author: "Test Plugin",
    });

    expect(turns.cancelQueuedTurn(queued.queuedMessageId)).toEqual({
      queuedMessageId: queued.queuedMessageId,
      status: "cancelled",
    });
    expect(store.getSnapshot().queue).toEqual([]);
    expect(audit).toContainEqual(
      expect.objectContaining({
        kind: "plugin_queued_turn_cancel_callback_error",
        pluginId: "test-plugin",
        error: "cleanup failed",
      }),
    );
  });

  test("approval resolution resumes the active pending Turn by sourceApprovalId", async () => {
    const agent = new FakeTurnAgent();
    const chat = agent.nextChat();
    const resume = agent.nextResume();
    const { turns, store } = makeCoordinator({ agent });

    const started = turns.submit({ source: "user", text: "needs approval" });
    if (started.status !== "started") {
      throw new Error("expected approval test turn to start immediately");
    }
    const turnId = started.turnId;
    const sourceApprovalId = "approval-source-1";

    turns.handleToolEvent(approvalRequestedEvent(sourceApprovalId));
    store.syncProviderApprovals("terminal", [approvalItem(sourceApprovalId, turnId)]);
    chat.resolve({
      status: "waiting_approval",
      invocation: approvalRequestedEvent(sourceApprovalId).invocation,
    });

    const approval = store.getSnapshot().approvals[0];
    expect(approval?.status).toBe("pending");

    const approved = await turns.resolveApproval(approval?.id ?? "", "approve");
    resume.resolve({ status: "completed", response: "approved response" });
    await turns.waitForIdle();

    expect(approved.status).toBe("ok");
    expect(agent.directApprovals).toEqual([sourceApprovalId]);
    expect(agent.resumes).toHaveLength(1);
    expect(agent.resumes[0]?.block.toolUseId).toBe("tool-1");
    expect(store.getSnapshot().turn.state).toBe("idle");
  });

  test("unrelated approvals invoke the provider instead of resuming the active Turn", async () => {
    const agent = new FakeTurnAgent();
    const active = agent.nextChat();
    const { turns, store } = makeCoordinator({ agent });

    turns.submit({ source: "user", text: "long turn" });
    store.syncProviderApprovals("terminal", [
      {
        ...approvalItem("background-approval", "other-turn"),
        id: "background-session-approval",
        turnId: undefined,
      },
    ]);

    const result = await turns.resolveApproval("background-session-approval", "approve");

    expect(result.status).toBe("ok");
    expect(agent.directApprovals).toEqual([]);
    expect(agent.resumes).toEqual([]);
    expect(agent.providerInvocations).toMatchObject([
      { providerId: "terminal", path: "/approvals/approval-source-1", action: "approve" },
    ]);

    active.resolve({ status: "completed", response: "done" });
    await turns.waitForIdle();
  });

  test("drainQueue starts a pending plugin continuation when idle", async () => {
    let nextTurnCalls = 0;
    const plugin: SessionRuntimePlugin = {
      id: "goal-plugin",
      version: "0.0.0",
      nextTurn: () => {
        nextTurnCalls += 1;
        return nextTurnCalls === 1
          ? {
              pluginId: "goal-plugin",
              runId: "resume-1",
              text: "continue goal",
              author: "Goal Plugin",
              continuation: true,
            }
          : null;
      },
    };
    const { turns, agent } = makeCoordinator({ plugins: makePlugins([plugin]) });

    turns.drainQueue();
    await turns.waitForIdle();

    expect(nextTurnCalls).toBeGreaterThanOrEqual(1);
    expect(agent.chats).toEqual(["continue goal"]);
  });

  test("queuePluginTurn always queues, even while idle", () => {
    const { turns, store, agent } = makeCoordinator();

    const queued = turns.queuePluginTurn({
      pluginId: "test-plugin",
      runId: "run-queued",
      text: "queued plugin work",
      author: "Test Plugin",
    });

    expect(queued).toMatchObject({ status: "queued", position: 1 });
    expect(store.getSnapshot().queue).toHaveLength(1);
    expect(agent.chats).toEqual([]);
  });

  test("startPluginTurn always starts immediately", async () => {
    const { turns, store, agent } = makeCoordinator();

    const started = turns.startPluginTurn({
      pluginId: "test-plugin",
      runId: "run-started",
      text: "started plugin work",
      author: "Test Plugin",
    });
    await turns.waitForIdle();

    expect(started.status).toBe("started");
    expect(agent.chats).toEqual(["started plugin work"]);
    expect(store.getSnapshot().queue).toHaveLength(0);
  });

  test("plugin turn failure calls failure hook exactly once and drains queue", async () => {
    const failures: unknown[] = [];
    const plugin: SessionRuntimePlugin = {
      id: "test-plugin",
      version: "0.0.0",
      onTurnFailure: (event) => failures.push(event),
    };
    const agent = new FakeTurnAgent();
    const first = agent.nextChat();
    const { turns, store } = makeCoordinator({ agent, plugins: makePlugins([plugin]) });

    turns.startPluginTurn({
      pluginId: "test-plugin",
      runId: "run-fails",
      text: "plugin fails",
      author: "Test Plugin",
    });
    turns.submit({ source: "user", text: "next user turn" });
    first.reject(new Error("boom"));
    await turns.waitForIdle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      pluginTurn: { pluginId: "test-plugin", runId: "run-fails" },
      message: "boom",
      cancelled: false,
    });
    expect(agent.chats).toEqual(["plugin fails", "next user turn"]);
    expect(store.getSnapshot().turn.state).toBe("idle");
  });

  test("cancelActiveTurn during model execution asks the Agent to cancel", async () => {
    const agent = new FakeTurnAgent();
    agent.nextChat();
    const { turns } = makeCoordinator({ agent });

    const started = turns.submit({ source: "user", text: "long turn" });
    expect(started.status).toBe("started");
    const cancelled = await turns.cancelActiveTurn();

    expect(cancelled).toMatchObject({ status: "cancelling" });
    expect(agent.cancelCalls).toBe(1);
  });

  test("cancelActiveTurn during pending approval clears state and drains queue", async () => {
    const agent = new FakeTurnAgent();
    agent.nextChat();
    const { turns, store } = makeCoordinator({ agent });

    const started = turns.submit({ source: "user", text: "needs approval" });
    if (started.status !== "started") {
      throw new Error("expected approval cancellation test turn to start immediately");
    }
    const sourceApprovalId = "approval-source-cancel";
    turns.handleToolEvent(approvalRequestedEvent(sourceApprovalId));
    store.syncProviderApprovals("terminal", [approvalItem(sourceApprovalId, started.turnId)]);
    turns.submit({ source: "user", text: "after cancel" });

    const cancelled = await turns.cancelActiveTurn();
    await turns.waitForIdle();

    expect(cancelled).toMatchObject({ status: "cancelled", turnId: started.turnId });
    expect(agent.directRejections).toMatchObject([
      { id: sourceApprovalId, reason: "Turn cancelled by user." },
    ]);
    expect(agent.clearPendingApprovalCalls).toBe(1);
    expect(agent.chats).toEqual(["needs approval", "after cancel"]);
    expect(store.getSnapshot().turn.state).toBe("idle");
  });

  test("setApprovalMode(auto) auto-approves pending approval-capable items once", async () => {
    const { turns, store, agent, audit } = makeCoordinator();
    store.syncProviderApprovals("terminal", [
      {
        ...approvalItem("background-auto", "background-turn"),
        id: "background-auto-session-approval",
        turnId: undefined,
      },
    ]);

    turns.setApprovalMode("auto");
    await turns.waitForIdle();
    turns.scheduleAutoApprovals();
    await turns.waitForIdle();

    expect(agent.providerInvocations).toMatchObject([
      { providerId: "terminal", path: "/approvals/approval-source-1", action: "approve" },
    ]);
    expect(audit.filter((event) => event.kind === "auto_approval_error")).toHaveLength(0);
  });

  test("Session-native Plugin approvals execute directly without provider invocation", async () => {
    const { turns, store, agent } = makeCoordinator();
    let executions = 0;
    const requested = turns.requestPluginApproval("voice", {
      path: "/conversation",
      action: "start_listening",
      reason: "Streams microphone audio remotely.",
      dangerous: true,
      execute: () => {
        executions += 1;
        return { status: "started" };
      },
    });

    expect(store.getSnapshot().approvals[0]).toMatchObject({
      id: requested.approvalId,
      status: "pending",
      provider: "session-plugin:voice",
      path: "/conversation",
      action: "start_listening",
      canApprove: true,
      canReject: true,
    });

    const resolved = await turns.resolveApproval(requested.approvalId, "approve");

    expect(resolved.status).toBe("started");
    expect(executions).toBe(1);
    expect(agent.providerInvocations).toEqual([]);
    expect(store.getApproval(requested.approvalId)?.status).toBe("approved");
  });

  test("Session-native Plugin approvals reject and auto-approve with Session mode", async () => {
    const { turns, store } = makeCoordinator();
    let rejected = "";
    const manual = turns.requestPluginApproval("voice", {
      path: "/conversation",
      action: "start_listening",
      reason: "Manual consent.",
      execute: () => ({ status: "started" }),
      reject: (reason) => {
        rejected = reason ?? "rejected";
      },
    });
    await turns.resolveApproval(manual.approvalId, "reject", { reason: "No microphone." });
    expect(rejected).toBe("No microphone.");
    expect(store.getApproval(manual.approvalId)?.status).toBe("rejected");

    turns.setApprovalMode("auto");
    let autoExecutions = 0;
    const automatic = turns.requestPluginApproval("voice", {
      path: "/conversation",
      action: "start_listening",
      reason: "Auto consent.",
      execute: () => {
        autoExecutions += 1;
      },
    });
    await turns.waitForIdle();

    expect(autoExecutions).toBe(1);
    expect(store.getApproval(automatic.approvalId)?.status).toBe("approved");
  });

  test("Session-native explicit approvals are never resolved by auto mode", async () => {
    const { turns, store } = makeCoordinator();
    turns.setApprovalMode("auto");
    let executions = 0;
    const explicit = turns.requestPluginApproval("voice", {
      path: "/conversation",
      action: "start_listening",
      reason: "Explicit microphone egress consent.",
      autoApprovable: false,
      execute: () => {
        executions += 1;
      },
    });

    await turns.waitForIdle();

    expect(executions).toBe(0);
    expect(store.getApproval(explicit.approvalId)).toMatchObject({
      status: "pending",
      autoApprovable: false,
    });
  });
});

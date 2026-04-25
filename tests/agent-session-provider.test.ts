import { describe, expect, test } from "bun:test";
import type { ResultMessage } from "@slop-ai/consumer/browser";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import type { AgentCallbacks, ResolvedApprovalToolResult } from "../src/core/agent";
import type { ExternalProviderState } from "../src/core/consumer";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { LlmAbortError } from "../src/llm/types";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { AgentSessionProvider } from "../src/session/provider";
import type { SessionAgent, SessionAgentFactory } from "../src/session/runtime";
import { SessionRuntime } from "../src/session/runtime";

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultProfileId: "test-openai",
    profiles: [
      {
        id: "test-openai",
        label: "Test OpenAI",
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 12,
    contextBudgetTokens: 24000,
    minSalience: 0.2,
    overviewDepth: 2,
    overviewMaxNodes: 200,
    detailDepth: 4,
    detailMaxNodes: 200,
    historyTurns: 8,
    toolResultMaxChars: 16000,
  },
  maxToolResultSize: 4096,
  providers: {
    builtin: {
      terminal: false,
      filesystem: false,
      memory: false,
      skills: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
      orchestration: false,
      spec: false,
      vision: false,
    },
    discovery: {
      enabled: false,
      paths: [],
    },
    terminal: {
      cwd: ".",
      historyLimit: 10,
      syncTimeoutMs: 30000,
    },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: {
      maxMemories: 500,
      defaultWeight: 0.5,
      compactThreshold: 0.2,
    },
    skills: {
      skillsDir: "~/.hermes/skills",
    },
    web: {
      historyLimit: 20,
    },
    browser: {
      viewportWidth: 1280,
      viewportHeight: 720,
    },
    cron: {
      maxJobs: 50,
    },
    messaging: {
      maxMessages: 500,
    },
    delegation: {
      maxAgents: 10,
    },
    orchestration: {
      progressTailMaxChars: 2048,
    },
    vision: {
      maxImages: 50,
      defaultWidth: 512,
      defaultHeight: 512,
    },
  },
};

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private status: CredentialStoreStatus = "available",
    private secrets = new Map<string, string>(),
  ) {}

  async getStatus(): Promise<CredentialStoreStatus> {
    return this.status;
  }

  async get(profileId: string): Promise<string | null> {
    return this.secrets.get(profileId) ?? null;
  }

  async set(profileId: string, secret: string): Promise<void> {
    this.secrets.set(profileId, secret);
  }

  async delete(profileId: string): Promise<void> {
    this.secrets.delete(profileId);
  }
}

function createTestProfileManager(options?: {
  status?: CredentialStoreStatus;
  secrets?: Record<string, string>;
}): LlmProfileManager {
  return new LlmProfileManager({
    config: TEST_CONFIG,
    credentialStore: new MemoryCredentialStore(
      options?.status,
      new Map(Object.entries(options?.secrets ?? { "test-openai": "test-key" })),
    ),
    writeConfig: async () => undefined,
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createStreamingAgentFactory(): SessionAgentFactory {
  return (callbacks): SessionAgent => ({
    start: async () => undefined,
    chat: async (userMessage: string) => {
      callbacks.onText?.("Thinking...");
      callbacks.onToolEvent?.({
        kind: "started",
        invocation: {
          toolUseId: "tool-1",
          toolName: "filesystem__read",
          kind: "affordance",
          providerId: "filesystem",
          path: "/workspace",
          action: "read",
          params: { path: "README.md" },
        },
        summary: "filesystem:read /workspace",
      });
      callbacks.onToolEvent?.({
        kind: "completed",
        invocation: {
          toolUseId: "tool-1",
          toolName: "filesystem__read",
          kind: "affordance",
          providerId: "filesystem",
          path: "/workspace",
          action: "read",
          params: { path: "README.md" },
        },
        summary: "filesystem:read /workspace",
        status: "ok",
      });
      callbacks.onText?.("Done.");
      return {
        status: "completed",
        response: `Echo: ${userMessage}`,
      };
    },
    resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
    invokeProvider: async () => ({ type: "result", id: "inv-test", status: "ok" }),
    resolveApprovalDirect: async () => ({ type: "result", id: "inv-test", status: "ok" }),
    rejectApprovalDirect: () => undefined,
    cancelActiveTurn: () => false,
    clearPendingApproval: () => undefined,
    shutdown: () => undefined,
  });
}

function createBlockingAgentFactory(gate: Deferred<string>): SessionAgentFactory {
  return (): SessionAgent => ({
    start: async () => undefined,
    chat: async () => ({
      status: "completed",
      response: await gate.promise,
    }),
    resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
    invokeProvider: async () => ({ type: "result", id: "inv-test", status: "ok" }),
    resolveApprovalDirect: async () => ({ type: "result", id: "inv-test", status: "ok" }),
    rejectApprovalDirect: () => undefined,
    cancelActiveTurn: () => false,
    clearPendingApproval: () => undefined,
    shutdown: () => undefined,
  });
}

function createCancelableStreamingAgentFactory() {
  const gate = createDeferred<string>();
  let cancelled = false;

  const factory: SessionAgentFactory = (callbacks): SessionAgent => ({
    start: async () => undefined,
    chat: async () => {
      callbacks.onText?.("Thinking...");
      return {
        status: "completed",
        response: await gate.promise,
      };
    },
    resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
    invokeProvider: async () => ({ type: "result", id: "inv-cancel", status: "ok" }),
    resolveApprovalDirect: async () => ({ type: "result", id: "inv-cancel", status: "ok" }),
    rejectApprovalDirect: () => undefined,
    cancelActiveTurn: () => {
      if (cancelled) {
        return false;
      }

      cancelled = true;
      gate.reject(new LlmAbortError());
      return true;
    },
    clearPendingApproval: () => undefined,
    shutdown: () => undefined,
  });

  return {
    factory,
    resolve(response: string) {
      if (!cancelled) {
        gate.resolve(response);
      }
    },
  };
}

/**
 * Variant of the approval harness whose `chat()` fires the
 * `approval_requested` tool event but blocks resolution on a deferred gate.
 * This lets a test observe the window where SessionRuntime.pendingApproval
 * is set but agent.chat() has not yet unwound — the exact race the fast
 * approval fix targets.
 */
function createGatedApprovalHarnessFactory() {
  let callbacks: AgentCallbacks | null = null;
  const chatGate = createDeferred<void>();
  const approveCalls: string[] = [];
  const resumeCalls: ResolvedApprovalToolResult[] = [];
  let resumeResolved: () => void = () => undefined;
  const resumeStarted = new Promise<void>((resolve) => {
    resumeResolved = resolve;
  });

  const factory: SessionAgentFactory = (agentCallbacks): SessionAgent => {
    callbacks = agentCallbacks;
    return {
      start: async () => undefined,
      chat: async () => {
        callbacks?.onToolEvent?.({
          kind: "started",
          invocation: {
            toolUseId: "tool-gated",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
          summary: "terminal:execute /session",
        });
        callbacks?.onToolEvent?.({
          kind: "approval_requested",
          invocation: {
            toolUseId: "tool-gated",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
          summary: "terminal:execute /session",
          errorCode: "approval_required",
          errorMessage: "Approval required.",
          approvalId: "approval-gated",
        });
        await chatGate.promise;
        return {
          status: "waiting_approval",
          invocation: {
            toolUseId: "tool-gated",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
        };
      },
      resumeWithToolResult: async (resolved) => {
        resumeCalls.push(resolved);
        resumeResolved();
        return { status: "completed", response: "approved result" };
      },
      invokeProvider: async () => ({ type: "result", id: "inv-gated", status: "ok" }),
      resolveApprovalDirect: async (approvalId) => {
        approveCalls.push(approvalId);
        return { type: "result", id: "inv-gated", status: "ok", data: { ok: true } };
      },
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    };
  };

  return {
    factory,
    approveCalls,
    resumeCalls,
    resumeStarted,
    releaseChat() {
      chatGate.resolve(undefined);
    },
    emitApprovalSnapshot() {
      callbacks?.onProviderSnapshot?.({
        providerId: "terminal",
        path: "/approvals",
        tree: {
          id: "approvals",
          type: "collection",
          children: [
            {
              id: "approval-gated",
              type: "item",
              properties: {
                status: "pending",
                path: "/session",
                action: "execute",
                reason: "Approval required.",
                created_at: new Date().toISOString(),
                dangerous: true,
              },
              affordances: [{ action: "approve" }, { action: "reject" }],
            },
          ],
        },
      });
    },
  };
}

function createApprovalHarnessFactory(options?: { approveResult?: ResultMessage }) {
  let callbacks: AgentCallbacks | null = null;
  const providerInvokes: Array<{
    providerId: string;
    path: string;
    action: string;
    params?: Record<string, unknown>;
  }> = [];
  const approveCalls: string[] = [];
  const rejectCalls: Array<{ id: string; reason?: string }> = [];
  const resumeCalls: ResolvedApprovalToolResult[] = [];
  const approveResult: ResultMessage = options?.approveResult ?? {
    type: "result",
    id: "inv-approval",
    status: "ok",
    data: { ok: true },
  };

  const factory: SessionAgentFactory = (agentCallbacks): SessionAgent => {
    callbacks = agentCallbacks;
    return {
      start: async () => undefined,
      chat: async () => {
        callbacks?.onToolEvent?.({
          kind: "started",
          invocation: {
            toolUseId: "tool-approval",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
          summary: "terminal:execute /session",
        });
        callbacks?.onToolEvent?.({
          kind: "approval_requested",
          invocation: {
            toolUseId: "tool-approval",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
          summary: "terminal:execute /session",
          errorCode: "approval_required",
          errorMessage: "Approval required.",
          approvalId: "approval-1",
        });
        return {
          status: "waiting_approval",
          invocation: {
            toolUseId: "tool-approval",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
        };
      },
      resumeWithToolResult: async (resolved) => {
        resumeCalls.push(resolved);
        callbacks?.onToolEvent?.({
          kind: "completed",
          invocation: {
            toolUseId: "tool-approval",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "rm demo.txt", background: false },
          },
          summary: "terminal:execute /session",
          status: resolved.status,
          taskId: resolved.taskId,
        });
        return {
          status: "completed",
          response: "approved result",
        };
      },
      invokeProvider: async (providerId, path, action, params) => {
        providerInvokes.push({ providerId, path, action, params });
        return { type: "result", id: "inv-approval", status: "ok", data: { ok: true } };
      },
      resolveApprovalDirect: async (approvalId) => {
        approveCalls.push(approvalId);
        return approveResult;
      },
      rejectApprovalDirect: (approvalId, reason) => {
        rejectCalls.push({ id: approvalId, reason });
      },
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    };
  };

  return {
    factory,
    approveCalls,
    rejectCalls,
    resumeCalls,
    emitApprovalSnapshot() {
      callbacks?.onProviderSnapshot?.({
        providerId: "terminal",
        path: "/approvals",
        tree: {
          id: "approvals",
          type: "collection",
          children: [
            {
              id: "approval-1",
              type: "item",
              properties: {
                status: "pending",
                path: "/session",
                action: "execute",
                reason: "Approval required.",
                created_at: new Date().toISOString(),
                dangerous: true,
              },
              affordances: [{ action: "approve" }, { action: "reject" }],
            },
          ],
        },
      });
    },
    providerInvokes,
  };
}

function createTaskMirrorHarnessFactory() {
  let callbacks: AgentCallbacks | null = null;

  const factory: SessionAgentFactory = (agentCallbacks): SessionAgent => {
    callbacks = agentCallbacks;
    return {
      start: async () => undefined,
      chat: async () => {
        callbacks?.onToolEvent?.({
          kind: "started",
          invocation: {
            toolUseId: "tool-task",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "bun test", background: true },
          },
          summary: "terminal:execute /session",
        });
        callbacks?.onToolEvent?.({
          kind: "completed",
          invocation: {
            toolUseId: "tool-task",
            toolName: "terminal__execute",
            kind: "affordance",
            providerId: "terminal",
            path: "/session",
            action: "execute",
            params: { command: "bun test", background: true },
          },
          summary: "terminal:execute /session",
          status: "accepted",
          taskId: "task-123",
        });
        return {
          status: "completed",
          response: "task started",
        };
      },
      resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
      invokeProvider: async () => ({ type: "result", id: "inv-task", status: "ok" }),
      resolveApprovalDirect: async () => ({ type: "result", id: "inv-task", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    };
  };

  return {
    factory,
    emitTaskSnapshot() {
      callbacks?.onProviderSnapshot?.({
        providerId: "terminal",
        path: "/tasks",
        tree: {
          id: "tasks",
          type: "collection",
          children: [
            {
              id: "task-123",
              type: "item",
              properties: {
                status: "running",
                provider_task_id: "task-123",
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                message: "Running tests",
              },
              affordances: [{ action: "cancel" }],
            },
          ],
        },
      });
    },
  };
}

function createAppMirrorHarnessFactory() {
  let callbacks: AgentCallbacks | null = null;

  const factory: SessionAgentFactory = (agentCallbacks): SessionAgent => {
    callbacks = agentCallbacks;
    return {
      start: async () => undefined,
      chat: async () => ({
        status: "completed",
        response: "apps updated",
      }),
      resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
      invokeProvider: async () => ({ type: "result", id: "inv-apps", status: "ok" }),
      resolveApprovalDirect: async () => ({ type: "result", id: "inv-apps", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    };
  };

  return {
    factory,
    emitApps(states: ExternalProviderState[]) {
      callbacks?.onExternalProviderStates?.(states);
    },
    emitTaskSnapshot(providerId: string) {
      callbacks?.onProviderSnapshot?.({
        providerId,
        path: "/tasks",
        tree: {
          id: "tasks",
          type: "collection",
          children: [
            {
              id: "task-1",
              type: "item",
              properties: {
                status: "running",
                provider_task_id: "task-1",
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                message: "Syncing native state",
              },
            },
          ],
        },
      });
    },
  };
}

describe("AgentSessionProvider", () => {
  test("session starts without credentials and exposes LLM onboarding state", async () => {
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-onboarding",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager({ secrets: {} }),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-onboarding",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const llm = await consumer.query("/llm", 3);
      expect(llm.properties?.status).toBe("needs_credentials");
      expect(llm.properties?.active_profile_id).toBe("test-openai");
      expect(llm.children?.[0]?.properties?.ready).toBe(false);

      const composer = await consumer.query("/composer", 2);
      expect(
        composer.affordances?.some((affordance) => affordance.action === "send_message") ?? false,
      ).toBe(false);
      expect(composer.properties?.disabled_reason).toBeTruthy();
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("send_message updates transcript, activity, and turn state", async () => {
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-test",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-test",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const invokeResult = await consumer.invoke("/composer", "send_message", {
        text: "hello session",
      });
      expect(invokeResult.status).toBe("ok");

      await runtime.waitForIdle();

      const transcript = await consumer.query("/transcript", 5);
      expect(transcript.children?.map((child) => child.id)).toEqual([
        expect.stringMatching(/^msg-/),
        expect.stringMatching(/^msg-/),
      ]);
      expect(transcript.children?.[0]?.properties?.role).toBe("user");
      expect(transcript.children?.[1]?.properties?.role).toBe("assistant");
      expect(transcript.children?.[1]?.children?.[0]?.id).toBe("content");

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");

      const activity = await consumer.query("/activity", 2);
      const kinds = activity.children?.map((child) => child.properties?.kind);
      expect(kinds).toContain("model_call");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_result");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("runtime rejects a second message while a turn is already active", async () => {
    const gate = createDeferred<string>();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-blocking",
      agentFactory: createBlockingAgentFactory(gate),
      llmProfileManager: createTestProfileManager(),
    });

    try {
      await runtime.sendMessage("first");
      await expect(runtime.sendMessage("second")).rejects.toThrow(
        "A turn is already running for this session.",
      );

      gate.resolve("done");
      await runtime.waitForIdle();
    } finally {
      runtime.shutdown();
    }
  });

  test("cancel_turn aborts an active model turn and preserves partial text", async () => {
    const harness = createCancelableStreamingAgentFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-cancel-running",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-cancel-running",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "start then cancel",
      });

      const cancelResult = await consumer.invoke("/turn", "cancel_turn", {});
      expect(cancelResult.status).toBe("ok");

      await runtime.waitForIdle();

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
      expect(turn.properties?.message).toBe("Turn cancelled by user.");
      expect(
        turn.affordances?.some((affordance) => affordance.action === "cancel_turn") ?? false,
      ).toBe(false);

      const transcript = await consumer.query("/transcript", 5);
      expect(transcript.children?.[1]?.properties?.role).toBe("assistant");
      expect(transcript.children?.[1]?.properties?.state).toBe("complete");
      expect(transcript.children?.[1]?.children?.[0]?.children?.[0]?.properties?.text).toBe(
        "Thinking...",
      );

      const activity = await consumer.query("/activity", 3);
      expect(activity.children?.[0]?.properties?.kind).toBe("model_call");
      expect(activity.children?.[0]?.properties?.status).toBe("cancelled");
    } finally {
      harness.resolve("finished");
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session mirrors provider approvals and forwards approve", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "remove the file",
      });
      harness.emitApprovalSnapshot();

      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.length).toBe(1);
      expect(approvals.children?.[0]?.properties?.status).toBe("pending");

      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      await runtime.waitForIdle();

      // Session resume now resolves approvals through the hub-owned queue
      // directly (Agent.resolveApprovalDirect) rather than re-invoking the
      // provider's `/approvals/{id}.approve` action. This avoids
      // double-wrapping the inner ResultMessage.
      expect(harness.approveCalls).toEqual(["approval-1"]);

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("async-approved action surfaces task_id to the resumed turn", async () => {
    // Regression: previously the session resume path went through
    // `agent.invokeProvider("/approvals/{id}", "approve")`. The provider
    // action returned the queue's inner ResultMessage, which the SLOP server
    // then wrapped a second time as `data` of an outer `{status:"ok"}`
    // ResultMessage. The runtime read `result.status` and `result.data.taskId`
    // off the outer wrapper, so an async-approved action with
    // `{status:"accepted", data:{taskId:"task-123"}}` was visible to the
    // session as `status:"ok"` with no task identity, breaking task mirroring.
    //
    // The fix routes session resume through `Agent.resolveApprovalDirect`
    // (i.e. `hub.approvals.approve(id)`) so the inner ResultMessage is passed
    // through unchanged.
    const harness = createApprovalHarnessFactory({
      approveResult: {
        type: "result",
        id: "inv-approval-async",
        status: "accepted",
        data: { taskId: "task-123" },
      },
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-approval-async",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-approval-async",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "kick off a long job",
      });
      harness.emitApprovalSnapshot();

      const approvals = await consumer.query("/approvals", 3);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      await runtime.waitForIdle();

      // Direct queue path was used (not the per-provider /approvals action).
      expect(harness.approveCalls).toEqual(["approval-1"]);

      // The inner ResultMessage flows through to the resumed turn; the
      // session sees the underlying `accepted` status and the `task_id`.
      expect(harness.resumeCalls.length).toBe(1);
      const resumed = harness.resumeCalls[0]!;
      expect(resumed.status).toBe("accepted");
      expect(resumed.taskId).toBe("task-123");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("cancel_turn rejects a pending approval turn without resuming the model", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-cancel-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-cancel-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "remove the file later",
      });
      harness.emitApprovalSnapshot();

      const cancelResult = await consumer.invoke("/turn", "cancel_turn", {});
      expect(cancelResult.status).toBe("ok");

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
      expect(turn.properties?.message).toBe("Turn cancelled by user.");

      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.[0]?.properties?.status).toBe("rejected");

      expect(harness.rejectCalls).toEqual([
        { id: "approval-1", reason: "Turn cancelled by user." },
      ]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session mirrors provider tasks after accepted tool results", async () => {
    const harness = createTaskMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-tasks",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-tasks",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "run tests in background",
      });
      harness.emitTaskSnapshot();

      const tasks = await consumer.query("/tasks", 3);
      expect(tasks.children?.length).toBe(1);
      expect(tasks.children?.[0]?.properties?.provider_task_id).toBe("task-123");
      expect(tasks.children?.[0]?.properties?.status).toBe("running");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session exposes external apps and clears mirrored state when one disconnects", async () => {
    const harness = createAppMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-apps",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-apps",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApps([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/native-demo.sock",
          status: "connected",
        },
      ]);
      harness.emitTaskSnapshot("native-demo");

      const apps = await consumer.query("/apps", 3);
      expect(apps.children?.length).toBe(1);
      expect(apps.children?.[0]?.id).toBe("native-demo");
      expect(apps.children?.[0]?.properties?.status).toBe("connected");
      expect(apps.children?.[0]?.properties?.transport).toBe("unix:/tmp/native-demo.sock");

      const tasks = await consumer.query("/tasks", 3);
      expect(tasks.children?.length).toBe(1);

      harness.emitApps([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/native-demo.sock",
          status: "disconnected",
          lastError: "Provider disconnected.",
        },
      ]);

      const appsAfterDisconnect = await consumer.query("/apps", 3);
      expect(appsAfterDisconnect.children?.[0]?.properties?.status).toBe("disconnected");
      expect(appsAfterDisconnect.children?.[0]?.properties?.last_error).toBe(
        "Provider disconnected.",
      );

      const tasksAfterDisconnect = await consumer.query("/tasks", 3);
      expect(tasksAfterDisconnect.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("approveApproval waits for the suspended turn to unwind before resuming", async () => {
    // Regression: the `approval_requested` tool event fires synchronously
    // inside agent.chat(); a fast approver could call approveApproval()
    // before chat() resolved, leaving activeRunAbortController set when
    // resumeTurn started — surfacing as "Agent is already executing a model
    // turn." The fix awaits activeTurnPromise (only when this approval is
    // what the current turn is blocked on) before resolving the hub
    // approval and starting the resume.
    const harness = createGatedApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-fast-approve",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });

    try {
      await runtime.start();
      await runtime.sendMessage("rm demo.txt");

      // chat() has fired the approval_requested event (so pendingApproval
      // is set) but is parked on the gate — agent.chat() has NOT unwound
      // yet, mirroring the race window.
      harness.emitApprovalSnapshot();
      const snapshot = runtime.store.getSnapshot();
      const pending = snapshot.approvals.find((item) => item.status === "pending");
      expect(pending).toBeDefined();
      const approvalId = pending?.id ?? "";

      // Kick off approveApproval. It should block on activeTurnPromise
      // rather than synchronously calling resolveApprovalDirect.
      const approvePromise = runtime.approveApproval(approvalId);

      // Yield a few microtasks; the gate is still closed, so the hub
      // approval must NOT have been resolved yet.
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.approveCalls).toEqual([]);

      // Release chat() — it returns waiting_approval, the runTurn promise
      // unwinds, then approveApproval proceeds.
      harness.releaseChat();

      const result = await approvePromise;
      expect(result.status).toBe("ok");
      expect(harness.approveCalls).toEqual(["approval-gated"]);

      await harness.resumeStarted;
      await runtime.waitForIdle();

      expect(harness.resumeCalls).toHaveLength(1);
      expect(harness.resumeCalls[0]?.status).toBe("ok");
    } finally {
      runtime.shutdown();
    }
  });
});

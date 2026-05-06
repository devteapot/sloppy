import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultMessage } from "@slop-ai/consumer/browser";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import type { AgentCallbacks, ResolvedApprovalToolResult } from "../src/core/agent";
import type { ExternalProviderState } from "../src/core/consumer";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import {
  LlmAbortError,
  type LlmAdapter,
  type LlmChatOptions,
  type LlmResponse,
} from "../src/llm/types";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { AgentSessionProvider } from "../src/session/provider";
import type { SessionAgent, SessionAgentFactory } from "../src/session/runtime";
import { SessionRuntime } from "../src/session/runtime";
import { SessionStore } from "../src/session/store";

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
      metaRuntime: false,
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
      skillsDir: "~/.sloppy/skills",
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
    metaRuntime: { globalRoot: "~/.sloppy/meta-runtime", workspaceRoot: ".sloppy/meta-runtime" },
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

function createQueuedTurnHarnessFactory() {
  const gates = [createDeferred<string>(), createDeferred<string>()];
  const messages: string[] = [];

  const factory: SessionAgentFactory = (): SessionAgent => ({
    start: async () => undefined,
    chat: async (userMessage: string) => {
      const index = messages.length;
      messages.push(userMessage);
      return {
        status: "completed",
        response: await (gates[index] ?? gates[gates.length - 1]!).promise,
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

  return {
    factory,
    messages,
    resolve(index: number, response: string) {
      gates[index]?.resolve(response);
    },
  };
}

function createQueuedGoalHarnessFactory() {
  const gates = [createDeferred<string>(), createDeferred<string>(), createDeferred<string>()];
  const messages: string[] = [];

  const factory: SessionAgentFactory = (): SessionAgent => ({
    start: async () => undefined,
    chat: async (userMessage: string) => {
      const index = messages.length;
      messages.push(userMessage);
      return {
        status: "completed",
        response: await (gates[index] ?? gates[gates.length - 1]!).promise,
        usage:
          index === 0
            ? { inputTokens: 100, outputTokens: 50 }
            : { inputTokens: 10, outputTokens: 5 },
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

  return {
    factory,
    messages,
    resolve(index: number, response: string) {
      gates[index]?.resolve(response);
    },
  };
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

function createNoToolGoalHarnessFactory() {
  const messages: string[] = [];
  const factory: SessionAgentFactory = (): SessionAgent => ({
    start: async () => undefined,
    chat: async (userMessage: string) => {
      messages.push(userMessage);
      return {
        status: "completed",
        response: `goal turn ${messages.length}`,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      };
    },
    resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
    invokeProvider: async () => ({ type: "result", id: "inv-goal", status: "ok" }),
    resolveApprovalDirect: async () => ({ type: "result", id: "inv-goal", status: "ok" }),
    rejectApprovalDirect: () => undefined,
    cancelActiveTurn: () => false,
    clearPendingApproval: () => undefined,
    shutdown: () => undefined,
  });

  return { factory, messages };
}

class GoalReportingLlm implements LlmAdapter {
  calls = 0;
  observedToolNames: string[] = [];
  seenToolNames = new Set<string>();
  observedToolResult = "";

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.calls += 1;
    this.observedToolNames = options.tools?.map((tool) => tool.function.name) ?? [];
    for (const name of this.observedToolNames) {
      this.seenToolNames.add(name);
    }
    if (this.calls === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: "goal-report-1",
            name: "slop_goal_update",
            input: {
              status: "complete",
              message: "Goal is verified complete.",
              evidence: ["tests passed", "audit log captured"],
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 11, outputTokens: 7 },
      };
    }

    this.observedToolResult = JSON.stringify(options.messages);
    return {
      content: [{ type: "text", text: "Goal is verified complete." }],
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }
}

class StaleGoalUpdateLlm implements LlmAdapter {
  private firstCallGate = createDeferred<void>();
  calls = 0;
  observedToolResult = "";

  releaseFirstCall(): void {
    this.firstCallGate.resolve();
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      await this.firstCallGate.promise;
      return {
        content: [
          {
            type: "tool_use",
            id: "stale-goal-report",
            name: "slop_goal_update",
            input: {
              status: "complete",
              message: "This stale turn should not complete the replacement goal.",
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 11, outputTokens: 7 },
      };
    }

    if (this.calls === 2) {
      this.observedToolResult = JSON.stringify(options.messages);
      return {
        content: [{ type: "text", text: "Stale goal update was rejected." }],
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    }

    return {
      content: [{ type: "text", text: `Goal B turn ${this.calls}.` }],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 1 },
    };
  }
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
    emitApprovalSnapshot(options?: {
      providerId?: string;
      approvalId?: string;
      approvalProvider?: string;
      path?: string;
      action?: string;
      reason?: string;
      mirrorLineage?: string[];
    }) {
      callbacks?.onProviderSnapshot?.({
        providerId: options?.providerId ?? "terminal",
        path: "/approvals",
        tree: {
          id: "approvals",
          type: "collection",
          children: [
            {
              id: options?.approvalId ?? "approval-1",
              type: "item",
              properties: {
                status: "pending",
                provider: options?.approvalProvider,
                path: options?.path ?? "/session",
                action: options?.action ?? "execute",
                reason: options?.reason ?? "Approval required.",
                created_at: new Date().toISOString(),
                dangerous: true,
                mirror_lineage: options?.mirrorLineage,
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
  const retries: string[] = [];

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
      retryProvider: async (providerId) => {
        retries.push(providerId);
        callbacks?.onExternalProviderStates?.([
          {
            id: providerId,
            name: "Native Demo",
            transport: "unix:/tmp/native-demo.sock",
            status: "connected",
          },
        ]);
        return true;
      },
      resolveApprovalDirect: async () => ({ type: "result", id: "inv-apps", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    };
  };

  return {
    factory,
    retries,
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

  test("exposes persistent goal controls and pauses continuation after no tool activity", async () => {
    const harness = createNoToolGoalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      let goal = await consumer.query("/goal", 1);
      expect(goal.properties?.exists).toBe(false);
      expect(goal.affordances?.some((affordance) => affordance.action === "create_goal")).toBe(
        true,
      );

      const result = await consumer.invoke("/goal", "create_goal", {
        objective: "verify the goal loop",
        token_budget: 1000,
      });
      expect(result.status).toBe("ok");

      await runtime.waitForIdle();
      goal = await consumer.query("/goal", 1);
      expect(goal.properties?.exists).toBe(true);
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.objective).toBe("verify the goal loop");
      expect(goal.properties?.total_tokens).toBe(30);
      expect(goal.properties?.continuation_count).toBe(1);
      expect(harness.messages).toHaveLength(2);
      expect(harness.messages[1]).toContain("Continue the active persistent session goal");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("queued goal creation does not account the already-running user turn", async () => {
    const harness = createQueuedGoalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal-queued-accounting",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal-queued-accounting",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const userTurn = await consumer.invoke("/composer", "send_message", {
        text: "unrelated user turn",
      });
      expect(userTurn.status).toBe("ok");

      const goalStart = await consumer.invoke("/goal", "create_goal", {
        objective: "queued goal should own its own accounting",
      });
      expect(goalStart.status).toBe("ok");
      expect((goalStart.data as { status?: string }).status).toBe("queued");

      let queue = await consumer.query("/queue", 2);
      expect(queue.children?.[0]?.properties?.author).toBe("goal");
      expect(queue.children?.[0]?.properties?.goal_id).toEqual(expect.any(String));

      harness.resolve(0, "unrelated done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.messages[0]).toBe("unrelated user turn");
      expect(harness.messages[1]).toContain("Start working toward this persistent session goal");

      harness.resolve(1, "goal start done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.messages[2]).toContain("Continue the active persistent session goal");

      harness.resolve(2, "goal continuation done");
      await runtime.waitForIdle();

      const goal = await consumer.query("/goal", 1);
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.total_tokens).toBe(30);
      expect(goal.properties?.continuation_count).toBe(1);

      queue = await consumer.query("/queue", 2);
      expect(queue.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("native goal turns expose a model-owned goal update tool with evidence", async () => {
    const llm = new GoalReportingLlm();
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.createAdapter = async () => llm;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal-model-update",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal-model-update",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/goal", "create_goal", {
        objective: "verify model-owned completion",
      });
      expect(result.status).toBe("ok");

      await runtime.waitForIdle();

      const goal = await consumer.query("/goal", 1);
      expect([...llm.seenToolNames]).toContain("slop_goal_update");
      expect(llm.observedToolResult).toContain("Goal is verified complete.");
      expect(goal.properties?.status).toBe("complete");
      expect(goal.properties?.update_source).toBe("model");
      expect(goal.properties?.completion_source).toBe("model");
      expect(goal.properties?.evidence).toEqual(["tests passed", "audit log captured"]);
      expect(goal.properties?.total_tokens).toBe(23);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("stale slop_goal_update cannot mutate a replacement goal", async () => {
    const llm = new StaleGoalUpdateLlm();
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.createAdapter = async () => llm;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal-stale-update",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal-stale-update",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const first = await consumer.invoke("/goal", "create_goal", {
        objective: "goal A",
      });
      expect(first.status).toBe("ok");
      expect((first.data as { status?: string }).status).toBe("started");

      const replacement = await consumer.invoke("/goal", "create_goal", {
        objective: "goal B",
      });
      expect(replacement.status).toBe("ok");
      expect((replacement.data as { status?: string }).status).toBe("queued");

      llm.releaseFirstCall();
      await runtime.waitForIdle();

      const goal = await consumer.query("/goal", 1);
      expect(llm.observedToolResult).toContain("goal_mismatch");
      expect(goal.properties?.objective).toBe("goal B");
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.completion_source).toBeUndefined();
      expect(goal.properties?.message).not.toContain("stale turn");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session marks provider and agent config changes as restart-required", async () => {
    const changedConfig: SloppyConfig = {
      ...TEST_CONFIG,
      providers: {
        ...TEST_CONFIG.providers,
        builtin: {
          ...TEST_CONFIG.providers.builtin,
          terminal: true,
        },
      },
    };
    const readyState = {
      status: "ready" as const,
      message: "ready",
      activeProfileId: "test-openai",
      selectedProvider: "openai",
      selectedModel: "gpt-5.4",
      secureStoreKind: "memory",
      secureStoreStatus: "available" as const,
      profiles: [
        {
          id: "test-openai",
          label: "Test OpenAI",
          provider: "openai",
          model: "gpt-5.4",
          apiKeyEnv: "OPENAI_API_KEY",
          isDefault: true,
          hasKey: true,
          keySource: "env" as const,
          ready: true,
          managed: true,
          origin: "managed" as const,
          canDeleteProfile: false,
          canDeleteApiKey: false,
        },
      ],
    };
    const llmProfileManager = {
      getState: async () => readyState,
      ensureReady: async () => readyState,
      getConfig: () => changedConfig,
      updateConfig: () => undefined,
      createAdapter: async () => {
        throw new Error("not used");
      },
    } as unknown as LlmProfileManager;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-restart-required",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-restart-required",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const session = await consumer.query("/session", 1);
      expect(session.properties?.config_requires_restart).toBe(true);
      expect(session.properties?.config_restart_reason).toContain("Runtime provider or agent");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session recovers persisted stale turns at the public provider boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-runtime-recover-"));
    const persistencePath = join(root, "session.json");
    const seeded = new SessionStore({
      sessionId: "sess-runtime-recover",
      modelProvider: "openai",
      model: "gpt-5.4",
      workspaceRoot: root,
      persistencePath,
    });
    seeded.createGoal({
      objective: "recover runtime state",
      message: "Goal active before restart.",
    });
    const queued = seeded.enqueueMessage("queued before restart");
    const turnId = seeded.beginTurn("blocked before restart");
    seeded.appendAssistantText(turnId, "partial answer");
    seeded.recordApprovalRequested(turnId, {
      toolUseId: "tool-recover",
      summary: "terminal:execute /session",
      provider: "terminal",
      path: "/session",
      action: "execute",
      reason: "Needs approval",
    });
    seeded.syncProviderApprovals("terminal", [
      {
        id: "approval-recover",
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
    seeded.syncProviderTasks("terminal", [
      {
        id: "task-recover",
        status: "running",
        provider: "terminal",
        providerTaskId: "provider-task-recover",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "Still running before restart",
        turnId,
        canCancel: true,
      },
    ]);

    const harness = createNoToolGoalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-runtime-recover",
      sessionPersistencePath: persistencePath,
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-runtime-recover",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const session = await consumer.query("/session", 1);
      expect(session.properties?.recovered_after_restart).toBe(true);
      expect(session.properties?.last_error).toContain("could not be resumed");

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("error");
      expect(turn.properties?.waiting_on).toBeNull();
      expect(
        turn.affordances?.some((affordance) => affordance.action === "cancel_turn") ?? false,
      ).toBe(false);

      const goal = await consumer.query("/goal", 1);
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.message).toContain("process restart");
      expect(goal.properties?.update_source).toBe("runtime");

      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.[0]?.properties?.status).toBe("expired");
      expect(approvals.children?.[0]?.affordances ?? []).toHaveLength(0);

      const tasks = await consumer.query("/tasks", 3);
      expect(tasks.children?.[0]?.properties?.status).toBe("superseded");
      expect(tasks.children?.[0]?.properties?.error).toContain("could not be resumed");
      expect(tasks.children?.[0]?.affordances ?? []).toHaveLength(0);

      const queue = await consumer.query("/queue", 2);
      expect(queue.children?.[0]?.id).toBe(queued.id);
      expect(queue.children?.[0]?.properties?.text).toBe("queued before restart");

      const cancelQueued = await consumer.invoke(`/queue/${queued.id}`, "cancel", {});
      expect(cancelQueued.status).toBe("ok");

      const send = await consumer.invoke("/composer", "send_message", {
        text: "fresh after restart",
      });
      expect(send.status).toBe("ok");
      await runtime.waitForIdle();

      const recoveredTurn = await consumer.query("/turn", 1);
      expect(recoveredTurn.properties?.state).toBe("idle");
      expect(harness.messages[0]).toBe("fresh after restart");
    } finally {
      provider.stop();
      runtime.shutdown();
      await rm(root, { recursive: true, force: true });
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

  test("session runtime writes durable turn lifecycle audit events", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-audit-"));
    const logPath = join(root, "events.jsonl");
    const previousEventLog = process.env.SLOPPY_EVENT_LOG;
    process.env.SLOPPY_EVENT_LOG = logPath;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-audit",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager(),
      actorId: "agent-audit",
      actorName: "Audit Agent",
    });

    try {
      await runtime.start();
      const result = await runtime.sendMessage("audit this turn");
      if (result.status !== "started") {
        throw new Error(`Expected started turn, got ${result.status}`);
      }
      await runtime.waitForIdle();

      const records = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; [key: string]: unknown });
      expect(records.map((record) => record.kind)).toContain("turn_started");
      expect(records.map((record) => record.kind)).toContain("turn_completed");
      expect(records.map((record) => record.kind)).toContain("tool_started");
      expect(records.map((record) => record.kind)).toContain("tool_completed");
      const turnStarted = records.find((record) => record.kind === "turn_started");
      const turnCompleted = records.find((record) => record.kind === "turn_completed");
      expect(turnStarted?.turnId).toBe(result.turnId);
      expect(turnStarted?.actor).toMatchObject({ id: "agent-audit", name: "Audit Agent" });
      expect(turnCompleted?.turnId).toBe(result.turnId);
    } finally {
      runtime.shutdown();
      if (previousEventLog === undefined) {
        delete process.env.SLOPPY_EVENT_LOG;
      } else {
        process.env.SLOPPY_EVENT_LOG = previousEventLog;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("send_message during an active turn queues and drains FIFO", async () => {
    const harness = createQueuedTurnHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-blocking",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-queue",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const first = await consumer.invoke("/composer", "send_message", { text: "first" });
      expect(first.status).toBe("ok");
      expect((first.data as { status?: string }).status).toBe("started");

      const second = await consumer.invoke("/composer", "send_message", { text: "second" });
      expect(second.status).toBe("ok");
      expect((second.data as { status?: string }).status).toBe("queued");
      expect((second.data as { position?: number }).position).toBe(1);

      let queue = await consumer.query("/queue", 2);
      expect(queue.properties?.count).toBe(1);
      expect(queue.children?.[0]?.properties?.text).toBe("second");
      expect(
        queue.children?.[0]?.affordances?.some((affordance) => affordance.action === "cancel") ??
          false,
      ).toBe(true);

      harness.resolve(0, "first done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.messages).toEqual(["first", "second"]);

      queue = await consumer.query("/queue", 2);
      expect(queue.properties?.count).toBe(0);

      harness.resolve(1, "second done");
      await runtime.waitForIdle();

      const transcript = await consumer.query("/transcript", 5);
      expect(
        transcript.children
          ?.filter((child) => child.properties?.role === "user")
          .map((child) => child.children?.[0]?.children?.[0]?.properties?.text),
      ).toEqual(["first", "second"]);
      expect(
        transcript.children
          ?.filter((child) => child.properties?.role === "assistant")
          .map((child) => child.children?.[0]?.children?.[0]?.properties?.text),
      ).toEqual(["first done", "second done"]);
    } finally {
      provider.stop();
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

  test("session forwards non-turn mirrored approval actions to the source provider", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-forward-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-forward-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApprovalSnapshot({
        providerId: "sloppy-session-child",
        approvalId: "approval-child",
        approvalProvider: "skills",
        path: "/skills/dual-model-development-loop",
        action: "skill_manage",
        reason: "Skill write requires approval.",
        mirrorLineage: ["skills"],
      });

      const approvals = await consumer.query("/approvals", 3);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      expect(harness.approveCalls).toEqual([]);
      expect(harness.providerInvokes).toEqual([
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child",
          action: "approve",
          params: undefined,
        },
      ]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session forwards non-turn mirrored approval rejections to the source provider", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-forward-reject",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-forward-reject",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApprovalSnapshot({
        providerId: "sloppy-session-child",
        approvalId: "approval-child",
        approvalProvider: "skills",
        path: "/skills/dual-model-development-loop",
        action: "skill_manage",
        reason: "Skill write requires approval.",
        mirrorLineage: ["skills"],
      });

      const approvals = await consumer.query("/approvals", 3);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const rejectResult = await consumer.invoke(`/approvals/${approvalId}`, "reject", {
        reason: "not now",
      });
      expect(rejectResult.status).toBe("ok");

      expect(harness.rejectCalls).toEqual([]);
      expect(harness.providerInvokes).toEqual([
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child",
          action: "reject",
          params: { reason: "not now" },
        },
      ]);
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

  test("session apps surface retries for disconnected external providers", async () => {
    const harness = createAppMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-app-retry",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-app-retry",
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
          status: "error",
          lastError: "Connection refused.",
        },
      ]);

      const apps = await consumer.query("/apps", 2);
      expect(
        apps.affordances?.some((affordance) => affordance.action === "reconnect_provider"),
      ).toBe(true);

      const retry = await consumer.invoke("/apps", "reconnect_provider", {
        provider_id: "native-demo",
      });
      expect(retry.status).toBe("ok");
      expect(retry.data).toEqual({ providerId: "native-demo", connected: true });
      expect(harness.retries).toEqual(["native-demo"]);

      const appsAfterRetry = await consumer.query("/apps", 2);
      expect(appsAfterRetry.children?.[0]?.properties?.status).toBe("connected");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session apps surface proxies built-in provider state queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-meta-proxy-"));
    const config: SloppyConfig = {
      ...TEST_CONFIG,
      providers: {
        ...TEST_CONFIG.providers,
        builtin: {
          ...TEST_CONFIG.providers.builtin,
          metaRuntime: true,
        },
        metaRuntime: {
          globalRoot: join(root, "global"),
          workspaceRoot: join(root, "workspace"),
        },
      },
    };
    const runtime = new SessionRuntime({
      config,
      sessionId: "sess-meta-proxy",
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-meta-proxy",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const apps = await consumer.query("/apps", 1);
      expect(apps.affordances?.some((affordance) => affordance.action === "query_provider")).toBe(
        true,
      );

      const result = await consumer.invoke("/apps", "query_provider", {
        provider_id: "meta-runtime",
        path: "/proposals",
        depth: 1,
      });

      expect(result.status).toBe("ok");
      expect((result.data as { id?: string }).id).toBe("proposals");
    } finally {
      provider.stop();
      runtime.shutdown();
      await rm(root, { recursive: true, force: true });
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

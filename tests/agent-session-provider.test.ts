import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultMessage } from "@slop-ai/consumer/browser";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import type { AgentCallbacks, ResolvedApprovalToolResult } from "../src/core/agent";
import type { ExternalProviderState } from "../src/core/consumer";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { LlmAbortError } from "../src/llm/types";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { OrchestrationProvider } from "../src/providers/builtin/orchestration";
import { SpecProvider } from "../src/providers/builtin/spec";
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
      finalAuditCommandTimeoutMs: 30000,
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

type GateSnapshot = {
  id: string;
  status: "open" | "accepted" | "rejected" | "cancelled";
  gate_type: string;
  summary: string;
  subject_ref?: string;
  evidence_refs?: string[];
  created_at?: string;
  version?: number;
  resolve?: boolean;
};

function createOrchestrationMirrorHarnessFactory() {
  let callbacks: AgentCallbacks | null = null;
  const providerInvokes: Array<{
    providerId: string;
    path: string;
    action: string;
    params?: Record<string, unknown>;
  }> = [];

  const factory: SessionAgentFactory = (agentCallbacks): SessionAgent => {
    callbacks = agentCallbacks;
    return {
      start: async () => undefined,
      chat: async () => ({
        status: "completed",
        response: "orchestration updated",
      }),
      resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
      invokeProvider: async (providerId, path, action, params) => {
        providerInvokes.push({ providerId, path, action, params });
        return { type: "result", id: "inv-orch", status: "ok" };
      },
      resolveApprovalDirect: async () => ({ type: "result", id: "inv-orch", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    };
  };

  return {
    factory,
    providerInvokes,
    emitSnapshots(gates?: GateSnapshot[]) {
      const gateSnapshots: GateSnapshot[] = gates ?? [
        {
          id: "gate-1",
          status: "accepted",
          gate_type: "plan_accept",
          summary: "Accepted plan.",
          created_at: "2026-01-01T00:00:00.000Z",
          version: 2,
        },
        {
          id: "gate-2",
          status: "open",
          gate_type: "slice_gate",
          subject_ref: "slice:parser",
          summary: "Review parser evidence.",
          evidence_refs: ["evidence:parser"],
          created_at: "2026-01-01T00:01:00.000Z",
          version: 7,
          resolve: true,
        },
      ];
      callbacks?.onProviderSnapshot?.({
        providerId: "orchestration",
        path: "/orchestration",
        tree: {
          id: "orchestration",
          type: "context",
          properties: {
            plan_id: "plan-1",
            plan_status: "active",
            plan_version: 3,
            task_counts: {
              scheduled: 1,
              running: 1,
              verifying: 1,
              completed: 2,
              failed: 1,
            },
            drift_metrics: {
              progress: {
                criteria_total: 6,
                criteria_satisfied: 4,
                criteria_unknown: 2,
                prior_distance: 3,
                current_distance: 2,
                velocity: 1,
              },
              coherence: {
                replan_count: 1,
                spec_revision_count: 1,
                question_density: 2,
                failure_count: 1,
                thresholds: { question_density_limit: 3 },
                breaches: ["question_density"],
              },
              intent: {
                goal_revision_pressure: 1,
                latest_goal_revision_magnitude: "minor",
              },
            },
          },
        },
      });
      callbacks?.onProviderSnapshot?.({
        providerId: "orchestration",
        path: "/gates",
        tree: {
          id: "gates",
          type: "collection",
          children: gateSnapshots.map((gate) => ({
            id: gate.id,
            type: "item",
            properties: {
              status: gate.status,
              gate_type: gate.gate_type,
              subject_ref: gate.subject_ref,
              summary: gate.summary,
              evidence_refs: gate.evidence_refs ?? [],
              created_at: gate.created_at,
              version: gate.version,
            },
            affordances:
              gate.status === "open" && gate.resolve !== false
                ? [{ action: "resolve_gate" }]
                : undefined,
          })),
        },
      });
      callbacks?.onProviderSnapshot?.({
        providerId: "orchestration",
        path: "/audit",
        tree: {
          id: "audit",
          type: "collection",
          children: [
            {
              id: "audit-1",
              type: "item",
              properties: {
                status: "failed",
              },
            },
          ],
        },
      });
      callbacks?.onProviderSnapshot?.({
        providerId: "orchestration",
        path: "/digests",
        tree: {
          id: "digests",
          type: "collection",
          properties: {
            latest_digest_id: "digest-1",
            latest_status: "blocked",
          },
          children: [
            {
              id: "digest-1",
              type: "item",
              properties: {
                actions: [
                  {
                    id: "action-gate-2-accept",
                    kind: "accept_gate",
                    label: "Accept slice gate",
                    target_ref: "gate:gate-2",
                    action_path: "/gates/gate-2",
                    action_name: "resolve_gate",
                    params: { status: "accepted" },
                    urgency: "high",
                  },
                ],
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

  test("session exposes actionable orchestration summary from mirrored snapshots", async () => {
    const harness = createOrchestrationMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-orchestration",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-orchestration",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitSnapshots();

      const orchestration = await consumer.query("/orchestration", 2);
      expect(orchestration.properties?.available).toBe(true);
      expect(orchestration.properties?.plan_id).toBe("plan-1");
      expect(orchestration.properties?.plan_status).toBe("active");
      expect(orchestration.properties?.active_slice_count).toBe(3);
      expect(orchestration.properties?.completed_slice_count).toBe(2);
      expect(orchestration.properties?.failed_slice_count).toBe(1);
      expect(orchestration.properties?.pending_gate_count).toBe(1);
      expect(orchestration.properties?.latest_blocking_gate_id).toBe("gate-2");
      expect(orchestration.properties?.latest_blocking_gate_summary).toBe(
        "Review parser evidence.",
      );
      const pendingGates = orchestration.properties?.pending_gates as
        | Array<Record<string, unknown>>
        | undefined;
      expect(pendingGates).toHaveLength(1);
      expect(pendingGates?.[0]).toMatchObject({
        id: "gate-orchestration-gate-2",
        source_gate_id: "gate-2",
        gate_type: "slice_gate",
        status: "open",
        subject_ref: "slice:parser",
        summary: "Review parser evidence.",
        evidence_refs: ["evidence:parser"],
        version: 7,
        can_accept: true,
        can_reject: true,
      });
      expect(orchestration.properties?.final_audit_id).toBe("audit-1");
      expect(orchestration.properties?.final_audit_status).toBe("failed");
      expect(orchestration.properties?.latest_digest_id).toBe("digest-1");
      expect(orchestration.properties?.latest_digest_status).toBe("blocked");
      expect(orchestration.properties?.latest_digest_actions).toContainEqual(
        expect.objectContaining({
          id: "action-gate-2-accept",
          kind: "accept_gate",
          action_path: "/gates/gate-2",
          action_name: "resolve_gate",
          params: { status: "accepted" },
        }),
      );
      expect(orchestration.properties?.progress_velocity).toBe(1);
      expect(orchestration.properties?.progress_current_distance).toBe(2);
      expect(orchestration.properties?.goal_revision_pressure).toBe(1);
      expect(orchestration.properties?.latest_goal_revision_magnitude).toBe("minor");
      expect(orchestration.properties?.coherence_breaches).toEqual(["question_density"]);
      expect(orchestration.properties?.coherence_thresholds).toEqual({
        question_density_limit: 3,
      });
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session caps pending orchestration gates and shares the same mirror with multiple consumers", async () => {
    const harness = createOrchestrationMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-orchestration-gates",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-orchestration-gates",
    });
    const consumerA = new SlopConsumer(new InProcessTransport(provider.server));
    const consumerB = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumerA.connect();
      await consumerB.connect();
      await consumerA.subscribe("/", 5);
      await consumerB.subscribe("/", 5);

      harness.emitSnapshots(
        [6, 5, 4, 3, 2, 1, 0].map((index) => ({
          id: `gate-open-${index}`,
          status: "open",
          gate_type: "slice_gate",
          subject_ref: `slice:${index}`,
          summary: `Gate ${index}`,
          created_at: `2026-01-01T00:0${index}:00.000Z`,
          version: index + 1,
          resolve: true,
        })),
      );

      const first = await consumerA.query("/orchestration", 2);
      const second = await consumerB.query("/orchestration", 2);
      const firstGates = first.properties?.pending_gates as Array<Record<string, unknown>>;
      const secondGates = second.properties?.pending_gates as Array<Record<string, unknown>>;

      expect(first.properties?.pending_gate_count).toBe(7);
      expect(firstGates).toHaveLength(5);
      expect(firstGates.map((gate) => gate.source_gate_id)).toEqual([
        "gate-open-0",
        "gate-open-1",
        "gate-open-2",
        "gate-open-3",
        "gate-open-4",
      ]);
      expect(first.properties?.latest_blocking_gate_id).toBe("gate-open-6");
      expect(second.properties?.pending_gate_count).toBe(7);
      expect(secondGates).toEqual(firstGates);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session invokes latest digest actions through the downstream provider", async () => {
    const harness = createOrchestrationMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-digest-action",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-digest-action",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);
      harness.emitSnapshots();

      const invoked = await consumer.invoke("/orchestration", "run_digest_action", {
        action_id: "action-gate-2-accept",
      });
      expect(invoked.status).toBe("ok");
      expect(harness.providerInvokes).toContainEqual({
        providerId: "orchestration",
        path: "/gates/gate-2",
        action: "resolve_gate",
        params: { status: "accepted" },
      });
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session resolves pending orchestration gates through the downstream provider", async () => {
    const harness = createOrchestrationMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-orchestration-resolve",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-orchestration-resolve",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitSnapshots([
        {
          id: "gate-accept",
          status: "open",
          gate_type: "plan_accept",
          subject_ref: "plan:current",
          summary: "Accept the plan.",
          created_at: "2026-01-01T00:00:00.000Z",
          version: 3,
          resolve: true,
        },
        {
          id: "gate-reject",
          status: "open",
          gate_type: "slice_gate",
          subject_ref: "slice:parser",
          summary: "Review parser evidence.",
          created_at: "2026-01-01T00:01:00.000Z",
          version: 4,
          resolve: true,
        },
      ]);

      const orchestration = await consumer.query("/orchestration", 2);
      const pendingGates = orchestration.properties?.pending_gates as Array<
        Record<string, unknown>
      >;

      const accepted = await consumer.invoke("/orchestration", "accept_gate", {
        gate_id: pendingGates[0]?.id,
        resolution: "Looks correct.",
      });
      expect(accepted.status).toBe("ok");

      const rejected = await consumer.invoke("/orchestration", "reject_gate", {
        gate_id: pendingGates[1]?.id,
        resolution: "Evidence is insufficient.",
      });
      expect(rejected.status).toBe("ok");

      expect(harness.providerInvokes).toEqual([
        {
          providerId: "orchestration",
          path: "/gates/gate-accept",
          action: "resolve_gate",
          params: {
            status: "accepted",
            resolution: "Looks correct.",
            expected_version: 3,
          },
        },
        {
          providerId: "orchestration",
          path: "/gates/gate-reject",
          action: "resolve_gate",
          params: {
            status: "rejected",
            resolution: "Evidence is insufficient.",
            expected_version: 4,
          },
        },
      ]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session gate resolution rejects unknown or non-actionable gates locally", async () => {
    const harness = createOrchestrationMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-orchestration-reject-local",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-orchestration-reject-local",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitSnapshots([
        {
          id: "gate-resolved",
          status: "accepted",
          gate_type: "plan_accept",
          summary: "Already accepted.",
          created_at: "2026-01-01T00:00:00.000Z",
          version: 2,
        },
      ]);

      const unknown = await consumer.invoke("/orchestration", "accept_gate", {
        gate_id: "gate-orchestration-gate-resolved",
      });
      expect(unknown.status).toBe("error");
      expect(unknown.error?.message).toContain("Unknown or non-open orchestration gate");

      harness.emitSnapshots([
        {
          id: "gate-no-action",
          status: "open",
          gate_type: "slice_gate",
          summary: "No visible resolver.",
          created_at: "2026-01-01T00:00:00.000Z",
          version: 1,
          resolve: false,
        },
      ]);

      const nonActionable = await consumer.invoke("/orchestration", "reject_gate", {
        gate_id: "gate-orchestration-gate-no-action",
      });
      expect(nonActionable.status).toBe("error");
      expect(nonActionable.error?.message).toContain("cannot be rejected");
      expect(harness.providerInvokes).toEqual([]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session gate resolution accepts a real docs/12 orchestration gate once", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-gate-"));
    const orchestrationProvider = new OrchestrationProvider({
      workspaceRoot: root,
      sessionId: "docs12-session-gate",
    });
    const orchestrationConsumer = new SlopConsumer(
      new InProcessTransport(orchestrationProvider.server),
    );
    let callbacks: AgentCallbacks | null = null;
    const providerInvokes: Array<{
      providerId: string;
      path: string;
      action: string;
      params?: Record<string, unknown>;
    }> = [];
    const factory: SessionAgentFactory = (agentCallbacks): SessionAgent => {
      callbacks = agentCallbacks;
      return {
        start: async () => undefined,
        chat: async () => ({ status: "completed", response: "unused" }),
        resumeWithToolResult: async () => ({ status: "completed", response: "unused" }),
        invokeProvider: async (providerId, path, action, params) => {
          providerInvokes.push({ providerId, path, action, params });
          return orchestrationConsumer.invoke(path, action, params);
        },
        resolveApprovalDirect: async () => ({ type: "result", id: "inv", status: "ok" }),
        rejectApprovalDirect: () => undefined,
        cancelActiveTurn: () => false,
        clearPendingApproval: () => undefined,
        shutdown: () => undefined,
      };
    };
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-real-orchestration-gate",
      agentFactory: factory,
      llmProfileManager: createTestProfileManager(),
    });
    const sessionProvider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-real-orchestration-gate",
    });
    const sessionConsumer = new SlopConsumer(new InProcessTransport(sessionProvider.server));
    const mirrorGates = async () => {
      callbacks?.onProviderSnapshot?.({
        providerId: "orchestration",
        path: "/gates",
        tree: await orchestrationConsumer.query("/gates", 2),
      });
    };

    try {
      await orchestrationConsumer.connect();
      await orchestrationConsumer.subscribe("/", 4);
      await runtime.start();
      await sessionConsumer.connect();
      await sessionConsumer.subscribe("/", 5);

      const opened = await orchestrationConsumer.invoke("/gates", "open_gate", {
        gate_type: "plan_accept",
        subject_ref: "plan:current",
        summary: "Accept the current plan.",
      });
      expect(opened.status).toBe("ok");
      const sourceGateId = (opened.data as { id: string }).id;

      await mirrorGates();
      const orchestration = await sessionConsumer.query("/orchestration", 2);
      const pendingGates = orchestration.properties?.pending_gates as Array<
        Record<string, unknown>
      >;
      expect(pendingGates).toHaveLength(1);

      const accepted = await sessionConsumer.invoke("/orchestration", "accept_gate", {
        gate_id: pendingGates[0]?.id,
        resolution: "Accepted through session.",
      });
      expect(accepted.status).toBe("ok");
      expect(providerInvokes).toHaveLength(1);
      expect(providerInvokes[0]).toMatchObject({
        providerId: "orchestration",
        path: `/gates/${sourceGateId}`,
        action: "resolve_gate",
        params: {
          status: "accepted",
          resolution: "Accepted through session.",
          expected_version: 1,
        },
      });

      const gatesAfterAccept = await orchestrationConsumer.query("/gates", 2);
      const sourceGate = gatesAfterAccept.children?.find((gate) => gate.id === sourceGateId);
      expect(sourceGate?.properties?.status).toBe("accepted");
      expect(sourceGate?.properties?.version).toBe(2);

      await mirrorGates();
      const sessionAfterAccept = await sessionConsumer.query("/orchestration", 2);
      expect(sessionAfterAccept.properties?.pending_gate_count).toBe(0);
      expect(sessionAfterAccept.properties?.pending_gates).toEqual([]);

      const duplicate = await sessionConsumer.invoke("/orchestration", "accept_gate", {
        gate_id: pendingGates[0]?.id,
      });
      expect(duplicate.status).toBe("error");
      expect(providerInvokes).toHaveLength(1);
    } finally {
      sessionProvider.stop();
      runtime.shutdown();
      orchestrationProvider.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session starts the spec-driven goal pipeline through provider affordances", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-spec-goal-"));
    const orchestrationProvider = new OrchestrationProvider({
      workspaceRoot: root,
      sessionId: "docs12-session-pipeline",
    });
    const specProvider = new SpecProvider({ workspaceRoot: root });
    const orchestrationConsumer = new SlopConsumer(
      new InProcessTransport(orchestrationProvider.server),
    );
    const specConsumer = new SlopConsumer(new InProcessTransport(specProvider.server));
    const factory: SessionAgentFactory = (): SessionAgent => ({
      start: async () => undefined,
      chat: async () => ({ status: "completed", response: "unused" }),
      resumeWithToolResult: async () => ({ status: "completed", response: "unused" }),
      invokeProvider: async (providerId, path, action, params) => {
        if (providerId === "orchestration") {
          return orchestrationConsumer.invoke(path, action, params);
        }
        if (providerId === "spec") {
          return specConsumer.invoke(path, action, params);
        }
        return {
          type: "result",
          id: "unsupported-provider",
          status: "error",
          error: { code: "unsupported_provider", message: providerId },
        };
      },
      resolveApprovalDirect: async () => ({ type: "result", id: "inv", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-spec-goal",
      agentFactory: factory,
      llmProfileManager: createTestProfileManager(),
    });
    const sessionProvider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-spec-goal",
    });
    const sessionConsumer = new SlopConsumer(new InProcessTransport(sessionProvider.server));

    try {
      await orchestrationConsumer.connect();
      await specConsumer.connect();
      await sessionConsumer.connect();
      await orchestrationConsumer.subscribe("/", 4);
      await specConsumer.subscribe("/", 5);
      await sessionConsumer.subscribe("/", 5);

      const started = await sessionConsumer.invoke("/orchestration", "start_spec_driven_goal", {
        title: "Ship importer",
        intent: "Import CSV files with validation.",
        requirements: [
          {
            text: "CSV files are parsed into rows.",
            criterion_kind: "code",
            verification_hint: "bun test tests/importer.test.ts",
          },
        ],
        slices: [
          {
            name: "parser",
            goal: "Implement CSV parsing.",
            acceptance_criteria: ["CSV files are parsed into rows"],
          },
        ],
        auto_accept_spec: true,
        auto_accept_plan: true,
      });
      expect(started.status).toBe("ok");
      const data = started.data as {
        goal_id: string;
        goal_version: number;
        spec_id: string;
        spec_version: number;
        spec_gate_id: string;
        plan_revision_id: string;
        plan_gate_id: string;
        task_ids: string[];
        pending_gate_ids: string[];
        message_ids: string[];
      };
      expect(data.goal_id).toBeString();
      expect(data.goal_version).toBe(1);
      expect(data.spec_id).toBeString();
      expect(data.spec_version).toBe(3);
      expect(data.spec_gate_id).toBeString();
      expect(data.plan_revision_id).toBeString();
      expect(data.plan_gate_id).toBeString();
      expect(data.task_ids).toHaveLength(1);
      expect(data.pending_gate_ids).toEqual([]);
      expect(data.message_ids).toHaveLength(2);

      const spec = await specConsumer.query(`/specs/${data.spec_id}`, 2);
      expect(spec.properties?.status).toBe("accepted");
      expect(spec.properties?.goal_id).toBe(data.goal_id);

      const tasks = await orchestrationConsumer.query("/tasks", 2);
      expect(tasks.children?.[0]?.id).toBe(data.task_ids[0]);
      expect(tasks.children?.[0]?.properties?.requires_slice_gate).toBe(true);
      expect(tasks.children?.[0]?.properties?.spec_version).toBe(data.spec_version);
      const messages = await orchestrationConsumer.query("/messages", 2);
      expect(messages.children?.map((child) => child.properties?.from_role)).toContain(
        "spec-agent",
      );
      expect(messages.children?.map((child) => child.properties?.from_role)).toContain("planner");
    } finally {
      sessionProvider.stop();
      runtime.shutdown();
      orchestrationProvider.stop();
      specProvider.stop();
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

import type { ResultMessage } from "@slop-ai/consumer/browser";
import type { AgentCallbacks, ResolvedApprovalToolResult } from "../../src/core/agent";
import type { ExternalProviderState } from "../../src/core/consumer";
import type { CredentialStore, CredentialStoreStatus } from "../../src/llm/credential-store";
import { LlmProfileManager } from "../../src/llm/profile-manager";
import {
  LlmAbortError,
  type LlmAdapter,
  type LlmChatOptions,
  type LlmResponse,
} from "../../src/llm/types";
import { goalSnapshotToExtension } from "../../src/plugins/first-party/persistent-goal/goal-schema";
import { createPersistentGoalPlugin } from "../../src/plugins/first-party/persistent-goal/session";
import type { SessionAgent, SessionAgentFactory } from "../../src/session/runtime";
import type { SessionStore } from "../../src/session/store";
import { createTestConfig } from "./config";

export const TEST_CONFIG = createTestConfig({
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
  },
  plugins: {
    "persistent-goal": { enabled: true },
    skills: { enabled: true },
  },
});

export function persistentGoalStoreOptions() {
  const plugin = createPersistentGoalPlugin();
  return {
    snapshotMigrators: plugin.migrateSnapshot ? [plugin.migrateSnapshot] : [],
    snapshotRecoverers: plugin.recoverSnapshot ? [plugin.recoverSnapshot] : [],
    snapshotProjections: plugin.snapshotProjections ?? [],
    extensionEventTypes: plugin.extensionEvents ?? {},
  };
}

export function seedGoal(store: SessionStore, objective: string, message: string): string {
  const timestamp = new Date().toISOString();
  const goalId = "goal-runtime-recover";
  store.upsertExtension(
    goalSnapshotToExtension({
      goalId,
      objective,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      elapsedMs: 0,
      continuationCount: 0,
      message,
    }),
  );
  return goalId;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private status: CredentialStoreStatus = "available",
    private secrets = new Map<string, string>(),
  ) {}

  async getStatus(): Promise<CredentialStoreStatus> {
    return this.status;
  }

  async get(endpointId: string): Promise<string | null> {
    return this.secrets.get(endpointId) ?? null;
  }

  async set(endpointId: string, secret: string): Promise<void> {
    this.secrets.set(endpointId, secret);
  }

  async delete(endpointId: string): Promise<void> {
    this.secrets.delete(endpointId);
  }
}

export function createTestProfileManager(options?: {
  status?: CredentialStoreStatus;
  secrets?: Record<string, string>;
}): LlmProfileManager {
  return new LlmProfileManager({
    config: TEST_CONFIG,
    credentialStore: new MemoryCredentialStore(
      options?.status,
      new Map(Object.entries(options?.secrets ?? { openai: "test-key" })),
    ),
    writeConfig: async () => undefined,
  });
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

export function createStreamingAgentFactory(): SessionAgentFactory {
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

export function createQueuedTurnHarnessFactory() {
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

export function createQueuedGoalHarnessFactory() {
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

export function createCancelableStreamingAgentFactory() {
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

export function createNoToolGoalHarnessFactory() {
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

export class GoalReportingLlm implements LlmAdapter {
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

export class StaleGoalUpdateLlm implements LlmAdapter {
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
export function createGatedApprovalHarnessFactory() {
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

export function createApprovalHarnessFactory(options?: {
  approveResult?: ResultMessage;
  approveError?: unknown;
  providerInvokeDelay?: Promise<void>;
}) {
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
        await options?.providerInvokeDelay;
        return { type: "result", id: "inv-approval", status: "ok", data: { ok: true } };
      },
      resolveApprovalDirect: async (approvalId) => {
        approveCalls.push(approvalId);
        if (options?.approveError) {
          throw options.approveError;
        }
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

export function createTaskMirrorHarnessFactory() {
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

export function createAppMirrorHarnessFactory() {
  let callbacks: AgentCallbacks | null = null;
  const loads: string[] = [];
  const reloads: string[] = [];
  const unloads: string[] = [];

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
      loadProvider: async (providerId) => {
        loads.push(providerId);
        callbacks?.onExternalProviderStates?.([
          {
            id: providerId,
            name: "Native Demo",
            transport: "unix:/tmp/native-demo.sock",
            status: "connected",
          },
        ]);
        return false;
      },
      reloadProvider: async (providerId) => {
        reloads.push(providerId);
        callbacks?.onExternalProviderStates?.([
          {
            id: providerId,
            name: "Native Demo",
            transport: "unix:/tmp/native-demo.sock",
            status: "connected",
          },
        ]);
      },
      unloadProvider: (providerId) => {
        unloads.push(providerId);
        callbacks?.onExternalProviderStates?.([
          {
            id: providerId,
            name: "Native Demo",
            transport: "unix:/tmp/native-demo.sock",
            status: "unloaded",
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
    loads,
    reloads,
    unloads,
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

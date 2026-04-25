// `Agent` is over the 400-line core guideline. It's the public surface
// (constructor, start/stop, chat, resumeWithToolResult, approveAndResume,
// rejectAndResume, listApprovals, …) plus the hub bootstrap that wires
// providers, role, runtime extensions, and discovery together. Splitting
// further would just be moving public methods into helper classes; the
// non-public concerns (mirror plumbing, discovery state) already live
// under `src/core/agent/`.

import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { defaultConfigPromise } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { LlmProfileManager } from "../llm/profile-manager";
import type { ToolResultContentBlock } from "../llm/types";
import {
  discoverProviderDescriptors,
  type ProviderDiscoveryUpdate,
  watchProviderDescriptors,
} from "../providers/discovery";
import { createBuiltinProviders } from "../providers/registry";
import { ProviderDiscoveryCoordinator } from "./agent/discovery";
import { registerProviderMirrors, unregisterProviderMirrors } from "./agent/mirrors";
import type { ApprovalRecord } from "./approvals";
import { ConsumerHub, type ExternalProviderState } from "./consumer";
import { buildSystemPrompt } from "./context";
import { ConversationHistory } from "./history";
import {
  type AgentToolEvent,
  type AgentToolInvocation,
  type PendingApprovalContinuation,
  type RunLoopHooks,
  type RunLoopResult,
  runLoop,
} from "./loop";
import { dangerousActionRule, terminalSafetyRule } from "./policy/rules";
import {
  type DelegationRuntimeHooks,
  defaultRole,
  type RoleProfile,
  RoleRegistry,
  type RuntimeContext,
  type RuntimeEvent,
} from "./role";

export type { AgentToolEvent, AgentToolInvocation } from "./loop";
export type { RoleProfile } from "./role";

const DEFAULT_CONFIG = await defaultConfigPromise;

export type AgentRunResult =
  | {
      status: "completed";
      response: string;
    }
  | {
      status: "waiting_approval";
      invocation: AgentToolInvocation;
    };

export type ResolvedApprovalToolResult = {
  block: ToolResultContentBlock;
  status: "ok" | "error" | "accepted" | "cancelled";
  summary: string;
  taskId?: string;
  errorCode?: string;
  errorMessage?: string;
};

export interface AgentCallbacks {
  onText?: (chunk: string) => void;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
  onToolEvent?: (event: AgentToolEvent) => void;
  onExternalProviderStates?: (states: ExternalProviderState[]) => void;
  onProviderSnapshot?: (update: {
    providerId: string;
    path: string;
    tree: SlopNode | null;
  }) => void;
}

export class Agent {
  private config: SloppyConfig;
  private hub: ConsumerHub | null = null;
  private discovery: ProviderDiscoveryCoordinator;
  private discoveryStop: (() => void) | null = null;
  private discoverySync: Promise<void> = Promise.resolve();
  private history: ConversationHistory;
  private llmProfileManager: LlmProfileManager;
  private llmProfileId?: string;
  private llmModelOverride?: string;
  private callbacks: AgentCallbacks;
  private providerWatchStops = new Map<string, Array<() => void>>();
  private unsubscribeExternalProviderStateChanges: (() => void) | null = null;
  private pendingApproval: PendingApprovalContinuation | null = null;
  private pendingApprovalSourceId: string | null = null;
  private activeRunAbortController: AbortController | null = null;
  private role: RoleProfile;
  private roleId?: string;
  private roleRegistry: RoleRegistry;
  private publishEventCallback?: (event: RuntimeEvent) => void;
  private delegationHooks: DelegationRuntimeHooks | null = null;
  private mirrorProviderPaths: string[];
  private runtimeStops: Array<{ stop(): void }> = [];
  private systemPromptFragments: string[] = [];

  constructor(
    options?: {
      config?: SloppyConfig;
      llmProfileManager?: LlmProfileManager;
      llmProfileId?: string;
      llmModelOverride?: string;
      ignoredProviderIds?: string[];
      role?: RoleProfile;
      roleId?: string;
      roleRegistry?: RoleRegistry;
      publishEvent?: (event: RuntimeEvent) => void;
      mirrorProviderPaths?: string[];
    } & AgentCallbacks,
  ) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    const userOnToolEvent = options?.onToolEvent;
    this.callbacks = {
      onText: options?.onText,
      onToolCall: options?.onToolCall,
      onToolResult: options?.onToolResult,
      onToolEvent: (event) => {
        if (event.kind === "approval_requested" && event.approvalId) {
          this.pendingApprovalSourceId = event.approvalId;
        }
        userOnToolEvent?.(event);
      },
      onExternalProviderStates: options?.onExternalProviderStates,
      onProviderSnapshot: options?.onProviderSnapshot,
    };
    this.discovery = new ProviderDiscoveryCoordinator({
      ignoredProviderIds: options?.ignoredProviderIds,
      notifyStateChange: () => this.emitExternalProviderStates(),
    });
    this.role = options?.role ?? defaultRole;
    this.roleId = options?.roleId;
    this.roleRegistry = options?.roleRegistry ?? new RoleRegistry();
    this.publishEventCallback = options?.publishEvent;
    this.mirrorProviderPaths = options?.mirrorProviderPaths ?? [];
    this.history = new ConversationHistory({
      historyTurns: this.config.agent.historyTurns,
      toolResultMaxChars: this.config.agent.toolResultMaxChars,
    });
    this.llmProfileManager =
      options?.llmProfileManager ??
      new LlmProfileManager({
        config: this.config,
      });
    this.llmProfileId = options?.llmProfileId;
    this.llmModelOverride = options?.llmModelOverride;
  }

  async start(): Promise<void> {
    if (this.hub) {
      return;
    }

    const builtins = createBuiltinProviders(this.config);
    this.discovery.setBuiltinProviderIds(builtins.map((provider) => provider.id));
    this.discovery.resetErrors();

    const discoveredDescriptors = this.config.providers.discovery.enabled
      ? await discoverProviderDescriptors(this.config.providers.discovery.paths)
      : [];
    const discoveredProviders = discoveredDescriptors.flatMap((descriptor) => {
      const provider = this.discovery.resolveDescriptor(descriptor);
      return provider ? [provider] : [];
    });
    const providers = [...builtins, ...discoveredProviders];
    const hub = new ConsumerHub(providers, this.config);
    this.unsubscribeExternalProviderStateChanges = hub.onExternalProviderStateChange((states) => {
      this.emitExternalProviderStates(states);
    });
    this.emitExternalProviderStates();
    await hub.connect();
    this.hub = hub;
    this.emitExternalProviderStates(hub.getExternalProviderStates());

    const self = this;
    const runtimeCtx: RuntimeContext = {
      hub,
      config: this.config,
      publishEvent: (event) => self.publishEventCallback?.(event),
      roleRegistry: this.roleRegistry,
      get delegationHooks() {
        return self.delegationHooks ?? undefined;
      },
      setDelegationHooks: (hooks) => {
        self.delegationHooks = hooks;
      },
      llmProfileManager: this.llmProfileManager,
    };

    for (const provider of providers) {
      const runtimeStop = provider.attachRuntime?.(hub, this.config, runtimeCtx);
      if (runtimeStop) {
        this.runtimeStops.push(runtimeStop);
      }
      const fragment = provider.systemPromptFragment?.(this.config);
      if (fragment) {
        this.systemPromptFragments.push(fragment);
      }
    }

    // Resolve role lazily so that providers' attachRuntime hooks have a
    // chance to register role factories before resolution. If a RoleProfile
    // was supplied directly, prefer it over registry lookup.
    if (this.roleId && this.role.id === defaultRole.id) {
      const resolved = this.roleRegistry.resolve(this.roleId, runtimeCtx);
      if (resolved) {
        this.role = resolved;
      }
    }

    const roleRuntime = this.role.attachRuntime?.(hub, this.config, runtimeCtx);
    if (roleRuntime) {
      this.runtimeStops.push(roleRuntime);
    }

    // Install hub-wide safety rules. Order matters: orchestrator role rules
    // (added during provider/role attach) run first so role-scoped denials
    // short-circuit before generic destructive-command and dangerous-action
    // checks. The safety rules run only when the role layer allows the
    // invocation through.
    hub.addPolicyRule(terminalSafetyRule);
    hub.addPolicyRule(
      dangerousActionRule((providerId, path, action) =>
        hub.isDangerousAffordance(providerId, path, action),
      ),
    );
    const roleFragment = this.role.systemPromptFragment?.(this.config);
    if (roleFragment) {
      this.systemPromptFragments.push(roleFragment);
    }

    if (this.mirrorProviderPaths.length > 0) {
      for (const view of hub.getProviderViews()) {
        await this.registerProviderMirrors(view.providerId);
      }
    }

    if (this.config.providers.discovery.enabled) {
      this.discoveryStop = watchProviderDescriptors({
        paths: this.config.providers.discovery.paths,
        initialDescriptors: discoveredDescriptors,
        onChange: (update) => {
          this.discoverySync = this.discoverySync
            .then(() => this.applyDiscoveryUpdate(update))
            .catch((error) => {
              console.warn(
                `[sloppy] provider discovery update failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        },
      });
    }
  }

  async chat(userMessage: string): Promise<AgentRunResult> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }

    if (this.pendingApproval) {
      throw new Error("Cannot start a new chat turn while waiting on approval.");
    }

    const hub = this.hub;
    if (!hub) {
      throw new Error("Agent has not been started.");
    }

    this.history.addUserText(userMessage);
    return this.runLoopWithAbort(async (signal) => {
      const llm = await this.llmProfileManager.createAdapter(this.llmProfileId, this.llmModelOverride);
      return this.executeLoop(
        await runLoop({
          config: this.config,
          hub,
          history: this.history,
          llm,
          signal,
          onText: this.callbacks.onText,
          onToolCall: this.callbacks.onToolCall,
          onToolResult: this.callbacks.onToolResult,
          onToolEvent: this.callbacks.onToolEvent,
          systemPrompt: this.buildSystemPrompt(),
          hooks: this.buildHooks(),
        }),
      );
    });
  }

  async resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }

    const pendingApproval = this.pendingApproval;
    if (!pendingApproval) {
      throw new Error("No pending approval continuation exists for this agent.");
    }

    const hub = this.hub;
    if (!hub) {
      throw new Error("Agent has not been started.");
    }

    this.pendingApproval = null;
    this.callbacks.onToolEvent?.({
      kind: "completed",
      invocation: pendingApproval.blockedInvocation,
      summary: result.summary,
      status: result.status,
      taskId: result.taskId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });

    return this.runLoopWithAbort(async (signal) => {
      const llm = await this.llmProfileManager.createAdapter(this.llmProfileId, this.llmModelOverride);
      return this.executeLoop(
        await runLoop({
          config: this.config,
          hub,
          history: this.history,
          llm,
          signal,
          onText: this.callbacks.onText,
          onToolCall: this.callbacks.onToolCall,
          onToolResult: this.callbacks.onToolResult,
          onToolEvent: this.callbacks.onToolEvent,
          resume: {
            continuation: pendingApproval,
            resolvedToolResult: result.block,
          },
          systemPrompt: this.buildSystemPrompt(),
          hooks: this.buildHooks(),
        }),
      );
    });
  }

  private buildSystemPrompt(): string {
    return buildSystemPrompt(this.config, this.systemPromptFragments);
  }

  private buildHooks(): RunLoopHooks {
    return {
      toolPolicy: this.role.toolPolicy,
      transformInvoke: this.role.transformInvoke,
      beforeNextTurn: this.role.beforeNextTurn,
      roleId: this.roleId ?? this.role.id,
    };
  }

  async invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }

    return this.hub.invoke(providerId, path, action, params);
  }

  /**
   * Resolve an approval directly through the hub-owned queue, returning the
   * raw underlying invoke `ResultMessage`. Bypasses the per-provider
   * `/approvals/{id}.approve` action so the result is not double-wrapped by
   * the SLOP server. The provider action remains the public surface for
   * UI/model callers; runtime paths that need the inner shape (status,
   * task_id, etc.) should use this method.
   */
  async resolveApprovalDirect(approvalId: string): Promise<ResultMessage> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }
    const result = (await this.hub.approvals.approve(approvalId)) as ResultMessage;
    return result;
  }

  /**
   * Reject an approval directly through the hub-owned queue. Mirrors
   * `resolveApprovalDirect` for the rejection path.
   */
  rejectApprovalDirect(approvalId: string, reason?: string): void {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }
    this.hub.approvals.reject(approvalId, reason);
  }

  listConnectedProviders(): { id: string; name: string }[] {
    if (!this.hub) {
      return [];
    }
    return this.hub.getProviderViews().map((view) => ({
      id: view.providerId,
      name: view.providerName,
    }));
  }

  getPendingApprovalInvocation(): AgentToolInvocation | null {
    return this.pendingApproval?.blockedInvocation ?? null;
  }

  getPendingApprovalSourceId(): string | null {
    return this.pendingApproval ? this.pendingApprovalSourceId : null;
  }

  /**
   * List the hub-owned approval queue. Returns an empty array when the agent
   * is not started. Callers (e.g. REPL `/approvals`) get the same view as
   * any other approval-aware UI surface.
   */
  listApprovals(filter?: { providerId?: string }): ApprovalRecord[] {
    if (!this.hub) {
      return [];
    }
    return this.hub.approvals.list(filter);
  }

  /**
   * Approve a pending approval and, if it corresponds to the agent's blocked
   * invocation, resume the paused turn with the resolved tool result. Wraps
   * the boilerplate that REPL/CLI surfaces would otherwise duplicate from
   * `src/session/runtime.ts`.
   */
  async approveAndResume(approvalId: string): Promise<AgentRunResult | null> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }
    const pending = this.pendingApproval;
    const sourceId = this.pendingApprovalSourceId;
    const result = await this.resolveApprovalDirect(approvalId);
    if (!pending || sourceId !== approvalId) {
      return null;
    }
    this.pendingApprovalSourceId = null;
    const toolUseId = pending.blockedInvocation.toolUseId;
    const summary = `${pending.blockedInvocation.providerId}:${pending.blockedInvocation.action} ${pending.blockedInvocation.path}`;
    const block: ToolResultContentBlock = {
      type: "tool_result",
      toolUseId,
      content: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      isError: result.status === "error",
    };
    return this.resumeWithToolResult({
      block,
      status: result.status,
      summary,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
    });
  }

  /**
   * Reject a pending approval and, if it corresponds to the agent's blocked
   * invocation, resume the turn with a tool-error result.
   */
  async rejectAndResume(approvalId: string, reason?: string): Promise<AgentRunResult | null> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }
    const pending = this.pendingApproval;
    const sourceId = this.pendingApprovalSourceId;
    this.rejectApprovalDirect(approvalId, reason);
    if (!pending || sourceId !== approvalId) {
      return null;
    }
    this.pendingApprovalSourceId = null;
    const toolUseId = pending.blockedInvocation.toolUseId;
    const summary = `${pending.blockedInvocation.providerId}:${pending.blockedInvocation.action} ${pending.blockedInvocation.path}`;
    return this.resumeWithToolResult({
      block: {
        type: "tool_result",
        toolUseId,
        content: reason ? `Approval rejected: ${reason}` : "Approval rejected.",
        isError: true,
      },
      status: "cancelled",
      summary,
      errorCode: "approval_rejected",
      errorMessage: reason ? `Approval rejected: ${reason}` : "Approval rejected.",
    });
  }

  clearPendingApproval(): void {
    this.pendingApproval = null;
    this.pendingApprovalSourceId = null;
  }

  cancelActiveTurn(): boolean {
    if (!this.activeRunAbortController || this.activeRunAbortController.signal.aborted) {
      return false;
    }

    this.activeRunAbortController.abort();
    return true;
  }

  updateConfig(config: SloppyConfig): void {
    this.config = config;
    this.llmProfileManager.updateConfig(config);
  }

  shutdown(): void {
    for (const runtimeStop of this.runtimeStops) {
      try {
        runtimeStop.stop();
      } catch {
        // best-effort teardown
      }
    }
    this.runtimeStops = [];
    this.systemPromptFragments = [];

    this.discoveryStop?.();
    this.discoveryStop = null;
    this.unsubscribeExternalProviderStateChanges?.();
    this.unsubscribeExternalProviderStateChanges = null;

    for (const [providerId, stops] of this.providerWatchStops) {
      for (const stop of stops) {
        stop();
      }
      this.providerWatchStops.delete(providerId);
    }

    const hub = this.hub;
    this.hub = null;
    hub?.shutdown();

    this.pendingApproval = null;
    this.discovery.setBuiltinProviderIds([]);
    this.discovery.resetErrors();
    this.discoverySync = Promise.resolve();
  }

  private executeLoop(result: RunLoopResult): AgentRunResult {
    if (result.status === "waiting_approval") {
      this.pendingApproval = result.pending;
      return {
        status: "waiting_approval",
        invocation: result.pending.blockedInvocation,
      };
    }

    this.pendingApproval = null;
    return {
      status: "completed",
      response: result.response,
    };
  }

  private async runLoopWithAbort(
    executor: (signal: AbortSignal) => Promise<AgentRunResult>,
  ): Promise<AgentRunResult> {
    if (this.activeRunAbortController) {
      throw new Error("Agent is already executing a model turn.");
    }

    const abortController = new AbortController();
    this.activeRunAbortController = abortController;
    try {
      return await executor(abortController.signal);
    } finally {
      if (this.activeRunAbortController === abortController) {
        this.activeRunAbortController = null;
      }
    }
  }

  private async registerProviderMirrors(providerId: string): Promise<void> {
    if (!this.hub) {
      return;
    }
    await registerProviderMirrors({
      hub: this.hub,
      providerId,
      paths: this.mirrorProviderPaths,
      watchStops: this.providerWatchStops,
      onSnapshot: (snapshot) => this.callbacks.onProviderSnapshot?.(snapshot),
    });
  }

  private unregisterProviderMirrors(providerId: string): void {
    unregisterProviderMirrors({
      providerId,
      paths: this.mirrorProviderPaths,
      watchStops: this.providerWatchStops,
      onSnapshot: (snapshot) => this.callbacks.onProviderSnapshot?.(snapshot),
    });
  }

  private async applyDiscoveryUpdate(update: ProviderDiscoveryUpdate): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    await this.discovery.applyUpdate({
      hub,
      update,
      registerMirrors: (providerId) => this.registerProviderMirrors(providerId),
      unregisterMirrors: (providerId) => this.unregisterProviderMirrors(providerId),
    });
  }

  private emitExternalProviderStates(hubStates?: ExternalProviderState[]): void {
    const merged = new Map<string, ExternalProviderState>();
    for (const state of this.discovery.errorStates()) {
      merged.set(state.id, state);
    }
    for (const state of hubStates ?? this.hub?.getExternalProviderStates() ?? []) {
      merged.set(state.id, state);
    }

    this.callbacks.onExternalProviderStates?.(
      [...merged.values()].sort((left, right) => {
        const nameComparison = left.name.localeCompare(right.name);
        if (nameComparison !== 0) {
          return nameComparison;
        }

        return left.id.localeCompare(right.id);
      }),
    );
  }
}

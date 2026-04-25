import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { defaultConfigPromise } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { LlmProfileManager } from "../llm/profile-manager";
import type { ToolResultContentBlock } from "../llm/types";
import {
  discoverProviderDescriptors,
  type ProviderDescriptor,
  type ProviderDiscoveryUpdate,
  watchProviderDescriptors,
} from "../providers/discovery";
import {
  createBuiltinProviders,
  createRegisteredProviderFromDescriptor,
  describeProviderTransport,
  type RegisteredProvider,
} from "../providers/registry";
import { ConsumerHub, type ExternalProviderState } from "./consumer";
import { buildSystemPrompt } from "./context";
import { dangerousActionRule, terminalSafetyRule } from "./policy/rules";
import { ConversationHistory } from "./history";
import {
  type AgentToolEvent,
  type AgentToolInvocation,
  type PendingApprovalContinuation,
  type RunLoopHooks,
  type RunLoopResult,
  runLoop,
} from "./loop";
import {
  defaultRole,
  type DelegationRuntimeHooks,
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
  private builtinProviderIds = new Set<string>();
  private discoveryStop: (() => void) | null = null;
  private discoverySync: Promise<void> = Promise.resolve();
  private history: ConversationHistory;
  private llmProfileManager: LlmProfileManager;
  private callbacks: AgentCallbacks;
  private providerWatchStops = new Map<string, Array<() => void>>();
  private externalProviderErrors = new Map<string, ExternalProviderState>();
  private ignoredProviderIds: Set<string>;
  private unsubscribeExternalProviderStateChanges: (() => void) | null = null;
  private pendingApproval: PendingApprovalContinuation | null = null;
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
      ignoredProviderIds?: string[];
      role?: RoleProfile;
      roleId?: string;
      roleRegistry?: RoleRegistry;
      publishEvent?: (event: RuntimeEvent) => void;
      mirrorProviderPaths?: string[];
    } & AgentCallbacks,
  ) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.callbacks = {
      onText: options?.onText,
      onToolCall: options?.onToolCall,
      onToolResult: options?.onToolResult,
      onToolEvent: options?.onToolEvent,
      onExternalProviderStates: options?.onExternalProviderStates,
      onProviderSnapshot: options?.onProviderSnapshot,
    };
    this.ignoredProviderIds = new Set(options?.ignoredProviderIds ?? []);
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
  }

  async start(): Promise<void> {
    if (this.hub) {
      return;
    }

    const builtins = createBuiltinProviders(this.config);
    this.builtinProviderIds = new Set(builtins.map((provider) => provider.id));
    this.externalProviderErrors.clear();

    const discoveredDescriptors = this.config.providers.discovery.enabled
      ? await discoverProviderDescriptors(this.config.providers.discovery.paths)
      : [];
    const discoveredProviders = discoveredDescriptors.flatMap((descriptor) => {
      const provider = this.resolveExternalProviderDescriptor(descriptor);
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
    hub.addPolicyRule(dangerousActionRule(() => hub.getProviderViews()));
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
      const llm = await this.llmProfileManager.createAdapter();
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
      const llm = await this.llmProfileManager.createAdapter();
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

  clearPendingApproval(): void {
    this.pendingApproval = null;
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
    this.builtinProviderIds.clear();
    this.externalProviderErrors.clear();
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
    if (
      !this.hub ||
      this.providerWatchStops.has(providerId) ||
      this.mirrorProviderPaths.length === 0
    ) {
      return;
    }

    const hub = this.hub;
    const stops = await Promise.all(
      this.mirrorProviderPaths.map((path) =>
        hub.watchPath(
          providerId,
          path,
          (tree) => {
            this.callbacks.onProviderSnapshot?.({
              providerId,
              path,
              tree,
            });
          },
          { depth: 2 },
        ),
      ),
    );
    this.providerWatchStops.set(providerId, stops);
  }

  private unregisterProviderMirrors(providerId: string): void {
    const stops = this.providerWatchStops.get(providerId);
    if (!stops) {
      return;
    }

    for (const stop of stops) {
      stop();
    }
    this.providerWatchStops.delete(providerId);
    for (const path of this.mirrorProviderPaths) {
      this.callbacks.onProviderSnapshot?.({
        providerId,
        path,
        tree: null,
      });
    }
  }

  private async applyDiscoveryUpdate(update: ProviderDiscoveryUpdate): Promise<void> {
    const hub = this.hub;
    if (!hub) {
      return;
    }

    for (const descriptor of update.removed) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        this.externalProviderErrors.delete(descriptor.id);
        this.emitExternalProviderStates();
        continue;
      }

      this.externalProviderErrors.delete(descriptor.id);
      this.unregisterProviderMirrors(descriptor.id);
      hub.removeProvider(descriptor.id);
      this.emitExternalProviderStates();
    }

    for (const descriptor of update.updated) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        this.externalProviderErrors.delete(descriptor.id);
        this.emitExternalProviderStates();
        continue;
      }

      this.externalProviderErrors.delete(descriptor.id);
      this.unregisterProviderMirrors(descriptor.id);
      hub.removeProvider(descriptor.id);
      this.emitExternalProviderStates();
    }

    for (const descriptor of [...update.updated, ...update.added]) {
      const provider = this.resolveExternalProviderDescriptor(descriptor);
      if (!provider) {
        continue;
      }

      const added = await hub.addProvider(provider);
      if (added) {
        await this.registerProviderMirrors(provider.id);
      }
    }
  }

  private resolveExternalProviderDescriptor(
    descriptor: ProviderDescriptor,
  ): RegisteredProvider | null {
    if (this.ignoredProviderIds.has(descriptor.id)) {
      this.externalProviderErrors.delete(descriptor.id);
      this.emitExternalProviderStates();
      return null;
    }

    if (this.builtinProviderIds.has(descriptor.id)) {
      this.externalProviderErrors.set(descriptor.id, {
        id: descriptor.id,
        name: descriptor.name,
        transport: describeProviderTransport(descriptor.transport),
        status: "error",
        lastError: `Descriptor id conflicts with built-in provider '${descriptor.id}'.`,
      });
      this.emitExternalProviderStates();
      return null;
    }

    const provider = createRegisteredProviderFromDescriptor(descriptor);
    if (!provider) {
      this.externalProviderErrors.set(descriptor.id, {
        id: descriptor.id,
        name: descriptor.name,
        transport: describeProviderTransport(descriptor.transport),
        status: "error",
        lastError: `Unsupported transport: ${descriptor.transport.type}`,
      });
      this.emitExternalProviderStates();
      return null;
    }

    if (this.externalProviderErrors.delete(descriptor.id)) {
      this.emitExternalProviderStates();
    }
    return provider;
  }

  private emitExternalProviderStates(hubStates?: ExternalProviderState[]): void {
    const merged = new Map<string, ExternalProviderState>();
    for (const state of this.externalProviderErrors.values()) {
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

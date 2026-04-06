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
import {
  createBuiltinProviders,
  createDiscoveredProviders,
  createRegisteredProviderFromDescriptor,
} from "../providers/registry";
import { ConsumerHub } from "./consumer";
import { ConversationHistory } from "./history";
import {
  type AgentToolEvent,
  type AgentToolInvocation,
  type PendingApprovalContinuation,
  type RunLoopResult,
  runLoop,
} from "./loop";

export type { AgentToolEvent, AgentToolInvocation } from "./loop";

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
  onProviderSnapshot?: (update: {
    providerId: string;
    path: "/approvals" | "/tasks";
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
  private pendingApproval: PendingApprovalContinuation | null = null;
  private activeRunAbortController: AbortController | null = null;

  constructor(
    options?: { config?: SloppyConfig; llmProfileManager?: LlmProfileManager } & AgentCallbacks,
  ) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.callbacks = {
      onText: options?.onText,
      onToolCall: options?.onToolCall,
      onToolResult: options?.onToolResult,
      onToolEvent: options?.onToolEvent,
      onProviderSnapshot: options?.onProviderSnapshot,
    };
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

    const discoveredDescriptors = this.config.providers.discovery.enabled
      ? await discoverProviderDescriptors(this.config.providers.discovery.paths)
      : [];
    const providers = [
      ...builtins,
      ...createDiscoveredProviders(discoveredDescriptors, this.builtinProviderIds),
    ];
    const hub = new ConsumerHub(providers, this.config);
    await hub.connect();
    this.hub = hub;

    for (const view of hub.getProviderViews()) {
      await this.registerProviderMirrors(view.providerId);
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
        }),
      );
    });
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
    this.discoveryStop?.();
    this.discoveryStop = null;

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
    if (!this.hub || this.providerWatchStops.has(providerId)) {
      return;
    }

    const stops = await Promise.all([
      this.hub.watchPath(
        providerId,
        "/approvals",
        (tree) => {
          this.callbacks.onProviderSnapshot?.({
            providerId,
            path: "/approvals",
            tree,
          });
        },
        {
          depth: 2,
        },
      ),
      this.hub.watchPath(
        providerId,
        "/tasks",
        (tree) => {
          this.callbacks.onProviderSnapshot?.({
            providerId,
            path: "/tasks",
            tree,
          });
        },
        {
          depth: 2,
        },
      ),
    ]);
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
    this.callbacks.onProviderSnapshot?.({
      providerId,
      path: "/approvals",
      tree: null,
    });
    this.callbacks.onProviderSnapshot?.({
      providerId,
      path: "/tasks",
      tree: null,
    });
  }

  private async applyDiscoveryUpdate(update: ProviderDiscoveryUpdate): Promise<void> {
    const hub = this.hub;
    if (!hub) {
      return;
    }

    for (const descriptor of update.removed) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        continue;
      }

      this.unregisterProviderMirrors(descriptor.id);
      hub.removeProvider(descriptor.id);
    }

    for (const descriptor of update.updated) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        continue;
      }

      this.unregisterProviderMirrors(descriptor.id);
      hub.removeProvider(descriptor.id);
    }

    for (const descriptor of [...update.updated, ...update.added]) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        continue;
      }

      const provider = createRegisteredProviderFromDescriptor(descriptor);
      if (!provider) {
        continue;
      }

      const added = await hub.addProvider(provider);
      if (added) {
        await this.registerProviderMirrors(provider.id);
      }
    }
  }
}

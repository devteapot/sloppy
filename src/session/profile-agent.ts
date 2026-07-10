import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import {
  Agent,
  type AgentCallbacks,
  type AgentRunResult,
  type LocalRuntimeTool,
  type ResolvedApprovalToolResult,
  type RoleProfile,
} from "../core/agent";
import { ConversationHistory } from "../core/history";
import type { InvokePolicy } from "../core/policy";
import type { RoleRegistry, RuntimeEvent } from "../core/role";
import {
  LlmConfigurationError,
  type LlmProfileBindingLease,
  type LlmProfileManager,
  type LlmProfileState,
} from "../llm/profile-manager";
import {
  acpProfileFingerprint,
  createAcpProfileSessionAgent,
} from "../plugins/first-party/delegation/acp-profile";
import type { ChildSessionFactory } from "../runtime/child-session";
import type { RuntimeServiceKey } from "../runtime/services";
import type { SessionAgent } from "./runtime";

type ProfileSessionAgentOptions = {
  config: SloppyConfig;
  llmProfileManager: LlmProfileManager;
  llmProfileId?: string;
  llmModelOverride?: string;
  ignoredProviderIds?: string[];
  role?: RoleProfile;
  roleId?: string;
  roleRegistry?: RoleRegistry;
  publishEvent?: (event: RuntimeEvent) => void;
  mirrorProviderPaths?: string[];
  policyRules?: InvokePolicy[];
  localTools?: () => LocalRuntimeTool[];
  childSessionFactory?: ChildSessionFactory;
  conversationHistory?: ConversationHistory;
  callbacks: AgentCallbacks;
};

function selectedProfile(
  profiles: LlmProfileState[],
  activeProfileId: string,
  profileId?: string,
): LlmProfileState | undefined {
  return profileId
    ? profiles.find((profile) => profile.id === profileId)
    : profiles.find((profile) => profile.id === activeProfileId);
}

export class ProfileSessionAgent implements SessionAgent {
  private config: SloppyConfig;
  private readonly llmProfileManager: LlmProfileManager;
  private readonly llmProfileId?: string;
  private readonly llmModelOverride?: string;
  private readonly ignoredProviderIds: string[];
  private readonly role?: RoleProfile;
  private readonly roleId?: string;
  private readonly roleRegistry?: RoleRegistry;
  private readonly publishEvent?: (event: RuntimeEvent) => void;
  private readonly mirrorProviderPaths: string[];
  private readonly policyRules?: InvokePolicy[];
  private readonly localTools?: () => LocalRuntimeTool[];
  private readonly childSessionFactory?: ChildSessionFactory;
  private readonly callbacks: AgentCallbacks;
  private readonly nativeHistory: ConversationHistory;
  private readonly innerProfileBindingLease: LlmProfileBindingLease;
  private inner: SessionAgent | null = null;
  private innerFingerprint: string | null = null;
  private continuationInner: SessionAgent | null = null;
  private activeInnerOperations = 0;
  private releaseInnerWhenIdle = false;
  private shutdownRequested = false;
  private profileBindingReleased = false;
  private readonly shutdownCompletion: Promise<void>;
  private resolveShutdownCompletion!: () => void;
  private rejectShutdownCompletion!: (error: unknown) => void;
  private shutdownCompletionSettled = false;
  private shutdownFinalized = false;

  constructor(options: ProfileSessionAgentOptions) {
    this.config = options.config;
    this.llmProfileManager = options.llmProfileManager;
    this.llmProfileId = options.llmProfileId;
    this.llmModelOverride = options.llmModelOverride;
    this.ignoredProviderIds = options.ignoredProviderIds ?? [];
    this.role = options.role;
    this.roleId = options.roleId;
    this.roleRegistry = options.roleRegistry;
    this.publishEvent = options.publishEvent;
    this.mirrorProviderPaths = options.mirrorProviderPaths ?? [];
    this.policyRules = options.policyRules;
    this.localTools = options.localTools;
    this.childSessionFactory = options.childSessionFactory;
    this.callbacks = options.callbacks;
    this.shutdownCompletion = new Promise((resolve, reject) => {
      this.resolveShutdownCompletion = resolve;
      this.rejectShutdownCompletion = (error) => reject(error);
    });
    void this.shutdownCompletion.catch(() => undefined);
    this.nativeHistory =
      options.conversationHistory ??
      new ConversationHistory({
        historyTurns: this.config.agent.historyTurns,
        toolResultMaxChars: this.config.agent.toolResultMaxChars,
      });
    this.innerProfileBindingLease = this.llmProfileManager.acquireProfileBinding();
  }

  async start(): Promise<void> {
    await this.runInnerOperation(
      () => this.ensureStartupInner(),
      async () => undefined,
    );
  }

  listConnectedProviders(): { id: string; name: string }[] {
    return this.inner?.listConnectedProviders?.() ?? [];
  }

  getRuntimeService<T>(key: RuntimeServiceKey<T>): T | undefined {
    return this.inner?.getRuntimeService?.(key);
  }

  async chat(userMessage: string): Promise<AgentRunResult> {
    if (this.continuationInner) {
      throw new Error("Cannot start a new chat turn while waiting on approval.");
    }
    return this.runInnerOperation(
      () => this.ensureInner(),
      async (inner) => {
        const result = await inner.chat(userMessage);
        this.continuationInner = result.status === "waiting_approval" ? inner : null;
        return result;
      },
    );
  }

  async resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult> {
    const inner = this.continuationInner;
    if (!inner) {
      throw new Error("No pending approval continuation exists for this session agent.");
    }

    return this.runInnerOperation(
      async () => inner,
      async (activeInner) => {
        try {
          const resumed = await activeInner.resumeWithToolResult(result);
          this.continuationInner = resumed.status === "waiting_approval" ? activeInner : null;
          return resumed;
        } catch (error) {
          if (this.continuationInner === activeInner) {
            this.continuationInner = null;
          }
          throw error;
        }
      },
    );
  }

  async invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    return this.runInnerOperation(
      () => this.ensureStartupInner(),
      (inner) => inner.invokeProvider(providerId, path, action, params),
    );
  }

  async queryProvider(
    providerId: string,
    path: string,
    options?: {
      depth?: number;
      maxNodes?: number;
      window?: [number, number];
    },
  ): Promise<SlopNode> {
    return this.runInnerOperation(
      () => this.ensureStartupInner(),
      (inner) => {
        if (!inner.queryProvider) {
          throw new Error("Provider state query is not available for this session agent.");
        }
        return inner.queryProvider(providerId, path, options);
      },
    );
  }

  async loadProvider(providerId: string): Promise<boolean> {
    return this.runInnerOperation(
      () => this.ensureStartupInner(),
      (inner) => {
        if (!inner.loadProvider) {
          throw new Error("Provider load is not available for this session agent.");
        }
        return inner.loadProvider(providerId);
      },
    );
  }

  async reloadProvider(providerId: string): Promise<void> {
    await this.runInnerOperation(
      () => this.ensureStartupInner(),
      async (inner) => {
        if (!inner.reloadProvider) {
          throw new Error("Provider reload is not available for this session agent.");
        }
        await inner.reloadProvider(providerId);
      },
    );
  }

  unloadProvider(providerId: string): boolean {
    if (!this.inner?.unloadProvider) {
      throw new Error("Provider unload is not available for this session agent.");
    }
    return this.inner.unloadProvider(providerId);
  }

  async resolveApprovalDirect(approvalId: string): Promise<ResultMessage> {
    return this.runInnerOperation(
      async () => this.continuationInner ?? (await this.ensureStartupInner()),
      (inner) => inner.resolveApprovalDirect(approvalId),
    );
  }

  rejectApprovalDirect(approvalId: string, reason?: string): void {
    (this.continuationInner ?? this.inner)?.rejectApprovalDirect(approvalId, reason);
  }

  cancelActiveTurn(): boolean {
    return (this.continuationInner ?? this.inner)?.cancelActiveTurn() ?? false;
  }

  clearPendingApproval(): void {
    (this.continuationInner ?? this.inner)?.clearPendingApproval();
    this.continuationInner = null;
    this.releaseDeferredInnerIfIdle();
  }

  updateConfig(config: SloppyConfig, options: { syncLlmProfileManager?: boolean } = {}): void {
    const configChanged = config !== this.config;
    this.config = config;
    if (options.syncLlmProfileManager !== false) {
      this.llmProfileManager.updateConfig(config);
    }
    if (!configChanged) {
      this.inner?.updateConfig?.(config, options);
      return;
    }
    if (this.activeInnerOperations > 0 || this.continuationInner) {
      this.releaseInnerWhenIdle = true;
      this.inner?.updateConfig?.(config, options);
      return;
    }
    this.disposeInner();
  }

  shutdown(): void {
    if (this.shutdownRequested) {
      return;
    }

    this.shutdownRequested = true;
    this.continuationInner = null;
    if (this.activeInnerOperations > 0) {
      this.releaseInnerWhenIdle = true;
      try {
        this.inner?.cancelActiveTurn();
      } catch (error) {
        console.warn("[sloppy] failed to cancel an active profile session during shutdown:", error);
      }
      return;
    }

    this.finalizeShutdown();
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownCompletion;
  }

  isShutdownComplete(): boolean {
    return this.shutdownCompletionSettled;
  }

  async shutdownAsync(): Promise<void> {
    this.shutdown();
    await this.waitForShutdown();
  }

  private async ensureInner(): Promise<SessionAgent> {
    const state = await this.llmProfileManager.getState();
    const profile = selectedProfile(state.profiles, state.activeProfileId, this.llmProfileId);
    if (!profile) {
      throw new LlmConfigurationError(
        this.llmProfileId
          ? `LLM profile '${this.llmProfileId}' is not available. Add it under llm.profiles or pick another id.`
          : state.message,
      );
    }
    if (!profile.ready) {
      throw new LlmConfigurationError(profile.invalidReason ?? state.message);
    }

    const fingerprint = this.profileFingerprint(profile);
    if (this.inner && this.innerFingerprint === fingerprint) {
      return this.inner;
    }

    return this.replaceInner(profile.id, fingerprint, () => this.createInner(profile));
  }

  private async ensureStartupInner(): Promise<SessionAgent> {
    if (this.inner) {
      return this.inner;
    }

    const state = await this.llmProfileManager.getState();
    const profile = selectedProfile(state.profiles, state.activeProfileId, this.llmProfileId);
    if (profile?.ready) {
      return this.ensureInner();
    }

    return this.replaceInner(this.llmProfileId ?? profile?.id ?? state.activeProfileId, null, () =>
      this.createNativeInner(),
    );
  }

  private profileFingerprint(profile: LlmProfileState): string {
    const model = this.llmModelOverride ?? profile.model;
    const pluginFingerprint = acpProfileFingerprint(this.config, profile, model);
    if (pluginFingerprint) {
      return pluginFingerprint;
    }
    return [
      profile.kind,
      profile.endpointId ?? profile.adapterId ?? "native",
      profile.id,
      model,
      this.contextWindowTokens(profile) ?? "unknown-context",
    ].join(":");
  }

  private contextWindowTokens(profile: LlmProfileState): number | undefined {
    if (profile.kind === "native" && profile.endpointId && this.llmModelOverride) {
      return (
        this.config.llm.endpoints[profile.endpointId]?.models[this.llmModelOverride]
          ?.contextWindowTokens ?? profile.contextWindowTokens
      );
    }
    return profile.contextWindowTokens;
  }

  private createInner(profile: LlmProfileState): SessionAgent {
    const pluginAgent = createAcpProfileSessionAgent({
      config: this.config,
      profile,
      modelOverride: this.llmModelOverride ?? profile.model,
      callbacks: this.callbacks,
    });
    if (pluginAgent) {
      return pluginAgent;
    }

    return this.createNativeInner(profile);
  }

  private createNativeInner(profile?: LlmProfileState): SessionAgent {
    return new Agent({
      config: this.config,
      // ACP agents own their protocol session and transcript. This portable
      // history is intentionally shared only across recreated native Agents.
      conversationHistory: this.nativeHistory,
      llmProfileManager: this.llmProfileManager,
      llmProfileId: this.llmProfileId ?? profile?.id,
      llmModelOverride: this.llmModelOverride ?? profile?.model,
      ignoredProviderIds: this.ignoredProviderIds,
      role: this.role,
      roleId: this.roleId,
      roleRegistry: this.roleRegistry,
      publishEvent: this.publishEvent,
      mirrorProviderPaths: this.mirrorProviderPaths,
      policyRules: this.policyRules,
      localTools: this.localTools,
      childSessionFactory: this.childSessionFactory,
      contextWindowTokens: profile ? this.contextWindowTokens(profile) : undefined,
      ...this.callbacks,
    });
  }

  private async replaceInner(
    profileId: string | undefined,
    fingerprint: string | null,
    create: () => SessionAgent,
  ): Promise<SessionAgent> {
    this.disposeInner();
    this.llmProfileManager.moveProfileBinding(this.innerProfileBindingLease, profileId);
    let next: SessionAgent | null = null;
    try {
      next = create();
      this.inner = next;
      this.innerFingerprint = fingerprint;
      await next.start();
      return next;
    } catch (error) {
      let cleanupError: unknown;
      try {
        next?.shutdown();
      } catch (cause) {
        cleanupError = cause;
      }
      if (this.inner === next) {
        this.inner = null;
        this.innerFingerprint = null;
      }
      this.llmProfileManager.moveProfileBinding(this.innerProfileBindingLease);
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to start and clean up a profile session agent.",
        );
      }
      throw error;
    }
  }

  private async runInnerOperation<T>(
    resolveInner: () => Promise<SessionAgent>,
    operation: (inner: SessionAgent) => Promise<T>,
  ): Promise<T> {
    if (this.shutdownRequested) {
      throw new Error("Profile session agent has been shut down.");
    }
    this.activeInnerOperations += 1;
    try {
      const inner = await resolveInner();
      if (this.shutdownRequested) {
        throw new Error("Profile session agent was shut down before the operation started.");
      }
      return await operation(inner);
    } finally {
      this.activeInnerOperations -= 1;
      this.releaseDeferredInnerIfIdle();
    }
  }

  private releaseDeferredInnerIfIdle(): void {
    if (this.activeInnerOperations !== 0) {
      return;
    }
    if (this.shutdownRequested) {
      this.continuationInner = null;
      this.finalizeShutdown();
      return;
    }
    if (this.releaseInnerWhenIdle && !this.continuationInner) {
      this.disposeInner();
    }
  }

  private finalizeShutdown(): void {
    if (this.shutdownFinalized) {
      return;
    }
    this.shutdownFinalized = true;
    const cleanupErrors: unknown[] = [];
    try {
      this.disposeInner();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!this.profileBindingReleased) {
      this.profileBindingReleased = true;
      try {
        this.llmProfileManager.releaseProfileBinding(this.innerProfileBindingLease);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length === 0) {
      this.settleShutdownCompletion({ status: "resolved" });
      return;
    }
    const cleanupError =
      cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Profile session agent shutdown failed.");
    this.settleShutdownCompletion({ status: "rejected", error: cleanupError });
    throw cleanupError;
  }

  private disposeInner(): void {
    const inner = this.inner;
    this.inner = null;
    this.innerFingerprint = null;
    this.releaseInnerWhenIdle = false;
    const cleanupErrors: unknown[] = [];
    try {
      inner?.shutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.llmProfileManager.moveProfileBinding(this.innerProfileBindingLease);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "Failed to dispose the active profile session agent.",
      );
    }
  }

  private settleShutdownCompletion(
    result: { status: "resolved" } | { status: "rejected"; error: unknown },
  ): void {
    if (this.shutdownCompletionSettled) {
      return;
    }
    this.shutdownCompletionSettled = true;
    if (result.status === "rejected") {
      this.rejectShutdownCompletion(result.error);
      return;
    }
    this.resolveShutdownCompletion();
  }
}

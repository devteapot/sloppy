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
import type { InvokePolicy } from "../core/policy";
import type { RoleRegistry, RuntimeEvent } from "../core/role";
import {
  LlmConfigurationError,
  type LlmProfileManager,
  type LlmProfileState,
} from "../llm/profile-manager";
import {
  acpProfileFingerprint,
  createAcpProfileSessionAgent,
} from "../plugins/first-party/delegation/acp-profile";
import type { ChildSessionFactory } from "../runtime/child-session";
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
  private inner: SessionAgent | null = null;
  private innerFingerprint: string | null = null;

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
  }

  async start(): Promise<void> {
    await this.ensureStartupInner();
  }

  listConnectedProviders(): { id: string; name: string }[] {
    return this.inner?.listConnectedProviders?.() ?? [];
  }

  async chat(userMessage: string): Promise<AgentRunResult> {
    const inner = await this.ensureInner();
    return inner.chat(userMessage);
  }

  async resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult> {
    const inner = await this.ensureInner();
    return inner.resumeWithToolResult(result);
  }

  async invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    const inner = await this.ensureStartupInner();
    return inner.invokeProvider(providerId, path, action, params);
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
    const inner = await this.ensureStartupInner();
    if (!inner.queryProvider) {
      throw new Error("Provider state query is not available for this session agent.");
    }
    return inner.queryProvider(providerId, path, options);
  }

  async loadProvider(providerId: string): Promise<boolean> {
    const inner = await this.ensureStartupInner();
    if (!inner.loadProvider) {
      throw new Error("Provider load is not available for this session agent.");
    }
    return inner.loadProvider(providerId);
  }

  async reloadProvider(providerId: string): Promise<void> {
    const inner = await this.ensureStartupInner();
    if (!inner.reloadProvider) {
      throw new Error("Provider reload is not available for this session agent.");
    }
    await inner.reloadProvider(providerId);
  }

  unloadProvider(providerId: string): boolean {
    if (!this.inner?.unloadProvider) {
      throw new Error("Provider unload is not available for this session agent.");
    }
    return this.inner.unloadProvider(providerId);
  }

  async resolveApprovalDirect(approvalId: string): Promise<ResultMessage> {
    const inner = await this.ensureStartupInner();
    return inner.resolveApprovalDirect(approvalId);
  }

  rejectApprovalDirect(approvalId: string, reason?: string): void {
    this.inner?.rejectApprovalDirect(approvalId, reason);
  }

  cancelActiveTurn(): boolean {
    return this.inner?.cancelActiveTurn() ?? false;
  }

  clearPendingApproval(): void {
    this.inner?.clearPendingApproval();
  }

  updateConfig(config: SloppyConfig): void {
    this.config = config;
    this.llmProfileManager.updateConfig(config);
    this.inner?.updateConfig?.(config);
  }

  shutdown(): void {
    this.inner?.shutdown();
    this.inner = null;
    this.innerFingerprint = null;
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

    this.inner?.shutdown();
    this.inner = this.createInner(profile);
    this.innerFingerprint = fingerprint;
    await this.inner.start();
    return this.inner;
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

    this.inner = this.createNativeInner();
    this.innerFingerprint = null;
    await this.inner.start();
    return this.inner;
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
    ].join(":");
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

    return this.createNativeInner();
  }

  private createNativeInner(): SessionAgent {
    return new Agent({
      config: this.config,
      llmProfileManager: this.llmProfileManager,
      llmProfileId: this.llmProfileId,
      llmModelOverride: this.llmModelOverride,
      ignoredProviderIds: this.ignoredProviderIds,
      role: this.role,
      roleId: this.roleId,
      roleRegistry: this.roleRegistry,
      publishEvent: this.publishEvent,
      mirrorProviderPaths: this.mirrorProviderPaths,
      policyRules: this.policyRules,
      localTools: this.localTools,
      childSessionFactory: this.childSessionFactory,
      ...this.callbacks,
    });
  }
}

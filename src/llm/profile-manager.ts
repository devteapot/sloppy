import { createDefaultConfig } from "../config/load";
import { writeHomeLlmConfig } from "../config/persist";
import type {
  AnyLlmProfileConfig,
  LlmConfig,
  LlmEndpointConfig,
  LlmEndpointModelConfig,
  LlmReasoningEffort,
  LlmSessionAgentProfileConfig,
  LlmThinkingDisplay,
  SloppyConfig,
} from "../config/schema";
import {
  endpointRequiresCredential,
  endpointUsesCodexAuth,
  getDefaultEndpointModel,
} from "./catalog";
import {
  type CredentialStore,
  type CredentialStoreKind,
  type CredentialStoreStatus,
  createCredentialStore,
} from "./credential-store";
import { createLlmAdapter } from "./factory";
import { getCodexAuthStatus } from "./openai-codex";
import { type EffectiveThinkingConfig, resolveEffectiveThinkingConfig } from "./thinking";
import type { LlmAdapter } from "./types";

const DEFAULT_CONFIG = createDefaultConfig();

export type LlmKeySource = "env" | "secure_store" | "missing" | "not_required" | "external_auth";
export type LlmProfileOrigin = "managed" | "environment" | "fallback";
export type LlmProfileKind = "native" | "session-agent";

type ResolvedProfile = AnyLlmProfileConfig & {
  origin: LlmProfileOrigin;
  managed: boolean;
};

export type LlmProfileState = {
  kind: LlmProfileKind;
  id: string;
  label?: string;
  endpointId?: string;
  protocol?: string;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  adapterId?: string;
  baseUrl?: string;
  authEnv?: string;
  isDefault: boolean;
  hasKey: boolean;
  keySource: LlmKeySource;
  ready: boolean;
  managed: boolean;
  origin: LlmProfileOrigin;
  canDeleteProfile: boolean;
  canDeleteApiKey: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  thinking: EffectiveThinkingConfig;
  invalidReason?: string;
};

export type LlmStateSnapshot = {
  status: "ready" | "needs_credentials";
  message: string;
  activeProfileId: string;
  selectedEndpointId?: string;
  selectedProtocol?: string;
  selectedModel: string;
  selectedContextWindowTokens?: number;
  secureStoreKind: CredentialStoreKind;
  secureStoreStatus: CredentialStoreStatus;
  profiles: LlmProfileState[];
};

export type SaveProfileInput = {
  profileId?: string;
  kind?: LlmProfileKind;
  label?: string;
  endpointId?: string;
  model?: string;
  reasoningEffort?: LlmReasoningEffort;
  thinkingEnabled?: boolean;
  thinkingDisplay?: LlmThinkingDisplay;
  adapterId?: string;
  apiKey?: string;
  makeDefault?: boolean;
};

type ResolvedCredential = {
  keySource: LlmKeySource;
  ready: boolean;
  hasKey: boolean;
  apiKey?: string;
  invalidReason?: string;
};

function normalizeApiKey(value: string): string {
  return value.trim();
}

function validateApiKey(endpointId: string, apiKey: string): string | null {
  if (endpointId === "openrouter") {
    if (!apiKey.startsWith("sk-or-v1-") && !apiKey.startsWith("sk-or-")) {
      return "The configured OpenRouter API key does not look valid. OpenRouter keys usually start with sk-or-v1-.";
    }
  }

  return null;
}

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function buildProfileId(input: { label?: string; endpointId?: string; model: string }): string {
  const base =
    slugifySegment(input.label ?? `${input.endpointId ?? "agent"}-${input.model}`) || "profile";
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base}-${suffix}`;
}

function sanitizeIdSegment(value: string): string {
  const sanitized = slugifySegment(value);
  return sanitized || "default";
}

export class LlmConfigurationError extends Error {
  readonly code = "llm_not_configured";

  constructor(message: string) {
    super(message);
    this.name = "LlmConfigurationError";
  }
}

function firstEndpointModel(endpoint: LlmEndpointConfig): string | undefined {
  return Object.keys(endpoint.models)[0];
}

function defaultModelForEndpoint(endpointId: string, endpoint: LlmEndpointConfig): string {
  return getDefaultEndpointModel(endpointId) ?? firstEndpointModel(endpoint) ?? "default";
}

function buildFallbackProfile(config: LlmConfig): ResolvedProfile {
  const endpointId = "anthropic";
  const endpoint = config.endpoints[endpointId];
  return {
    kind: "native",
    id: "default",
    label: "Default",
    endpointId,
    model: endpoint ? defaultModelForEndpoint(endpointId, endpoint) : "claude-sonnet-4-20250514",
    reasoningEffort: config.reasoningEffort,
    thinking: config.thinking,
    managed: false,
    origin: "fallback",
  };
}

function endpointModelMetadata(
  config: LlmConfig,
  profile: Pick<LlmProfileState, "endpointId" | "model">,
): LlmEndpointModelConfig | undefined {
  if (!profile.endpointId) {
    return undefined;
  }
  return config.endpoints[profile.endpointId]?.models[profile.model];
}

function selectActiveProfile(
  config: LlmConfig,
  profiles: LlmProfileState[],
): LlmProfileState | undefined {
  const explicitProfile = profiles.find((profile) => profile.id === config.defaultProfileId);
  if (explicitProfile) {
    return explicitProfile;
  }

  const readyManagedProfile = profiles.find(
    (profile) => profile.origin === "managed" && profile.ready,
  );
  if (readyManagedProfile) {
    return readyManagedProfile;
  }

  const firstReadyProfile = profiles.find((profile) => profile.ready);
  if (firstReadyProfile) {
    return firstReadyProfile;
  }

  const firstManagedProfile = profiles.find((profile) => profile.origin === "managed");
  if (firstManagedProfile) {
    return firstManagedProfile;
  }

  return profiles[0];
}

function buildNextLlmConfig(
  previous: LlmConfig,
  profiles: AnyLlmProfileConfig[],
  candidates: ResolvedProfile[],
  defaultProfileId?: string,
): LlmConfig {
  const activeProfile =
    candidates.find((profile) => profile.id === defaultProfileId) ??
    candidates.find((profile) => profile.origin === "managed") ??
    candidates[0] ??
    buildFallbackProfile(previous);

  return {
    ...previous,
    defaultProfileId: activeProfile.origin === "fallback" ? undefined : activeProfile.id,
    profiles,
  };
}

function buildEnvironmentProfileId(input: {
  endpointId: string;
  model: string;
  env: string;
}): string {
  return [
    "env",
    sanitizeIdSegment(input.endpointId),
    sanitizeIdSegment(input.env),
    sanitizeIdSegment(input.model),
  ].join("-");
}

function buildEndpointAuthHint(
  endpointId: string,
  endpoint: LlmEndpointConfig,
): string | undefined {
  if (endpoint.auth.type === "env") {
    return `Set ${endpoint.auth.env}, store a key for endpoint ${endpointId} in the app, or choose another profile before starting a model turn.`;
  }
  if (endpoint.auth.type === "secure_store") {
    return `Store a key for endpoint ${endpointId} in the app or choose another profile before starting a model turn.`;
  }
  return undefined;
}

export class LlmProfileManager {
  private config: SloppyConfig;
  private adapterCache = new Map<string, { fingerprint: string; adapter: LlmAdapter }>();
  private readonly credentialStore: CredentialStore;
  private readonly writeConfig: (config: LlmConfig) => Promise<void>;

  constructor(options?: {
    config?: SloppyConfig;
    credentialStore?: CredentialStore;
    writeConfig?: (config: LlmConfig) => Promise<void>;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.credentialStore = options?.credentialStore ?? createCredentialStore();
    this.writeConfig = options?.writeConfig ?? writeHomeLlmConfig;
  }

  getConfig(): SloppyConfig {
    return this.config;
  }

  updateConfig(config: SloppyConfig): void {
    this.config = config;
    this.adapterCache.clear();
  }

  invalidate(): void {
    this.adapterCache.clear();
  }

  async getState(): Promise<LlmStateSnapshot> {
    const profiles = this.getAvailableProfiles();
    const secureStoreStatus = await this.credentialStore.getStatus();
    const baseProfileStates = await Promise.all(
      profiles.map(async (profile) => this.resolveProfileState(profile)),
    );

    const activeProfile =
      selectActiveProfile(this.config.llm, baseProfileStates) ??
      baseProfileStates[0] ??
      (await this.resolveProfileState(buildFallbackProfile(this.config.llm)));
    const profileStates = baseProfileStates.map((profile) => ({
      ...profile,
      isDefault: profile.id === activeProfile.id,
    }));
    const status = activeProfile.ready ? "ready" : "needs_credentials";

    return {
      status,
      message: this.buildStatusMessage(activeProfile, secureStoreStatus),
      activeProfileId: activeProfile.id,
      selectedEndpointId: activeProfile.endpointId,
      selectedProtocol: activeProfile.protocol,
      selectedModel: activeProfile.model,
      selectedContextWindowTokens: activeProfile.contextWindowTokens,
      secureStoreKind: this.credentialStore.kind,
      secureStoreStatus,
      profiles: profileStates,
    };
  }

  async createAdapter(profileId?: string, modelOverride?: string): Promise<LlmAdapter> {
    const state = await this.getState();
    const targetProfile = profileId
      ? state.profiles.find((profile) => profile.id === profileId)
      : state.profiles.find((profile) => profile.id === state.activeProfileId);
    if (!targetProfile) {
      if (profileId) {
        throw new LlmConfigurationError(
          `LLM profile '${profileId}' is not available. Add it under llm.profiles or pick another id.`,
        );
      }
      throw new LlmConfigurationError(state.message);
    }
    if (targetProfile.kind === "session-agent") {
      throw new LlmConfigurationError(
        `LLM profile '${targetProfile.id}' is a session-agent profile and cannot be used by the native LLM adapter factory.`,
      );
    }
    if (!targetProfile.ready) {
      throw new LlmConfigurationError(targetProfile.invalidReason ?? state.message);
    }
    if (!targetProfile.endpointId) {
      throw new LlmConfigurationError(`LLM profile '${targetProfile.id}' has no endpoint id.`);
    }

    const endpoint = this.config.llm.endpoints[targetProfile.endpointId];
    if (!endpoint) {
      throw new LlmConfigurationError(
        `LLM profile '${targetProfile.id}' references unknown endpoint '${targetProfile.endpointId}'.`,
      );
    }

    const credential = await this.resolveCredential(targetProfile, endpoint);
    if (!credential.ready) {
      throw new LlmConfigurationError((await this.getState()).message);
    }

    const model = modelOverride ?? targetProfile.model;
    const metadata = endpointModelMetadata(this.config.llm, {
      endpointId: targetProfile.endpointId,
      model,
    });
    const fingerprint = [
      targetProfile.id,
      targetProfile.endpointId,
      endpoint.protocol,
      model,
      targetProfile.reasoningEffort ?? "",
      JSON.stringify(targetProfile.thinking),
      endpoint.baseUrl ?? "",
      JSON.stringify(endpoint.headers ?? {}),
      JSON.stringify(metadata?.compat ?? {}),
      credential.keySource,
      credential.apiKey ?? "",
    ].join(":");
    const cacheKey = `${targetProfile.id}::${modelOverride ?? ""}`;
    const cached = this.adapterCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) {
      return cached.adapter;
    }

    const adapter = createLlmAdapter({
      endpointId: targetProfile.endpointId,
      protocol: endpoint.protocol,
      model,
      reasoningEffort: targetProfile.reasoningEffort,
      thinking: resolveEffectiveThinkingConfig({
        protocol: endpoint.protocol,
        model,
        global: this.config.llm.thinking,
        profile: targetProfile.thinking,
        reasoningEffort: targetProfile.reasoningEffort,
      }),
      apiKey: credential.apiKey,
      authHint: buildEndpointAuthHint(targetProfile.endpointId, endpoint),
      baseUrl: endpoint.baseUrl,
      compat: metadata?.compat,
    });
    this.adapterCache.set(cacheKey, { fingerprint, adapter });
    return adapter;
  }

  async ensureReady(): Promise<LlmStateSnapshot> {
    const state = await this.getState();
    if (state.status !== "ready") {
      throw new LlmConfigurationError(state.message);
    }
    return state;
  }

  async saveProfile(input: SaveProfileInput): Promise<LlmStateSnapshot> {
    const existingProfile = input.profileId
      ? this.config.llm.profiles.find((profile) => profile.id === input.profileId)
      : undefined;
    const kind =
      input.kind ?? existingProfile?.kind ?? (input.adapterId ? "session-agent" : "native");
    const model = trimOptional(input.model) ?? existingProfile?.model ?? "default";
    const profileId =
      existingProfile?.id ??
      buildProfileId({
        label: input.label,
        endpointId: input.endpointId,
        model,
      });

    const endpointId =
      trimOptional(input.endpointId) ??
      (existingProfile?.kind === "native" ? existingProfile.endpointId : undefined) ??
      "anthropic";
    const endpoint = this.config.llm.endpoints[endpointId];
    const profile: AnyLlmProfileConfig =
      kind === "session-agent"
        ? {
            kind: "session-agent",
            id: profileId,
            label: trimOptional(input.label) ?? existingProfile?.label,
            adapterId:
              trimOptional(input.adapterId) ??
              (existingProfile?.kind === "session-agent" ? existingProfile.adapterId : undefined) ??
              model,
            model,
            reasoningEffort: input.reasoningEffort ?? existingProfile?.reasoningEffort,
            thinking: {
              ...(existingProfile?.thinking ?? {}),
              ...(input.thinkingEnabled === undefined ? {} : { enabled: input.thinkingEnabled }),
              ...(input.thinkingDisplay === undefined ? {} : { display: input.thinkingDisplay }),
            },
          }
        : {
            kind: "native",
            id: profileId,
            label: trimOptional(input.label) ?? existingProfile?.label,
            endpointId,
            model:
              trimOptional(input.model) ??
              existingProfile?.model ??
              (endpoint ? defaultModelForEndpoint(endpointId, endpoint) : "default"),
            reasoningEffort: input.reasoningEffort ?? existingProfile?.reasoningEffort,
            thinking: {
              ...(existingProfile?.thinking ?? {}),
              ...(input.thinkingEnabled === undefined ? {} : { enabled: input.thinkingEnabled }),
              ...(input.thinkingDisplay === undefined ? {} : { display: input.thinkingDisplay }),
            },
          };

    if (profile.kind === "native" && !this.config.llm.endpoints[profile.endpointId]) {
      throw new Error(`Unknown LLM endpoint: ${profile.endpointId}`);
    }

    const nextProfiles = [...this.config.llm.profiles];
    const existingIndex = nextProfiles.findIndex((candidate) => candidate.id === profile.id);
    if (existingIndex === -1) {
      nextProfiles.push(profile);
    } else {
      nextProfiles[existingIndex] = profile;
    }

    const nextDefaultProfileId =
      input.makeDefault || nextProfiles.length === 1
        ? profile.id
        : (this.config.llm.defaultProfileId ?? nextProfiles[0]?.id);

    if (profile.kind === "native" && trimOptional(input.apiKey)) {
      const normalizedApiKey = normalizeApiKey(trimOptional(input.apiKey) as string);
      const invalidReason = validateApiKey(profile.endpointId, normalizedApiKey);
      if (invalidReason) {
        throw new Error(invalidReason);
      }
      const endpoint = this.config.llm.endpoints[profile.endpointId];
      if (endpoint.auth.type === "none" || endpoint.auth.type === "codex") {
        await this.credentialStore.delete(profile.endpointId);
      } else {
        await this.credentialStore.set(profile.endpointId, normalizedApiKey);
      }
    }

    await this.persistProfiles(nextProfiles, nextDefaultProfileId);
    return this.getState();
  }

  async setDefaultProfile(profileId: string): Promise<LlmStateSnapshot> {
    const profile = this.getAvailableProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    await this.persistProfiles(this.config.llm.profiles, profile.id);
    return this.getState();
  }

  async deleteProfile(profileId: string): Promise<LlmStateSnapshot> {
    const nextProfiles = this.config.llm.profiles.filter((profile) => profile.id !== profileId);
    if (nextProfiles.length === this.config.llm.profiles.length) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const nextDefaultProfileId =
      this.config.llm.defaultProfileId === profileId
        ? nextProfiles[0]?.id
        : this.config.llm.defaultProfileId;
    await this.persistProfiles(nextProfiles, nextDefaultProfileId);
    return this.getState();
  }

  async deleteApiKey(profileId: string): Promise<LlmStateSnapshot> {
    const profile = this.getAvailableProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    if (profile.kind !== "native") {
      throw new Error(`Only native profiles can delete stored endpoint credentials: ${profileId}`);
    }

    await this.credentialStore.delete(profile.endpointId);
    this.adapterCache.clear();
    return this.getState();
  }

  private async resolveProfileState(profile: ResolvedProfile): Promise<LlmProfileState> {
    if (profile.kind === "session-agent") {
      return this.resolveSessionAgentProfileState(profile);
    }

    const endpoint = this.config.llm.endpoints[profile.endpointId];
    if (!endpoint) {
      return this.resolveMissingEndpointProfileState(profile);
    }

    const credential = await this.resolveCredential(profile, endpoint);
    const metadata = endpoint.models[profile.model];
    return {
      ...profile,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      authEnv: endpoint.auth.type === "env" ? endpoint.auth.env : undefined,
      isDefault: false,
      hasKey: credential.hasKey,
      keySource: credential.keySource,
      ready: credential.ready,
      invalidReason: credential.invalidReason,
      canDeleteProfile: profile.origin === "managed",
      canDeleteApiKey: profile.origin === "managed" && endpointRequiresCredential(endpoint),
      contextWindowTokens: metadata?.contextWindowTokens,
      maxOutputTokens: metadata?.maxOutputTokens,
      thinking: resolveEffectiveThinkingConfig({
        protocol: endpoint.protocol,
        model: profile.model,
        global: this.config.llm.thinking,
        profile: profile.thinking,
        reasoningEffort: profile.reasoningEffort,
      }),
    } satisfies LlmProfileState;
  }

  private resolveSessionAgentProfileState(profile: ResolvedProfile): LlmProfileState {
    const sessionProfile = profile as LlmSessionAgentProfileConfig & ResolvedProfile;
    return {
      ...sessionProfile,
      protocol: "session-agent",
      isDefault: false,
      hasKey: false,
      keySource: "not_required",
      ready: true,
      canDeleteProfile: profile.origin === "managed",
      canDeleteApiKey: false,
      thinking: resolveEffectiveThinkingConfig({
        protocol: "session-agent",
        model: sessionProfile.model,
        global: this.config.llm.thinking,
        profile: sessionProfile.thinking,
        reasoningEffort: sessionProfile.reasoningEffort,
      }),
    } satisfies LlmProfileState;
  }

  private resolveMissingEndpointProfileState(
    profile: ResolvedProfile & { kind: "native" },
  ): LlmProfileState {
    return {
      ...profile,
      isDefault: false,
      hasKey: false,
      keySource: "missing",
      ready: false,
      invalidReason: `LLM profile '${profile.id}' references unknown endpoint '${profile.endpointId}'.`,
      canDeleteProfile: profile.origin === "managed",
      canDeleteApiKey: false,
      thinking: resolveEffectiveThinkingConfig({
        protocol: "session-agent",
        model: profile.model,
        global: this.config.llm.thinking,
        profile: profile.thinking,
        reasoningEffort: profile.reasoningEffort,
      }),
    } satisfies LlmProfileState;
  }

  private getAvailableProfiles(): ResolvedProfile[] {
    const managedProfiles: ResolvedProfile[] = this.config.llm.profiles.map((profile) => ({
      ...profile,
      managed: true,
      origin: "managed",
    }));

    const environmentProfiles = this.buildEnvironmentProfiles(managedProfiles);
    const allProfiles = [...managedProfiles, ...environmentProfiles];
    if (allProfiles.length > 0) {
      return allProfiles;
    }

    return [buildFallbackProfile(this.config.llm)];
  }

  private async persistProfiles(
    profiles: AnyLlmProfileConfig[],
    defaultProfileId?: string,
  ): Promise<void> {
    const nextLlmConfig = buildNextLlmConfig(
      this.config.llm,
      profiles,
      this.buildAvailableProfilesFromConfig({
        ...this.config.llm,
        profiles,
      }),
      defaultProfileId,
    );
    await this.writeConfig(nextLlmConfig);
    this.config = {
      ...this.config,
      llm: nextLlmConfig,
    };
    this.adapterCache.clear();
  }

  private async resolveCredential(
    profile: Pick<ResolvedProfile, "kind" | "id"> & {
      endpointId?: string;
      origin?: LlmProfileOrigin;
    },
    endpoint: LlmEndpointConfig,
  ): Promise<ResolvedCredential> {
    if (endpointUsesCodexAuth(endpoint)) {
      const status = await getCodexAuthStatus();
      return {
        keySource: status.available ? "external_auth" : "missing",
        ready: status.available,
        hasKey: status.available,
        invalidReason: status.reason,
      };
    }

    if (!endpointRequiresCredential(endpoint)) {
      return {
        keySource: "not_required",
        ready: true,
        hasKey: false,
      };
    }

    const endpointId = profile.endpointId;
    if (profile.origin === "environment" && endpoint.auth.type === "env") {
      const envKey = Bun.env[endpoint.auth.env];
      if (envKey && endpointId) {
        const normalizedApiKey = normalizeApiKey(envKey);
        const invalidReason = validateApiKey(endpointId, normalizedApiKey);
        if (invalidReason) {
          return {
            keySource: "env",
            ready: false,
            hasKey: true,
            invalidReason,
          };
        }

        return {
          keySource: "env",
          ready: true,
          hasKey: true,
          apiKey: normalizedApiKey,
        };
      }
    }

    const storedKey = endpointId ? await this.credentialStore.get(endpointId) : null;
    if (storedKey && endpointId) {
      const normalizedApiKey = normalizeApiKey(storedKey);
      const invalidReason = validateApiKey(endpointId, normalizedApiKey);
      if (invalidReason) {
        return {
          keySource: "secure_store",
          ready: false,
          hasKey: true,
          invalidReason,
        };
      }

      return {
        keySource: "secure_store",
        ready: true,
        hasKey: true,
        apiKey: normalizedApiKey,
      };
    }

    if (endpoint.auth.type === "env") {
      const envKey = Bun.env[endpoint.auth.env];
      if (envKey && endpointId) {
        const normalizedApiKey = normalizeApiKey(envKey);
        const invalidReason = validateApiKey(endpointId, normalizedApiKey);
        if (invalidReason) {
          return {
            keySource: "env",
            ready: false,
            hasKey: true,
            invalidReason,
          };
        }

        return {
          keySource: "env",
          ready: true,
          hasKey: true,
          apiKey: normalizedApiKey,
        };
      }
    }

    return {
      keySource: "missing",
      ready: false,
      hasKey: false,
    };
  }

  private buildStatusMessage(
    profile: Pick<
      LlmProfileState,
      | "kind"
      | "endpointId"
      | "protocol"
      | "model"
      | "authEnv"
      | "ready"
      | "keySource"
      | "managed"
      | "origin"
      | "invalidReason"
    >,
    secureStoreStatus: CredentialStoreStatus,
  ): string {
    if (profile.invalidReason) {
      return profile.invalidReason;
    }

    if (profile.ready) {
      if (profile.kind === "session-agent") {
        return `Ready to chat with session-agent profile ${profile.model}.`;
      }
      if (profile.keySource === "not_required") {
        return `Ready to chat with ${profile.endpointId} ${profile.model}.`;
      }
      if (profile.keySource === "external_auth") {
        return `Ready to chat with ${profile.endpointId} ${profile.model} using external auth.`;
      }
      if (profile.keySource === "env") {
        return `Ready to chat with ${profile.endpointId} ${profile.model} using ${profile.authEnv}.`;
      }
      return `Ready to chat with ${profile.endpointId} ${profile.model} using stored credentials.`;
    }

    if (profile.origin === "environment") {
      if (profile.authEnv) {
        return `Set ${profile.authEnv} again or choose another profile before starting a model turn.`;
      }
      return "Choose another profile before starting a model turn.";
    }

    const endpointLabel = profile.endpointId ?? "the selected endpoint";
    if (!profile.managed) {
      const envHint = profile.authEnv
        ? ` You can also set ${profile.authEnv} to use ${endpointLabel} immediately.`
        : "";

      if (secureStoreStatus !== "available") {
        return `No ready LLM profile is configured yet. Add a profile and endpoint credential in the app.${envHint} Secure storage is ${secureStoreStatus} on this machine.`;
      }

      return `No ready LLM profile is configured yet. Add a profile and endpoint credential in the app.${envHint}`;
    }

    if (secureStoreStatus !== "available") {
      if (profile.authEnv) {
        return `Add an API key for ${endpointLabel} ${profile.model}. ${profile.authEnv} works immediately, but secure storage is ${secureStoreStatus} on this machine.`;
      }
      return `Add an API key for ${endpointLabel} ${profile.model}. Secure storage is ${secureStoreStatus} on this machine.`;
    }

    if (profile.authEnv) {
      return `Add an API key for ${endpointLabel} ${profile.model} or set ${profile.authEnv}.`;
    }

    return `Add an API key for ${endpointLabel} ${profile.model}.`;
  }

  private buildAvailableProfilesFromConfig(config: LlmConfig): ResolvedProfile[] {
    const managedProfiles: ResolvedProfile[] = config.profiles.map((profile) => ({
      ...profile,
      managed: true,
      origin: "managed",
    }));

    const environmentProfiles = this.buildEnvironmentProfiles(managedProfiles, config);
    const allProfiles = [...managedProfiles, ...environmentProfiles];
    if (allProfiles.length > 0) {
      return allProfiles;
    }

    return [buildFallbackProfile(config)];
  }

  private buildEnvironmentProfiles(
    managedProfiles: ResolvedProfile[],
    config = this.config.llm,
  ): ResolvedProfile[] {
    const environmentProfiles = new Map<string, ResolvedProfile>();

    const addEnvironmentProfile = (
      endpointId: string,
      endpoint: LlmEndpointConfig,
      model: string,
    ) => {
      if (endpoint.auth.type !== "env" || !Bun.env[endpoint.auth.env]) {
        return;
      }

      const id = buildEnvironmentProfileId({ endpointId, model, env: endpoint.auth.env });
      if (environmentProfiles.has(id)) {
        return;
      }

      environmentProfiles.set(id, {
        kind: "native",
        id,
        label: `${endpoint.label ?? endpointId} (${endpoint.auth.env})`,
        endpointId,
        model,
        managed: false,
        origin: "environment",
      });
    };

    for (const profile of managedProfiles) {
      if (profile.kind !== "native") {
        continue;
      }
      const endpoint = config.endpoints[profile.endpointId];
      if (endpoint) {
        addEnvironmentProfile(profile.endpointId, endpoint, profile.model);
      }
    }

    for (const [endpointId, endpoint] of Object.entries(config.endpoints)) {
      addEnvironmentProfile(endpointId, endpoint, defaultModelForEndpoint(endpointId, endpoint));
    }

    return [...environmentProfiles.values()].sort((left, right) =>
      (left.label ?? left.id).localeCompare(right.label ?? right.id),
    );
  }
}

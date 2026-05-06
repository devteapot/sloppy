import { defaultConfigPromise } from "../config/load";
import { writeHomeLlmConfig } from "../config/persist";
import type {
  LlmConfig,
  LlmProfileConfig,
  LlmProvider,
  LlmReasoningEffort,
  SloppyConfig,
} from "../config/schema";
import {
  type CredentialStore,
  type CredentialStoreKind,
  type CredentialStoreStatus,
  createCredentialStore,
} from "./credential-store";
import { createLlmAdapter } from "./factory";
import { getCodexAuthStatus } from "./openai-codex";
import {
  DEFAULT_LLM_PROVIDER_CONFIG,
  getProviderDefaults,
  providerRequiresApiKey,
  providerUsesCodexAuth,
} from "./provider-defaults";
import type { LlmAdapter } from "./types";

const DEFAULT_CONFIG = await defaultConfigPromise;

export type LlmKeySource = "env" | "secure_store" | "missing" | "not_required" | "external_auth";
export type LlmProfileOrigin = "managed" | "environment" | "fallback";

type ResolvedProfile = LlmProfileConfig & {
  origin: LlmProfileOrigin;
  managed: boolean;
};

export type LlmProfileState = LlmProfileConfig & {
  isDefault: boolean;
  hasKey: boolean;
  keySource: LlmKeySource;
  ready: boolean;
  managed: boolean;
  origin: LlmProfileOrigin;
  canDeleteProfile: boolean;
  canDeleteApiKey: boolean;
  invalidReason?: string;
};

export type LlmStateSnapshot = {
  status: "ready" | "needs_credentials";
  message: string;
  activeProfileId: string;
  selectedProvider: string;
  selectedModel: string;
  secureStoreKind: CredentialStoreKind;
  secureStoreStatus: CredentialStoreStatus;
  profiles: LlmProfileState[];
};

export type SaveProfileInput = {
  profileId?: string;
  label?: string;
  provider: LlmProvider;
  model?: string;
  reasoningEffort?: LlmReasoningEffort;
  adapterId?: string;
  baseUrl?: string;
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

function validateApiKey(provider: LlmProvider, apiKey: string): string | null {
  if (provider === "openrouter") {
    if (!apiKey.startsWith("sk-or-v1-") && !apiKey.startsWith("sk-or-")) {
      return "The configured OpenRouter API key does not look valid. OpenRouter keys usually start with sk-or-v1-.";
    }
  }

  return null;
}

function sanitizeIdSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return sanitized || "default";
}

export class LlmConfigurationError extends Error {
  readonly code = "llm_not_configured";

  constructor(message: string) {
    super(message);
    this.name = "LlmConfigurationError";
  }
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

function buildProfileId(input: { label?: string; provider: LlmProvider; model: string }): string {
  const base = slugifySegment(input.label ?? `${input.provider}-${input.model}`) || input.provider;
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base}-${suffix}`;
}

function buildFallbackProfile(config: LlmConfig): LlmProfileConfig {
  const defaults = getProviderDefaults(config.provider);

  return {
    id: "default",
    label: "Default",
    provider: config.provider,
    model: config.model || defaults.model,
    reasoningEffort: config.reasoningEffort,
    apiKeyEnv: config.apiKeyEnv ?? defaults.apiKeyEnv,
    baseUrl: config.baseUrl ?? defaults.baseUrl,
    adapterId: config.adapterId ?? defaults.adapterId,
  };
}

function buildEnvironmentProfileId(
  profile: Pick<LlmProfileConfig, "provider" | "model" | "apiKeyEnv">,
): string {
  return [
    "env",
    sanitizeIdSegment(profile.provider),
    sanitizeIdSegment(profile.apiKeyEnv ?? "key"),
    sanitizeIdSegment(profile.model),
  ].join("-");
}

function buildEnvironmentLabel(
  profile: Pick<LlmProfileConfig, "provider" | "apiKeyEnv" | "label">,
): string {
  const baseLabel = profile.label?.trim() || profile.provider;
  if (profile.apiKeyEnv) {
    return `${baseLabel} (${profile.apiKeyEnv})`;
  }

  return `${baseLabel} (Environment)`;
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

  const preferredEnvironmentProfile = profiles.find(
    (profile) =>
      profile.origin === "environment" && profile.provider === config.provider && profile.ready,
  );
  if (preferredEnvironmentProfile) {
    return preferredEnvironmentProfile;
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
  profiles: LlmProfileConfig[],
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
    provider: activeProfile.provider,
    model: activeProfile.model,
    reasoningEffort: activeProfile.reasoningEffort,
    adapterId: activeProfile.adapterId,
    apiKeyEnv: activeProfile.apiKeyEnv,
    baseUrl: activeProfile.baseUrl,
    defaultProfileId: activeProfile.origin === "fallback" ? undefined : activeProfile.id,
    profiles,
  };
}

export class LlmProfileManager {
  private config: SloppyConfig;
  private adapterCache = new Map<string, { fingerprint: string; adapter: LlmAdapter }>();

  constructor(options?: {
    config?: SloppyConfig;
    credentialStore?: CredentialStore;
    writeConfig?: (config: LlmConfig) => Promise<void>;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.credentialStore = options?.credentialStore ?? createCredentialStore();
    this.writeConfig = options?.writeConfig ?? writeHomeLlmConfig;
  }

  private readonly credentialStore: CredentialStore;
  private readonly writeConfig: (config: LlmConfig) => Promise<void>;

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
      profiles.map(async (profile) => {
        const credential = await this.resolveCredential(profile);
        return {
          ...profile,
          isDefault: false,
          hasKey: credential.hasKey,
          keySource: credential.keySource,
          ready: credential.ready,
          invalidReason: credential.invalidReason,
          managed: profile.managed,
          origin: profile.origin,
          canDeleteProfile: profile.origin === "managed",
          canDeleteApiKey: profile.origin === "managed" && providerRequiresApiKey(profile.provider),
        } satisfies LlmProfileState;
      }),
    );

    const activeProfile = selectActiveProfile(this.config.llm, baseProfileStates) ??
      baseProfileStates[0] ?? {
        ...buildFallbackProfile(this.config.llm),
        isDefault: false,
        hasKey: false,
        keySource: "missing",
        ready: false,
        invalidReason: undefined,
        managed: false,
        origin: "fallback",
        canDeleteProfile: false,
        canDeleteApiKey: false,
      };
    const profileStates = baseProfileStates.map((profile) => ({
      ...profile,
      isDefault: profile.id === activeProfile.id,
    }));
    const status = activeProfile.ready ? "ready" : "needs_credentials";

    return {
      status,
      message: this.buildStatusMessage(activeProfile, secureStoreStatus),
      activeProfileId: activeProfile.id,
      selectedProvider: activeProfile.provider,
      selectedModel: activeProfile.model,
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
    if (!targetProfile.ready) {
      throw new LlmConfigurationError(targetProfile.invalidReason ?? state.message);
    }

    const credential = await this.resolveCredential(targetProfile);
    if (!credential.ready) {
      throw new LlmConfigurationError((await this.getState()).message);
    }

    const model = modelOverride ?? targetProfile.model;
    const fingerprint = [
      targetProfile.id,
      targetProfile.provider,
      model,
      targetProfile.reasoningEffort ?? "",
      targetProfile.adapterId ?? "",
      targetProfile.baseUrl ?? "",
      credential.keySource,
      credential.apiKey ?? "",
    ].join(":");
    const cacheKey = `${targetProfile.id}::${modelOverride ?? ""}`;
    const cached = this.adapterCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) {
      return cached.adapter;
    }

    const adapter = createLlmAdapter({
      provider: targetProfile.provider,
      model,
      reasoningEffort: targetProfile.reasoningEffort,
      apiKey: credential.apiKey,
      apiKeyEnv: targetProfile.apiKeyEnv,
      baseUrl: targetProfile.baseUrl,
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
    const defaults = getProviderDefaults(input.provider);
    const existingProfile = input.profileId
      ? this.config.llm.profiles.find((profile) => profile.id === input.profileId)
      : undefined;
    const profileId =
      existingProfile?.id ??
      buildProfileId({
        label: input.label,
        provider: input.provider,
        model: input.model ?? defaults.model,
      });
    const profile: LlmProfileConfig = {
      id: profileId,
      label: trimOptional(input.label) ?? existingProfile?.label,
      provider: input.provider,
      model: trimOptional(input.model) ?? existingProfile?.model ?? defaults.model,
      reasoningEffort: input.reasoningEffort ?? existingProfile?.reasoningEffort,
      adapterId: trimOptional(input.adapterId) ?? existingProfile?.adapterId ?? defaults.adapterId,
      apiKeyEnv:
        existingProfile && existingProfile.provider === input.provider
          ? (existingProfile.apiKeyEnv ?? defaults.apiKeyEnv)
          : defaults.apiKeyEnv,
      baseUrl:
        trimOptional(input.baseUrl) ??
        (existingProfile && existingProfile.provider === input.provider
          ? existingProfile.baseUrl
          : defaults.baseUrl),
    };

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

    if (trimOptional(input.apiKey)) {
      const normalizedApiKey = normalizeApiKey(trimOptional(input.apiKey) as string);
      const invalidReason = validateApiKey(profile.provider, normalizedApiKey);
      if (invalidReason) {
        throw new Error(invalidReason);
      }

      if (!providerRequiresApiKey(profile.provider)) {
        await this.credentialStore.delete(profile.id);
      } else {
        await this.credentialStore.set(profile.id, normalizedApiKey);
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

    await this.credentialStore.delete(profileId);
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

    if (profile.origin !== "managed") {
      throw new Error(`Only managed profiles can delete stored API keys: ${profileId}`);
    }

    await this.credentialStore.delete(profileId);
    this.adapterCache.clear();
    return this.getState();
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

    return [
      {
        ...buildFallbackProfile(this.config.llm),
        managed: false,
        origin: "fallback",
      },
    ];
  }

  private async persistProfiles(
    profiles: LlmProfileConfig[],
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

  private async resolveCredential(profile: ResolvedProfile): Promise<ResolvedCredential> {
    if (providerUsesCodexAuth(profile.provider)) {
      const status = await getCodexAuthStatus();
      return {
        keySource: status.available ? "external_auth" : "missing",
        ready: status.available,
        hasKey: status.available,
        invalidReason: status.reason,
      };
    }

    if (!providerRequiresApiKey(profile.provider)) {
      return {
        keySource: "not_required",
        ready: true,
        hasKey: false,
        apiKey: undefined,
      };
    }

    if (profile.origin === "environment") {
      const envName = profile.apiKeyEnv;
      const envKey = envName ? Bun.env[envName] : undefined;
      if (envKey) {
        const normalizedApiKey = normalizeApiKey(envKey);
        const invalidReason = validateApiKey(profile.provider, normalizedApiKey);
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

      return {
        keySource: "missing",
        ready: false,
        hasKey: false,
      };
    }

    const storedKey = await this.credentialStore.get(profile.id);
    if (storedKey) {
      const normalizedApiKey = normalizeApiKey(storedKey);
      const invalidReason = validateApiKey(profile.provider, normalizedApiKey);
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

    return {
      keySource: "missing",
      ready: false,
      hasKey: false,
    };
  }

  private buildStatusMessage(
    profile: Pick<
      LlmProfileState,
      | "provider"
      | "model"
      | "apiKeyEnv"
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
      if (profile.keySource === "not_required") {
        return `Ready to chat with ${profile.provider} ${profile.model}.`;
      }

      if (profile.keySource === "external_auth") {
        return `Ready to chat with ${profile.provider} ${profile.model} using Codex auth.`;
      }

      if (profile.keySource === "env") {
        return `Ready to chat with ${profile.provider} ${profile.model} using ${profile.apiKeyEnv}.`;
      }

      return `Ready to chat with ${profile.provider} ${profile.model} using stored credentials.`;
    }

    if (profile.origin === "environment") {
      if (profile.apiKeyEnv) {
        return `Set ${profile.apiKeyEnv} again or choose another profile before starting a model turn.`;
      }

      return `Choose another profile before starting a model turn.`;
    }

    if (!profile.managed) {
      const envHint = profile.apiKeyEnv
        ? ` You can also set ${profile.apiKeyEnv} to use the current default ${profile.provider} profile immediately.`
        : "";

      if (secureStoreStatus !== "available") {
        return `No ready LLM profile is configured yet. Add a profile and API key in the app.${envHint} Secure storage is ${secureStoreStatus} on this machine.`;
      }

      return `No ready LLM profile is configured yet. Add a profile and API key in the app.${envHint}`;
    }

    if (secureStoreStatus !== "available") {
      if (profile.apiKeyEnv) {
        return `Add an API key for ${profile.provider} ${profile.model}. ${profile.apiKeyEnv} works immediately, but secure storage is ${secureStoreStatus} on this machine.`;
      }

      return `Add an API key for ${profile.provider} ${profile.model}. Secure storage is ${secureStoreStatus} on this machine.`;
    }

    if (profile.apiKeyEnv) {
      return `Add an API key for ${profile.provider} ${profile.model} or set ${profile.apiKeyEnv}.`;
    }

    return `Add an API key for ${profile.provider} ${profile.model}.`;
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

    return [
      {
        ...buildFallbackProfile(config),
        managed: false,
        origin: "fallback",
      },
    ];
  }

  private buildEnvironmentProfiles(
    managedProfiles: ResolvedProfile[],
    config = this.config.llm,
  ): ResolvedProfile[] {
    const environmentProfiles = new Map<string, ResolvedProfile>();

    const addEnvironmentProfile = (profile: LlmProfileConfig) => {
      if (!profile.apiKeyEnv || !Bun.env[profile.apiKeyEnv]) {
        return;
      }

      const id = buildEnvironmentProfileId(profile);
      if (environmentProfiles.has(id)) {
        return;
      }

      environmentProfiles.set(id, {
        ...profile,
        id,
        label: buildEnvironmentLabel(profile),
        managed: false,
        origin: "environment",
      });
    };

    for (const profile of managedProfiles) {
      addEnvironmentProfile(profile);
    }

    addEnvironmentProfile(buildFallbackProfile(config));

    for (const [provider, defaults] of Object.entries(DEFAULT_LLM_PROVIDER_CONFIG) as Array<
      [LlmProvider, (typeof DEFAULT_LLM_PROVIDER_CONFIG)[LlmProvider]]
    >) {
      if (!defaults.apiKeyEnv || !Bun.env[defaults.apiKeyEnv]) {
        continue;
      }

      addEnvironmentProfile({
        id: `environment-${provider}`,
        label: provider,
        provider,
        model: defaults.model,
        apiKeyEnv: defaults.apiKeyEnv,
        baseUrl: defaults.baseUrl,
      });
    }

    return [...environmentProfiles.values()].sort((left, right) =>
      (left.label ?? left.provider).localeCompare(right.label ?? right.provider),
    );
  }
}

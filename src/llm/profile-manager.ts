import { createDefaultConfig } from "../config/load";
import { writeHomeLlmConfig } from "../config/persist";
import {
  type AnyLlmProfileConfig,
  DEFAULT_LLM_REQUEST_POLICY,
  isSensitiveLlmHeaderName,
  type LlmConfig,
  type LlmEndpointConfig,
  type LlmEndpointModelCapabilitiesConfig,
  type LlmEndpointModelConfig,
  type LlmReasoningEffort,
  type LlmSessionAgentProfileConfig,
  type LlmThinkingDisplay,
  type SloppyConfig,
} from "../config/schema";
import { endpointRequiresCredential, getDefaultEndpointModel } from "./catalog";
import {
  CredentialResolver,
  type LlmKeySource,
  normalizeApiKey,
  validateApiKey,
} from "./credential-resolver";
import {
  type CredentialStore,
  type CredentialStoreKind,
  type CredentialStoreStatus,
  createCredentialStore,
} from "./credential-store";
import {
  createLlmAdapter,
  resolveEnforcedMaxOutputTokens,
  validateLlmAdapterConfig,
} from "./factory";
import { type LlmRequestPolicy, ResilientLlmAdapter, validateLlmRequestPolicy } from "./resilience";
import { type EffectiveThinkingConfig, resolveEffectiveThinkingConfig } from "./thinking";
import type { LlmAdapter } from "./types";

const DEFAULT_CONFIG = createDefaultConfig();

export type { LlmKeySource } from "./credential-resolver";
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
  capabilities?: LlmEndpointModelCapabilitiesConfig;
  ownsToolLoop?: boolean;
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
  selectedMaxOutputTokens?: number;
  selectedCapabilities?: LlmEndpointModelCapabilitiesConfig;
  selectedOwnsToolLoop?: boolean;
  secureStoreKind: CredentialStoreKind;
  secureStoreStatus: CredentialStoreStatus;
  profiles: LlmProfileState[];
};

export type LlmProfileRoute = {
  profileId?: string;
  modelOverride?: string;
};

export type LlmProfileBindingLease = symbol;

type LlmProfileMutation = "delete" | "delete_api_key" | "save" | "set_default";
type LlmProfileReadToken = { revision: number; mutationGeneration: number };

class LlmAdapterSnapshotChangedError extends Error {}

export class LlmProfileBindingRegistry {
  private readonly bindings = new Map<LlmProfileBindingLease, string>();
  private revision = 0;
  // Credential-only mutations invalidate adapter reads without staling config writers.
  private mutationGeneration = 0;
  private activeMutation:
    | { token: symbol; operation: LlmProfileMutation; profileId: string }
    | undefined;

  getRevision(): number {
    return this.revision;
  }

  isStableRevision(expectedRevision: number): boolean {
    return this.activeMutation === undefined && this.revision === expectedRevision;
  }

  captureReadToken(): LlmProfileReadToken {
    return {
      revision: this.revision,
      mutationGeneration: this.mutationGeneration,
    };
  }

  isStableReadToken(token: LlmProfileReadToken): boolean {
    return (
      this.activeMutation === undefined &&
      this.revision === token.revision &&
      this.mutationGeneration === token.mutationGeneration
    );
  }

  assertStableRevision(expectedRevision: number): void {
    if (this.activeMutation) {
      throw new Error(
        `Cannot register LLM profile configuration while profile '${this.activeMutation.profileId}' is being modified. Retry after the current profile mutation finishes.`,
      );
    }
    if (expectedRevision !== this.revision) {
      throw new Error(
        "LLM profile configuration changed while it was loading. Reload config before constructing the profile manager.",
      );
    }
  }

  acquire(profileId?: string): LlmProfileBindingLease {
    const lease = Symbol("llm-profile-binding");
    this.move(lease, profileId);
    return lease;
  }

  move(lease: LlmProfileBindingLease, profileId?: string): void {
    if (!profileId) {
      this.bindings.delete(lease);
      return;
    }
    if (
      this.activeMutation?.operation === "delete" &&
      this.activeMutation.profileId === profileId
    ) {
      throw new LlmConfigurationError(
        `LLM profile '${profileId}' is being deleted and cannot be bound to a session.`,
      );
    }
    this.bindings.set(lease, profileId);
  }

  release(lease: LlmProfileBindingLease): void {
    this.bindings.delete(lease);
  }

  beginMutation(
    operation: LlmProfileMutation,
    profileId: string,
    expectedRevision: number,
    options: { requireUnbound?: boolean } = {},
  ): (committed?: boolean) => number {
    if (this.activeMutation) {
      throw new Error(
        `Cannot ${operation.replaceAll("_", " ")} LLM profile '${profileId}' while profile '${this.activeMutation.profileId}' is being modified. Retry after the current profile mutation finishes.`,
      );
    }
    if (expectedRevision !== this.revision) {
      throw new Error(
        `Cannot ${operation.replaceAll("_", " ")} LLM profile '${profileId}' because LLM profile configuration changed in another session. Reload config before retrying.`,
      );
    }

    if (options.requireUnbound) {
      const bindingCount = [...this.bindings.values()].filter(
        (boundProfileId) => boundProfileId === profileId,
      ).length;
      if (bindingCount > 0) {
        throw new Error(
          `Cannot delete LLM profile '${profileId}' while a live session is bound to it. Stop or reroute that session first.`,
        );
      }
    }

    const token = Symbol("llm-profile-mutation");
    this.mutationGeneration += 1;
    this.activeMutation = { token, operation, profileId };
    let released = false;
    return (committed = false) => {
      if (released) return this.revision;
      released = true;
      if (this.activeMutation?.token === token) {
        if (committed) {
          this.revision += 1;
        }
        this.activeMutation = undefined;
      }
      return this.revision;
    };
  }

  prepareConfigUpdate(expectedRevision: number, llmConfigChanged: boolean): number {
    if (this.activeMutation) {
      throw new Error(
        `Cannot reload LLM configuration while profile '${this.activeMutation.profileId}' is being modified. Retry after the current profile mutation finishes.`,
      );
    }

    if (expectedRevision !== this.revision) {
      throw new Error(
        "LLM profile configuration changed while config was loading. Reload config again before retrying.",
      );
    }
    if (llmConfigChanged) {
      this.revision += 1;
    }
    return this.revision;
  }
}

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
    model: endpoint
      ? defaultModelForEndpoint(endpointId, endpoint)
      : (getDefaultEndpointModel(endpointId) ?? "default"),
    reasoningEffort: config.reasoningEffort,
    thinking: config.thinking,
    managed: false,
    origin: "fallback",
  };
}

function buildUnavailableRoutedProfile(
  config: LlmConfig,
  route: Required<Pick<LlmProfileRoute, "profileId">> & Pick<LlmProfileRoute, "modelOverride">,
): LlmProfileState {
  const model = route.modelOverride ?? "unavailable";
  const reasoningEffort = config.reasoningEffort;
  return {
    kind: "native",
    id: route.profileId,
    model,
    reasoningEffort,
    isDefault: true,
    hasKey: false,
    keySource: "missing",
    ready: false,
    managed: false,
    origin: "fallback",
    canDeleteProfile: false,
    canDeleteApiKey: false,
    ownsToolLoop: false,
    invalidReason: `LLM profile '${route.profileId}' is not available. Add it under llm.profiles or select another profile for this session.`,
    thinking: resolveEffectiveThinkingConfig({
      protocol: "session-agent",
      model,
      global: config.thinking,
      reasoningEffort,
    }),
  };
}

function resolveProfileReasoningEffort(
  config: LlmConfig,
  profile: Pick<AnyLlmProfileConfig, "reasoningEffort">,
): LlmReasoningEffort | undefined {
  return profile.reasoningEffort ?? config.reasoningEffort;
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

type EndpointHeaderResolution = {
  headers?: Record<string, string>;
  invalidReason?: string;
};

function resolveEndpointHeaders(
  endpointId: string,
  endpoint: LlmEndpointConfig,
): EndpointHeaderResolution {
  const literalHeaders = endpoint.headers ?? {};
  const sensitiveLiteral = Object.keys(literalHeaders).find(isSensitiveLlmHeaderName);
  if (sensitiveLiteral) {
    return {
      invalidReason: `LLM endpoint '${endpointId}' stores sensitive header '${sensitiveLiteral}' as a literal. Move it to headerEnv so only the environment variable name is persisted.`,
    };
  }

  try {
    const headers = new Headers(literalHeaders);
    for (const [name, envName] of Object.entries(endpoint.headerEnv ?? {})) {
      const value = Bun.env[envName];
      if (!value) {
        return {
          invalidReason: `LLM endpoint '${endpointId}' requires ${envName} for header '${name}'.`,
        };
      }
      headers.set(name, value);
    }
    const resolved: Record<string, string> = {};
    headers.forEach((value, name) => {
      resolved[name] = value;
    });
    return Object.keys(resolved).length > 0 ? { headers: resolved } : {};
  } catch (error) {
    return {
      invalidReason: `LLM endpoint '${endpointId}' has an invalid header configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateNativeEndpointRuntime(
  endpointId: string,
  endpoint: LlmEndpointConfig,
  model: string,
  resolvedHeaders: EndpointHeaderResolution,
): string | undefined {
  if (resolvedHeaders.invalidReason) {
    return resolvedHeaders.invalidReason;
  }
  return validateLlmAdapterConfig({
    endpointId,
    protocol: endpoint.protocol,
    authType: endpoint.auth.type,
    model,
    baseUrl: endpoint.baseUrl,
    headers: resolvedHeaders.headers,
    hasSecretHeaders: Object.keys(endpoint.headerEnv ?? {}).length > 0,
  });
}

function resolveLlmRequestPolicy(config: LlmConfig): LlmRequestPolicy {
  return {
    ...DEFAULT_LLM_REQUEST_POLICY,
    ...config.requestPolicy,
  };
}

function validateResolvedLlmRequestPolicy(policy: LlmRequestPolicy): string | undefined {
  const invalidReason = validateLlmRequestPolicy(policy);
  return invalidReason ? `Invalid LLM request policy: ${invalidReason}` : undefined;
}

function hashResolvedHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(headers)).digest("hex");
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
  private readonly profileBindingRegistry: LlmProfileBindingRegistry;
  private profileRevision: number;
  private readonly credentialStore: CredentialStore;
  private readonly credentials: CredentialResolver;
  private readonly writeConfig: (config: LlmConfig) => Promise<void>;

  constructor(options?: {
    config?: SloppyConfig;
    credentialStore?: CredentialStore;
    writeConfig?: (config: LlmConfig) => Promise<void>;
    profileBindingRegistry?: LlmProfileBindingRegistry;
    expectedRevision?: number;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.credentialStore = options?.credentialStore ?? createCredentialStore();
    this.credentials = new CredentialResolver(this.credentialStore);
    this.writeConfig = options?.writeConfig ?? writeHomeLlmConfig;
    this.profileBindingRegistry =
      options?.profileBindingRegistry ?? new LlmProfileBindingRegistry();
    if (options?.profileBindingRegistry && options.expectedRevision === undefined) {
      throw new Error(
        "expectedRevision is required when constructing an LLM profile manager with a shared binding registry.",
      );
    }
    const expectedRevision = options?.expectedRevision ?? this.profileBindingRegistry.getRevision();
    this.profileBindingRegistry.assertStableRevision(expectedRevision);
    this.profileRevision = expectedRevision;
  }

  getConfig(): SloppyConfig {
    return this.config;
  }

  captureConfigRevision(): number {
    return this.profileBindingRegistry.getRevision();
  }

  updateConfig(config: SloppyConfig, options: { expectedRevision?: number } = {}): void {
    if (config === this.config) {
      if (options.expectedRevision !== undefined) {
        this.profileRevision = this.profileBindingRegistry.prepareConfigUpdate(
          options.expectedRevision,
          false,
        );
      }
      this.adapterCache.clear();
      return;
    }
    this.profileRevision = this.profileBindingRegistry.prepareConfigUpdate(
      options.expectedRevision ?? this.profileRevision,
      JSON.stringify(this.config.llm) !== JSON.stringify(config.llm),
    );
    this.config = config;
    this.adapterCache.clear();
  }

  invalidate(): void {
    this.adapterCache.clear();
  }

  acquireProfileBinding(profileId?: string): LlmProfileBindingLease {
    return this.profileBindingRegistry.acquire(profileId);
  }

  moveProfileBinding(lease: LlmProfileBindingLease, profileId?: string): void {
    this.profileBindingRegistry.move(lease, profileId);
  }

  releaseProfileBinding(lease: LlmProfileBindingLease): void {
    this.profileBindingRegistry.release(lease);
  }

  async getState(route: LlmProfileRoute = {}): Promise<LlmStateSnapshot> {
    return this.getStateForConfig(this.config, route);
  }

  private async getStateForConfig(
    config: SloppyConfig,
    route: LlmProfileRoute = {},
  ): Promise<LlmStateSnapshot> {
    const profiles = this.getAvailableProfiles(config.llm);
    const secureStoreStatus = await this.credentialStore.getStatus();
    const baseProfileStates = await Promise.all(
      profiles.map(async (profile) => this.resolveProfileState(profile, config)),
    );

    const routedProfile = route.profileId
      ? profiles.find((profile) => profile.id === route.profileId)
      : undefined;
    const unavailableRoutedProfile =
      route.profileId && !routedProfile
        ? buildUnavailableRoutedProfile(config.llm, {
            profileId: route.profileId,
            modelOverride: route.modelOverride,
          })
        : undefined;

    const activeBaseProfile = unavailableRoutedProfile
      ? unavailableRoutedProfile
      : routedProfile
        ? baseProfileStates.find((profile) => profile.id === routedProfile.id)
        : selectActiveProfile(config.llm, baseProfileStates);
    let activeProfile =
      activeBaseProfile ??
      baseProfileStates[0] ??
      (await this.resolveProfileState(buildFallbackProfile(config.llm), config));
    if (route.modelOverride && !unavailableRoutedProfile) {
      const sourceProfile =
        routedProfile ?? profiles.find((profile) => profile.id === activeProfile.id);
      if (sourceProfile) {
        activeProfile = await this.resolveProfileState(
          {
            ...sourceProfile,
            model: route.modelOverride,
          },
          config,
        );
      }
    }
    const profileStates = unavailableRoutedProfile
      ? [
          ...baseProfileStates.map((profile) => ({ ...profile, isDefault: false })),
          unavailableRoutedProfile,
        ]
      : baseProfileStates.map((profile) => ({
          ...(profile.id === activeProfile.id ? activeProfile : profile),
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
      selectedMaxOutputTokens: activeProfile.maxOutputTokens,
      selectedCapabilities: activeProfile.capabilities,
      selectedOwnsToolLoop: activeProfile.ownsToolLoop,
      secureStoreKind: this.credentialStore.kind,
      secureStoreStatus,
      profiles: profileStates,
    };
  }

  async createAdapter(profileId?: string, modelOverride?: string): Promise<LlmAdapter> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const config = this.config;
      const readToken = this.profileBindingRegistry.captureReadToken();
      try {
        this.assertStableAdapterSnapshot(config, readToken);
        return await this.createAdapterFromSnapshot(config, readToken, profileId, modelOverride);
      } catch (error) {
        if (error instanceof LlmAdapterSnapshotChangedError && attempt === 0) {
          continue;
        }
        if (error instanceof LlmAdapterSnapshotChangedError) {
          throw new LlmConfigurationError(
            "LLM profile or credential configuration changed while the adapter was being created. Retry the model turn.",
          );
        }
        throw error;
      }
    }
    throw new LlmConfigurationError(
      "LLM profile or credential configuration changed while the adapter was being created. Retry the model turn.",
    );
  }

  private async createAdapterFromSnapshot(
    config: SloppyConfig,
    readToken: LlmProfileReadToken,
    profileId?: string,
    modelOverride?: string,
  ): Promise<LlmAdapter> {
    const state = await this.getStateForConfig(config);
    this.assertStableAdapterSnapshot(config, readToken);
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

    const endpoint = config.llm.endpoints[targetProfile.endpointId];
    if (!endpoint) {
      throw new LlmConfigurationError(
        `LLM profile '${targetProfile.id}' references unknown endpoint '${targetProfile.endpointId}'.`,
      );
    }

    const requestPolicy = resolveLlmRequestPolicy(config.llm);
    const requestPolicyInvalidReason = validateResolvedLlmRequestPolicy(requestPolicy);
    if (requestPolicyInvalidReason) {
      throw new LlmConfigurationError(requestPolicyInvalidReason);
    }

    const credential = await this.credentials.resolve(targetProfile, endpoint);
    this.assertStableAdapterSnapshot(config, readToken);
    if (!credential.ready) {
      throw new LlmConfigurationError((await this.getStateForConfig(config)).message);
    }

    const model = modelOverride ?? targetProfile.model;
    const metadata = endpointModelMetadata(config.llm, {
      endpointId: targetProfile.endpointId,
      model,
    });
    const resolvedHeaders = resolveEndpointHeaders(targetProfile.endpointId, endpoint);
    const runtimeInvalidReason = validateNativeEndpointRuntime(
      targetProfile.endpointId,
      endpoint,
      model,
      resolvedHeaders,
    );
    if (runtimeInvalidReason) {
      throw new LlmConfigurationError(runtimeInvalidReason);
    }
    const fingerprint = [
      targetProfile.id,
      targetProfile.endpointId,
      endpoint.protocol,
      model,
      targetProfile.reasoningEffort ?? "",
      JSON.stringify(targetProfile.thinking),
      JSON.stringify(config.llm.thinking),
      endpoint.baseUrl ?? "",
      JSON.stringify(endpoint.auth),
      hashResolvedHeaders(resolvedHeaders.headers),
      JSON.stringify(metadata ?? {}),
      JSON.stringify(requestPolicy),
      credential.keySource,
      // Hash the key so rotation still invalidates the cache without
      // retaining raw key material in the fingerprint string.
      credential.apiKey
        ? new Bun.CryptoHasher("sha256").update(credential.apiKey).digest("hex")
        : "",
    ].join(":");
    const cacheKey = `${targetProfile.id}::${modelOverride ?? ""}`;
    this.assertStableAdapterSnapshot(config, readToken);
    const cached = this.adapterCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) {
      return cached.adapter;
    }

    const nativeAdapter = createLlmAdapter({
      endpointId: targetProfile.endpointId,
      protocol: endpoint.protocol,
      authType: endpoint.auth.type,
      model,
      reasoningEffort: targetProfile.reasoningEffort,
      thinking: resolveEffectiveThinkingConfig({
        protocol: endpoint.protocol,
        model,
        global: config.llm.thinking,
        profile: targetProfile.thinking,
        reasoningEffort: targetProfile.reasoningEffort,
      }),
      apiKey: credential.apiKey,
      authHint: buildEndpointAuthHint(targetProfile.endpointId, endpoint),
      baseUrl: endpoint.baseUrl,
      headers: resolvedHeaders.headers,
      hasSecretHeaders: Object.keys(endpoint.headerEnv ?? {}).length > 0,
      maxOutputTokens: resolveEnforcedMaxOutputTokens(endpoint.protocol, metadata?.maxOutputTokens),
      capabilities: metadata?.capabilities,
      compat: metadata?.compat,
    });
    const adapter = new ResilientLlmAdapter(nativeAdapter, requestPolicy);
    this.adapterCache.set(cacheKey, { fingerprint, adapter });
    return adapter;
  }

  private assertStableAdapterSnapshot(config: SloppyConfig, readToken: LlmProfileReadToken): void {
    if (this.config !== config || !this.profileBindingRegistry.isStableReadToken(readToken)) {
      throw new LlmAdapterSnapshotChangedError();
    }
  }

  async ensureReady(route: LlmProfileRoute = {}): Promise<LlmStateSnapshot> {
    const state = await this.getState(route);
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

    const finishMutation = this.profileBindingRegistry.beginMutation(
      "save",
      profile.id,
      this.profileRevision,
    );
    const previousLlmConfig = JSON.stringify(this.config.llm);
    let profileConfigChanged = false;
    try {
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
          await this.credentials.deleteStoredKeys(profile);
        } else {
          await this.credentials.storeKey(profile, normalizedApiKey);
        }
      }

      await this.persistProfiles(nextProfiles, nextDefaultProfileId);
      profileConfigChanged = JSON.stringify(this.config.llm) !== previousLlmConfig;
      return this.getState();
    } finally {
      this.profileRevision = finishMutation(profileConfigChanged);
    }
  }

  async setDefaultProfile(profileId: string): Promise<LlmStateSnapshot> {
    const profile = this.getAvailableProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const finishMutation = this.profileBindingRegistry.beginMutation(
      "set_default",
      profileId,
      this.profileRevision,
    );
    const previousLlmConfig = JSON.stringify(this.config.llm);
    let profileConfigChanged = false;
    try {
      await this.persistProfiles(this.config.llm.profiles, profile.id);
      profileConfigChanged = JSON.stringify(this.config.llm) !== previousLlmConfig;
      return this.getState();
    } finally {
      this.profileRevision = finishMutation(profileConfigChanged);
    }
  }

  async deleteProfile(profileId: string): Promise<LlmStateSnapshot> {
    const deletedProfile = this.config.llm.profiles.find((profile) => profile.id === profileId);
    if (!deletedProfile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const finishMutation = this.profileBindingRegistry.beginMutation(
      "delete",
      profileId,
      this.profileRevision,
      {
        requireUnbound: true,
      },
    );
    const previousLlmConfig = JSON.stringify(this.config.llm);
    let profileConfigChanged = false;
    try {
      const nextProfiles = this.config.llm.profiles.filter((profile) => profile.id !== profileId);
      if (deletedProfile.kind === "native") {
        await this.credentials.deleteStoredKeysForProfileRemoval(deletedProfile, nextProfiles);
      }

      const nextDefaultProfileId =
        this.config.llm.defaultProfileId === profileId
          ? nextProfiles[0]?.id
          : this.config.llm.defaultProfileId;
      await this.persistProfiles(nextProfiles, nextDefaultProfileId);
      profileConfigChanged = JSON.stringify(this.config.llm) !== previousLlmConfig;
      return this.getState();
    } finally {
      this.profileRevision = finishMutation(profileConfigChanged);
    }
  }

  async deleteApiKey(profileId: string): Promise<LlmStateSnapshot> {
    const profile = this.getAvailableProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    if (profile.kind !== "native" || profile.origin !== "managed") {
      throw new Error(`Cannot delete stored endpoint credentials for profile: ${profileId}`);
    }

    const endpoint = this.config.llm.endpoints[profile.endpointId];
    if (!endpoint || !endpointRequiresCredential(endpoint)) {
      throw new Error(`Cannot delete stored endpoint credentials for profile: ${profileId}`);
    }

    const finishMutation = this.profileBindingRegistry.beginMutation(
      "delete_api_key",
      profileId,
      this.profileRevision,
    );
    try {
      await this.credentials.deleteStoredKeys(profile);
      this.adapterCache.clear();
      return this.getState();
    } finally {
      // Credential-store changes do not alter the shared profile config, so
      // they do not make sibling managers' profile snapshots stale.
      this.profileRevision = finishMutation(false);
    }
  }

  private async resolveProfileState(
    profile: ResolvedProfile,
    config: SloppyConfig = this.config,
  ): Promise<LlmProfileState> {
    if (profile.kind === "session-agent") {
      return this.resolveSessionAgentProfileState(profile, config);
    }

    const endpoint = config.llm.endpoints[profile.endpointId];
    if (!endpoint) {
      return this.resolveMissingEndpointProfileState(profile, config.llm);
    }

    const resolvedHeaders = resolveEndpointHeaders(profile.endpointId, endpoint);
    const runtimeInvalidReason =
      validateNativeEndpointRuntime(profile.endpointId, endpoint, profile.model, resolvedHeaders) ??
      validateResolvedLlmRequestPolicy(resolveLlmRequestPolicy(config.llm));
    const credential = await this.credentials.resolve(profile, endpoint);
    const metadata = endpoint.models[profile.model];
    const reasoningEffort = resolveProfileReasoningEffort(config.llm, profile);
    return {
      ...profile,
      reasoningEffort,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      authEnv: endpoint.auth.type === "env" ? endpoint.auth.env : undefined,
      isDefault: false,
      hasKey: credential.hasKey,
      keySource: credential.keySource,
      ready: credential.ready && runtimeInvalidReason === undefined,
      invalidReason: runtimeInvalidReason ?? credential.invalidReason,
      canDeleteProfile: profile.origin === "managed",
      canDeleteApiKey: profile.origin === "managed" && endpointRequiresCredential(endpoint),
      contextWindowTokens: metadata?.contextWindowTokens,
      maxOutputTokens: resolveEnforcedMaxOutputTokens(endpoint.protocol, metadata?.maxOutputTokens),
      capabilities: metadata?.capabilities,
      ownsToolLoop: false,
      thinking: resolveEffectiveThinkingConfig({
        protocol: endpoint.protocol,
        model: profile.model,
        global: config.llm.thinking,
        profile: profile.thinking,
        reasoningEffort,
      }),
    } satisfies LlmProfileState;
  }

  private resolveSessionAgentProfileState(
    profile: ResolvedProfile,
    config: SloppyConfig,
  ): LlmProfileState {
    const sessionProfile = profile as LlmSessionAgentProfileConfig & ResolvedProfile;
    const reasoningEffort = resolveProfileReasoningEffort(config.llm, sessionProfile);
    const acp = config.plugins.delegation.acp;
    const adapterId = sessionProfile.adapterId.trim() || sessionProfile.model;
    const invalidReason = !acp?.enabled
      ? `ACP adapter profile '${sessionProfile.id}' requires plugins.delegation.acp.enabled to be true.`
      : !acp.adapters[adapterId]
        ? `ACP adapter profile '${sessionProfile.id}' references unknown adapter '${adapterId}'.`
        : undefined;
    return {
      ...sessionProfile,
      reasoningEffort,
      protocol: "session-agent",
      isDefault: false,
      hasKey: false,
      keySource: "not_required",
      ready: invalidReason === undefined,
      invalidReason,
      canDeleteProfile: profile.origin === "managed",
      canDeleteApiKey: false,
      ownsToolLoop: true,
      thinking: resolveEffectiveThinkingConfig({
        protocol: "session-agent",
        model: sessionProfile.model,
        global: config.llm.thinking,
        profile: sessionProfile.thinking,
        reasoningEffort,
      }),
    } satisfies LlmProfileState;
  }

  private resolveMissingEndpointProfileState(
    profile: ResolvedProfile & { kind: "native" },
    config: LlmConfig,
  ): LlmProfileState {
    const reasoningEffort = resolveProfileReasoningEffort(config, profile);
    return {
      ...profile,
      reasoningEffort,
      isDefault: false,
      hasKey: false,
      keySource: "missing",
      ready: false,
      invalidReason: `LLM profile '${profile.id}' references unknown endpoint '${profile.endpointId}'.`,
      canDeleteProfile: profile.origin === "managed",
      canDeleteApiKey: false,
      ownsToolLoop: false,
      thinking: resolveEffectiveThinkingConfig({
        protocol: "session-agent",
        model: profile.model,
        global: config.thinking,
        profile: profile.thinking,
        reasoningEffort,
      }),
    } satisfies LlmProfileState;
  }

  private getAvailableProfiles(config: LlmConfig = this.config.llm): ResolvedProfile[] {
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

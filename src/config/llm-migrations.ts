import {
  DEFAULT_LLM_ENDPOINTS,
  getDefaultEndpointModel,
  getDefaultEndpointProtocol,
} from "../llm/catalog";
import {
  asJsonObject,
  asPositiveNumber,
  asString,
  deepMerge,
  definedFields,
  hasAnyKey,
  type JsonObject,
  stripKeys,
} from "./json";

const LEGACY_LLM_ROOT_KEYS = [
  "provider",
  "model",
  "adapterId",
  "apiKeyEnv",
  "baseUrl",
  "contextWindowTokens",
] as const;
const LEGACY_LLM_PROFILE_KEYS = [
  "provider",
  "apiKeyEnv",
  "baseUrl",
  "contextWindowTokens",
] as const;
const LEGACY_NATIVE_LLM_PROFILE_KEYS = [...LEGACY_LLM_PROFILE_KEYS, "adapterId"] as const;

export function normalizeConfigInput(config: JsonObject): JsonObject {
  const llm = asJsonObject(config.llm);
  if (!llm) return config;

  const endpoints = normalizeEndpointsForSchema(llm.endpoints);
  const rawProfiles = Array.isArray(llm.profiles) ? llm.profiles : [];
  let profiles = rawProfiles.map((profile) => {
    const profileObject = asJsonObject(profile);
    return profileObject ? normalizeLegacyLlmProfile(profileObject, endpoints) : profile;
  });

  let defaultProfileId = asString(llm.defaultProfileId);
  if (profiles.length === 0 && hasAnyKey(llm, LEGACY_LLM_ROOT_KEYS)) {
    const rootProfile = normalizeLegacyRootLlmProfile(llm, endpoints);
    profiles = [rootProfile];
    defaultProfileId = asString(rootProfile.id) ?? "default";
  }

  const nextLlm: JsonObject = {
    ...stripKeys(llm, LEGACY_LLM_ROOT_KEYS),
    endpoints,
    profiles,
  };
  if (defaultProfileId) nextLlm.defaultProfileId = defaultProfileId;
  return { ...config, llm: nextLlm };
}

function normalizeEndpointForSchema(endpoint: JsonObject): JsonObject {
  const normalized = { ...endpoint };
  delete normalized.defaultModel;
  return normalized;
}

function normalizeEndpointsForSchema(value: unknown): JsonObject {
  const endpoints = asJsonObject(value);
  if (!endpoints) return {};
  return Object.fromEntries(
    Object.entries(endpoints).map(([endpointId, endpoint]) => [
      endpointId,
      asJsonObject(endpoint) ? normalizeEndpointForSchema(endpoint as JsonObject) : endpoint,
    ]),
  );
}

function normalizeLegacyLlmProfile(profile: JsonObject, endpoints: JsonObject): JsonObject {
  const provider = asString(profile.provider);
  if (provider === "acp") {
    const id = asString(profile.id) ?? "acp";
    const model = asString(profile.model) ?? "default";
    return definedFields({
      ...stripKeys(profile, LEGACY_LLM_PROFILE_KEYS),
      kind: "session-agent",
      id,
      adapterId: asString(profile.adapterId) ?? model,
      model,
    });
  }

  if (provider) {
    const id = asString(profile.id) ?? provider;
    const model = asString(profile.model) ?? getDefaultEndpointModel(provider) ?? "default";
    const endpointId = legacyEndpointId(provider, profile, id);
    mergeEndpointOverride(
      endpoints,
      endpointId,
      buildLegacyEndpointOverride(provider, profile, model, endpointId),
    );
    return definedFields({
      ...stripKeys(profile, LEGACY_NATIVE_LLM_PROFILE_KEYS),
      kind: "native",
      id,
      endpointId,
      model,
    });
  }

  const kind = asString(profile.kind);
  const endpointId = asString(profile.endpointId);
  const model = asString(profile.model);
  if ((kind === "native" || (!kind && endpointId)) && endpointId && model) {
    mergeEndpointOverride(
      endpoints,
      endpointId,
      buildLegacyEndpointOverride(endpointId, profile, model, endpointId),
    );
    return stripKeys(profile, ["apiKeyEnv", "baseUrl", "contextWindowTokens"] as const);
  }
  return profile;
}

function normalizeLegacyRootLlmProfile(llm: JsonObject, endpoints: JsonObject): JsonObject {
  const provider = asString(llm.provider) ?? "anthropic";
  const id = asString(llm.defaultProfileId) ?? "default";
  const model = asString(llm.model) ?? getDefaultEndpointModel(provider) ?? "default";
  if (provider === "acp") {
    return definedFields({
      kind: "session-agent",
      id,
      adapterId: asString(llm.adapterId) ?? model,
      model,
      reasoningEffort: llm.reasoningEffort,
      thinking: llm.thinking,
    });
  }
  mergeEndpointOverride(
    endpoints,
    provider,
    buildLegacyEndpointOverride(provider, llm, model, provider),
  );
  return definedFields({
    kind: "native",
    id,
    endpointId: provider,
    model,
    reasoningEffort: llm.reasoningEffort,
    thinking: llm.thinking,
  });
}

function legacyEndpointId(provider: string, profile: JsonObject, profileId: string): string {
  if (!asString(profile.baseUrl) && !asString(profile.apiKeyEnv)) return provider;
  return profileId === provider ? `${provider}-legacy` : profileId;
}

function buildLegacyEndpointOverride(
  provider: string,
  source: JsonObject,
  model: string,
  endpointId: string,
): JsonObject | undefined {
  const baseUrl = asString(source.baseUrl);
  const apiKeyEnv = asString(source.apiKeyEnv);
  const contextWindowTokens = asPositiveNumber(source.contextWindowTokens);
  if (!baseUrl && !apiKeyEnv && !contextWindowTokens && endpointId === provider) return undefined;
  const defaultEndpoint = DEFAULT_LLM_ENDPOINTS[provider];
  const defaultModel = defaultEndpoint?.models[model];
  return {
    ...(defaultEndpoint?.label ? { label: defaultEndpoint.label } : {}),
    protocol: getDefaultEndpointProtocol(provider) ?? "openai-chat",
    ...((baseUrl ?? defaultEndpoint?.baseUrl)
      ? { baseUrl: baseUrl ?? defaultEndpoint?.baseUrl }
      : {}),
    auth: apiKeyEnv ? { type: "env", env: apiKeyEnv } : (defaultEndpoint?.auth ?? { type: "none" }),
    models: {
      ...(defaultEndpoint?.models ?? {}),
      [model]: definedFields({
        ...(defaultModel ?? {}),
        contextWindowTokens: contextWindowTokens ?? defaultModel?.contextWindowTokens,
      }),
    },
  };
}

function mergeEndpointOverride(
  endpoints: JsonObject,
  endpointId: string,
  endpoint: JsonObject | undefined,
): void {
  if (!endpoint) return;
  const existing = asJsonObject(endpoints[endpointId]);
  if (!existing) {
    endpoints[endpointId] = endpoint;
    return;
  }
  const merged = deepMerge(existing, endpoint);
  if (endpoint.auth) merged.auth = endpoint.auth;
  endpoints[endpointId] = merged;
}

import { type LlmConfig, llmReasoningEffortSchema, type SloppyConfig } from "../config/schema";
import { getDefaultEndpointModel } from "./catalog";
import type { CredentialStore } from "./credential-store";
import { type LlmProfileBindingRegistry, LlmProfileManager } from "./profile-manager";

type RuntimeEnvironment = Record<string, string | undefined>;

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function hasExplicitRuntimeLlmRouting(env: RuntimeEnvironment = Bun.env): boolean {
  return Boolean(
    trimOptional(env.SLOPPY_LLM_ENDPOINT) ??
      trimOptional(env.SLOPPY_LLM_PROFILE) ??
      trimOptional(env.SLOPPY_MODEL) ??
      trimOptional(env.SLOPPY_LLM_REASONING_EFFORT),
  );
}

function activeNativeProfile(baseConfig: LlmConfig) {
  const activeProfile = baseConfig.profiles.find(
    (profile) => profile.id === baseConfig.defaultProfileId,
  );
  if (activeProfile?.kind === "native") {
    return activeProfile;
  }
  return baseConfig.profiles.find((profile) => profile.kind === "native");
}

function firstEndpointModel(baseConfig: LlmConfig, endpointId: string): string | undefined {
  return Object.keys(baseConfig.endpoints[endpointId]?.models ?? {})[0];
}

export function buildRuntimeLlmConfig(
  baseConfig: LlmConfig,
  env: RuntimeEnvironment = Bun.env,
): LlmConfig {
  const reasoningEffort = trimOptional(env.SLOPPY_LLM_REASONING_EFFORT)
    ? llmReasoningEffortSchema.parse(trimOptional(env.SLOPPY_LLM_REASONING_EFFORT))
    : baseConfig.reasoningEffort;
  const endpointOverride = trimOptional(env.SLOPPY_LLM_ENDPOINT);
  const modelOverride = trimOptional(env.SLOPPY_MODEL);
  const profileOverride = trimOptional(env.SLOPPY_LLM_PROFILE);

  if (!endpointOverride && !modelOverride) {
    return {
      ...baseConfig,
      reasoningEffort,
      defaultProfileId: profileOverride ?? baseConfig.defaultProfileId,
    };
  }

  const activeProfile = activeNativeProfile(baseConfig);
  const endpointId = endpointOverride ?? activeProfile?.endpointId ?? "anthropic";
  const model =
    modelOverride ??
    activeProfile?.model ??
    getDefaultEndpointModel(endpointId) ??
    firstEndpointModel(baseConfig, endpointId) ??
    "default";
  const runtimeProfileId = profileOverride ?? "runtime";

  return {
    ...baseConfig,
    reasoningEffort,
    defaultProfileId: runtimeProfileId,
    profiles: [
      {
        kind: "native",
        id: runtimeProfileId,
        label: "Runtime Override",
        endpointId,
        model,
        reasoningEffort,
      },
    ],
  };
}

export function buildRuntimeSloppyConfig(
  baseConfig: SloppyConfig,
  env: RuntimeEnvironment = Bun.env,
): SloppyConfig {
  if (!hasExplicitRuntimeLlmRouting(env)) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    llm: buildRuntimeLlmConfig(baseConfig.llm, env),
  };
}

export function createRuntimeLlmProfileManager(options: {
  config: SloppyConfig;
  credentialStore?: CredentialStore;
  writeConfig?: (config: LlmConfig) => Promise<void>;
  profileBindingRegistry?: LlmProfileBindingRegistry;
  expectedRevision?: number;
  env?: RuntimeEnvironment;
}): LlmProfileManager {
  return new LlmProfileManager({
    config: buildRuntimeSloppyConfig(options.config, options.env),
    credentialStore: options.credentialStore,
    writeConfig: options.writeConfig,
    profileBindingRegistry: options.profileBindingRegistry,
    expectedRevision: options.expectedRevision,
  });
}

import { type LlmConfig, llmProviderSchema, type SloppyConfig } from "../config/schema";
import type { CredentialStore } from "./credential-store";
import { LlmProfileManager } from "./profile-manager";
import { getProviderDefaults } from "./provider-defaults";

type RuntimeEnvironment = Record<string, string | undefined>;

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function hasExplicitRuntimeLlmRouting(env: RuntimeEnvironment = Bun.env): boolean {
  return Boolean(
    trimOptional(env.SLOPPY_LLM_PROVIDER) ??
      trimOptional(env.SLOPPY_MODEL) ??
      trimOptional(env.SLOPPY_LLM_ADAPTER_ID) ??
      trimOptional(env.SLOPPY_LLM_BASE_URL) ??
      trimOptional(env.SLOPPY_LLM_API_KEY_ENV),
  );
}

export function buildRuntimeLlmConfig(
  baseConfig: LlmConfig,
  env: RuntimeEnvironment = Bun.env,
): LlmConfig {
  const provider = trimOptional(env.SLOPPY_LLM_PROVIDER)
    ? llmProviderSchema.parse(trimOptional(env.SLOPPY_LLM_PROVIDER))
    : baseConfig.provider;
  const defaults = getProviderDefaults(provider);

  return {
    ...baseConfig,
    provider,
    model: trimOptional(env.SLOPPY_MODEL) ?? baseConfig.model ?? defaults.model,
    adapterId:
      trimOptional(env.SLOPPY_LLM_ADAPTER_ID) ?? baseConfig.adapterId ?? defaults.adapterId,
    apiKeyEnv:
      trimOptional(env.SLOPPY_LLM_API_KEY_ENV) ?? baseConfig.apiKeyEnv ?? defaults.apiKeyEnv,
    baseUrl: trimOptional(env.SLOPPY_LLM_BASE_URL) ?? baseConfig.baseUrl ?? defaults.baseUrl,
    defaultProfileId: undefined,
    profiles: [],
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
  env?: RuntimeEnvironment;
}): LlmProfileManager {
  return new LlmProfileManager({
    config: buildRuntimeSloppyConfig(options.config, options.env),
    credentialStore: options.credentialStore,
    writeConfig: options.writeConfig,
  });
}

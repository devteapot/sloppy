import type { LlmConfig } from "../config/schema";
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
      trimOptional(env.SLOPPY_LLM_BASE_URL) ??
      trimOptional(env.SLOPPY_LLM_API_KEY_ENV),
  );
}

export function buildRuntimeLlmConfig(
  baseConfig: LlmConfig,
  env: RuntimeEnvironment = Bun.env,
): LlmConfig {
  const defaults = getProviderDefaults(baseConfig.provider);

  return {
    ...baseConfig,
    model: baseConfig.model ?? defaults.model,
    apiKeyEnv:
      trimOptional(env.SLOPPY_LLM_API_KEY_ENV) ?? baseConfig.apiKeyEnv ?? defaults.apiKeyEnv,
    baseUrl: baseConfig.baseUrl ?? defaults.baseUrl,
    defaultProfileId: undefined,
    profiles: [],
  };
}

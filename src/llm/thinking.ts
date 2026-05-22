import type {
  LlmProvider,
  LlmReasoningEffort,
  LlmThinkingConfig,
  LlmThinkingConfigInput,
  LlmThinkingDisplay,
  LlmThinkingEffectiveReason,
} from "../config/schema";

export type EffectiveThinkingConfig = LlmThinkingConfig & {
  effectiveEnabled: boolean;
  effectiveReason: LlmThinkingEffectiveReason;
  effectiveEffort: LlmReasoningEffort;
};

export const DEFAULT_THINKING_CONFIG: LlmThinkingConfig = {
  enabled: true,
  display: "visible",
  effort: "medium",
};

const OPENAI_REASONING_PROVIDERS = new Set<LlmProvider>(["openai", "openai-codex", "openrouter"]);

function mergeRecord<T extends Record<string, unknown>>(
  left: T | undefined,
  right: T | undefined,
): T | undefined {
  if (!left && !right) {
    return undefined;
  }
  return {
    ...(left ?? {}),
    ...(right ?? {}),
    options: {
      ...((left?.options as Record<string, unknown> | undefined) ?? {}),
      ...((right?.options as Record<string, unknown> | undefined) ?? {}),
    },
  } as unknown as T;
}

export function normalizeThinkingConfig(
  global?: LlmThinkingConfigInput,
  profile?: LlmThinkingConfigInput,
): LlmThinkingConfig {
  return {
    enabled: profile?.enabled ?? global?.enabled ?? DEFAULT_THINKING_CONFIG.enabled,
    display: (profile?.display ??
      global?.display ??
      DEFAULT_THINKING_CONFIG.display) as LlmThinkingDisplay,
    effort: profile?.effort ?? global?.effort ?? DEFAULT_THINKING_CONFIG.effort,
    openai: mergeRecord(global?.openai, profile?.openai),
    openaiCodex: mergeRecord(global?.openaiCodex, profile?.openaiCodex),
    anthropic: mergeRecord(global?.anthropic, profile?.anthropic),
    gemini: mergeRecord(global?.gemini, profile?.gemini),
    openrouter: mergeRecord(global?.openrouter, profile?.openrouter),
    ollama: mergeRecord(global?.ollama, profile?.ollama),
  };
}

function modelLikelyForcesThinking(provider: LlmProvider, model: string): boolean {
  const normalized = model.toLowerCase();
  if (provider === "gemini") {
    return normalized.startsWith("gemini-2.5-pro") || normalized.startsWith("gemini-3");
  }
  if (OPENAI_REASONING_PROVIDERS.has(provider)) {
    return (
      normalized.startsWith("o") ||
      normalized.includes("gpt-5") ||
      normalized.includes("qwen3") ||
      normalized.includes("deepseek-r")
    );
  }
  if (provider === "ollama") {
    return normalized.includes("gpt-oss") || normalized.includes("qwen3");
  }
  return false;
}

export function resolveEffectiveThinkingConfig(options: {
  provider: LlmProvider;
  model: string;
  global?: LlmThinkingConfigInput;
  profile?: LlmThinkingConfigInput;
  reasoningEffort?: LlmReasoningEffort;
}): EffectiveThinkingConfig {
  const normalized = normalizeThinkingConfig(options.global, options.profile);
  const providerUnsupported = options.provider === "acp";
  const forced = !providerUnsupported && modelLikelyForcesThinking(options.provider, options.model);
  const effectiveEnabled = providerUnsupported ? false : normalized.enabled || forced;
  const effectiveReason: LlmThinkingEffectiveReason = providerUnsupported
    ? "provider_unsupported"
    : !normalized.enabled && forced
      ? "model_forces_thinking"
      : "configured";

  return {
    ...normalized,
    effectiveEnabled,
    effectiveReason,
    effectiveEffort: options.reasoningEffort ?? normalized.effort,
  };
}

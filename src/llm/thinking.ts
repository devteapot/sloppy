import type {
  LlmProtocol,
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

const OPENAI_REASONING_PROTOCOLS = new Set<LlmProtocol>([
  "openai-chat",
  "openai-responses",
  "openai-codex",
]);

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

function modelLikelyForcesThinking(
  protocol: LlmProtocol | "session-agent",
  model: string,
): boolean {
  const normalized = model.toLowerCase();
  if (protocol === "gemini") {
    return normalized.startsWith("gemini-2.5-pro") || normalized.startsWith("gemini-3");
  }
  if (protocol !== "session-agent" && OPENAI_REASONING_PROTOCOLS.has(protocol)) {
    return (
      normalized.startsWith("o") ||
      normalized.includes("gpt-5") ||
      normalized.includes("qwen3") ||
      normalized.includes("deepseek-r")
    );
  }
  if (protocol === "openai-chat") {
    return normalized.includes("gpt-oss") || normalized.includes("qwen3");
  }
  return false;
}

export function resolveEffectiveThinkingConfig(options: {
  protocol: LlmProtocol | "session-agent";
  model: string;
  global?: LlmThinkingConfigInput;
  profile?: LlmThinkingConfigInput;
  reasoningEffort?: LlmReasoningEffort;
}): EffectiveThinkingConfig {
  const normalized = normalizeThinkingConfig(options.global, options.profile);
  const providerUnsupported = options.protocol === "session-agent";
  const forced = !providerUnsupported && modelLikelyForcesThinking(options.protocol, options.model);
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

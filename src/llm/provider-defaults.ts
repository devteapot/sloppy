import type { LlmProvider } from "../config/schema";

export type ProviderDefault = {
  model: string;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
};

export const DEFAULT_LLM_PROVIDER_CONFIG: Record<LlmProvider, ProviderDefault> = {
  anthropic: {
    model: "claude-sonnet-4-20250514",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    contextWindowTokens: 200_000,
  },
  openai: {
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
    contextWindowTokens: 1_050_000,
  },
  "openai-codex": {
    model: "gpt-5.5",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindowTokens: 258_400,
  },
  openrouter: {
    model: "openai/gpt-5.4",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    contextWindowTokens: 1_050_000,
  },
  ollama: {
    model: "llama3.2",
    baseUrl: "http://localhost:11434/v1",
  },
  gemini: {
    model: "gemini-2.5-pro",
    apiKeyEnv: "GEMINI_API_KEY",
    contextWindowTokens: 1_048_576,
  },
  acp: {
    model: "default",
    adapterId: "default",
  },
};

export function getProviderDefaults(provider: LlmProvider): ProviderDefault {
  return DEFAULT_LLM_PROVIDER_CONFIG[provider];
}

export function resolveModelContextWindowTokens(
  provider: LlmProvider,
  model: string,
): number | undefined {
  const normalizedModel = normalizeModelName(provider, model);

  if (provider === "openai-codex") {
    return 258_400;
  }

  if (provider === "anthropic") {
    if (normalizedModel.startsWith("claude-")) return 200_000;
  }

  if (provider === "gemini") {
    if (normalizedModel.startsWith("gemini-1.5-pro")) return 2_097_152;
    if (normalizedModel.startsWith("gemini-1.5")) return 1_048_576;
    if (normalizedModel.startsWith("gemini-2.")) return 1_048_576;
  }

  if (provider === "openai" || provider === "openrouter") {
    if (normalizedModel === "gpt-5.5" || normalizedModel.startsWith("gpt-5.5-")) {
      return 1_050_000;
    }
    if (
      normalizedModel === "gpt-5.4-mini" ||
      normalizedModel.startsWith("gpt-5.4-mini-") ||
      normalizedModel === "gpt-5.4-nano" ||
      normalizedModel.startsWith("gpt-5.4-nano-")
    ) {
      return 400_000;
    }
    if (normalizedModel === "gpt-5.4" || normalizedModel.startsWith("gpt-5.4-")) {
      return 1_050_000;
    }
    if (normalizedModel.startsWith("gpt-5") && normalizedModel.includes("chat")) {
      return 128_000;
    }
    if (
      normalizedModel === "gpt-5.2" ||
      normalizedModel.startsWith("gpt-5.2-") ||
      normalizedModel === "gpt-5.1" ||
      normalizedModel.startsWith("gpt-5.1-") ||
      normalizedModel === "gpt-5" ||
      normalizedModel.startsWith("gpt-5-") ||
      normalizedModel.includes("gpt-5-codex")
    ) {
      return 400_000;
    }
    if (normalizedModel === "gpt-4.1" || normalizedModel.startsWith("gpt-4.1-")) {
      return 1_047_576;
    }
    if (normalizedModel.startsWith("gpt-4o") || normalizedModel.startsWith("o")) {
      return 128_000;
    }
  }

  return DEFAULT_LLM_PROVIDER_CONFIG[provider].model === model
    ? DEFAULT_LLM_PROVIDER_CONFIG[provider].contextWindowTokens
    : undefined;
}

function normalizeModelName(provider: LlmProvider, model: string): string {
  const normalized = model.trim().toLowerCase();
  if (provider !== "openrouter") {
    return normalized;
  }
  return normalized.includes("/") ? (normalized.split("/").pop() ?? normalized) : normalized;
}

export function providerRequiresApiKey(provider: LlmProvider): boolean {
  return provider !== "ollama" && provider !== "acp" && provider !== "openai-codex";
}

export function providerUsesCodexAuth(provider: LlmProvider): boolean {
  return provider === "openai-codex";
}

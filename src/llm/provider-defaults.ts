import type { LlmProvider } from "../config/schema";

export type ProviderDefault = {
  model: string;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
};

export const DEFAULT_LLM_PROVIDER_CONFIG: Record<LlmProvider, ProviderDefault> = {
  anthropic: {
    model: "claude-sonnet-4-20250514",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  openai: {
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "openai-codex": {
    model: "gpt-5.5",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  },
  openrouter: {
    model: "openai/gpt-5.4",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  ollama: {
    model: "llama3.2",
    baseUrl: "http://localhost:11434/v1",
  },
  gemini: {
    model: "gemini-2.5-pro",
    apiKeyEnv: "GEMINI_API_KEY",
  },
  acp: {
    model: "default",
    adapterId: "default",
  },
};

export function getProviderDefaults(provider: LlmProvider): ProviderDefault {
  return DEFAULT_LLM_PROVIDER_CONFIG[provider];
}

export function providerRequiresApiKey(provider: LlmProvider): boolean {
  return provider !== "ollama" && provider !== "acp" && provider !== "openai-codex";
}

export function providerUsesCodexAuth(provider: LlmProvider): boolean {
  return provider === "openai-codex";
}

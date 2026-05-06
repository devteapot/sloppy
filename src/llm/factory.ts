import type { LlmProvider } from "../config/schema";

import { AnthropicAdapter } from "./anthropic";
import { GeminiAdapter } from "./gemini";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import { providerRequiresApiKey } from "./provider-defaults";
import type { LlmAdapter } from "./types";

export type LlmAdapterConfig = {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
};

function requireApiKey(config: LlmAdapterConfig): string {
  if (!providerRequiresApiKey(config.provider)) {
    return "ollama";
  }

  const apiKey = config.apiKey;
  if (!apiKey) {
    if (config.apiKeyEnv) {
      throw new Error(
        `No API key was resolved for ${config.provider}. Set ${config.apiKeyEnv}, store a key in the app, or choose another profile before starting a model turn.`,
      );
    }

    throw new Error(
      `No API key was resolved for ${config.provider}. Store a key in the app or choose another profile before starting a model turn.`,
    );
  }

  return apiKey;
}

export function createLlmAdapter(config: LlmAdapterConfig): LlmAdapter {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicAdapter({
        apiKey: requireApiKey(config),
        model: config.model,
      });
    case "openai":
    case "openrouter":
      return new OpenAICompatibleAdapter({
        apiKey: requireApiKey(config),
        model: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
      });
    case "ollama":
      return new OpenAICompatibleAdapter({
        apiKey: config.apiKey ?? "ollama",
        model: config.model,
        provider: "ollama",
        baseUrl: config.baseUrl,
      });
    case "gemini":
      return new GeminiAdapter({
        apiKey: requireApiKey(config),
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case "acp":
    case "cli":
      throw new Error(
        `${config.provider} profiles are external session-agent profiles and cannot be used by the native LLM adapter factory.`,
      );
  }
}

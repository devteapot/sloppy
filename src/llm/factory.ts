import type { SloppyConfig } from "../config/schema";

import { AnthropicAdapter } from "./anthropic";
import { GeminiAdapter } from "./gemini";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import type { LlmAdapter } from "./types";

function requireApiKey(config: SloppyConfig): string {
  const envName = config.llm.apiKeyEnv;
  if (!envName) {
    throw new Error(`Provider ${config.llm.provider} requires an API key environment variable.`);
  }

  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(`Missing ${envName}. Set it before starting Sloppy.`);
  }

  return apiKey;
}

export function createLlmAdapter(config: SloppyConfig): LlmAdapter {
  switch (config.llm.provider) {
    case "anthropic":
      return new AnthropicAdapter({
        apiKey: requireApiKey(config),
        model: config.llm.model,
      });
    case "openai":
    case "openrouter":
      return new OpenAICompatibleAdapter({
        apiKey: requireApiKey(config),
        model: config.llm.model,
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
      });
    case "ollama":
      return new OpenAICompatibleAdapter({
        apiKey: config.llm.apiKeyEnv ? (process.env[config.llm.apiKeyEnv] ?? "ollama") : "ollama",
        model: config.llm.model,
        provider: "ollama",
        baseUrl: config.llm.baseUrl,
      });
    case "gemini":
      return new GeminiAdapter({
        apiKey: requireApiKey(config),
        model: config.llm.model,
        baseUrl: config.llm.baseUrl,
      });
  }
}

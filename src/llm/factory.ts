import type {
  LlmEndpointModelCompatConfig,
  LlmProtocol,
  LlmReasoningEffort,
} from "../config/schema";

import { AnthropicAdapter } from "./anthropic";
import { GeminiAdapter } from "./gemini";
import { OpenAICodexAdapter } from "./openai-codex";
import { OpenAICompatibleAdapter, type OpenAICompatibleProviderKind } from "./openai-compatible";
import type { EffectiveThinkingConfig } from "./thinking";
import type { LlmAdapter } from "./types";

export type LlmAdapterConfig = {
  endpointId: string;
  protocol: LlmProtocol;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: EffectiveThinkingConfig;
  apiKey?: string;
  authHint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: LlmEndpointModelCompatConfig;
};

function requireApiKey(config: LlmAdapterConfig): string {
  const apiKey = config.apiKey;
  if (!apiKey) {
    if (config.authHint) {
      throw new Error(`No API key was resolved for ${config.endpointId}. ${config.authHint}`);
    }

    throw new Error(
      `No API key was resolved for ${config.endpointId}. Store a key in the app or choose another profile before starting a model turn.`,
    );
  }

  return apiKey;
}

function resolveOpenAICompatibleProviderKind(
  endpointId: string,
  compat: LlmEndpointModelCompatConfig | undefined,
): OpenAICompatibleProviderKind {
  if (compat?.kind) {
    return compat.kind;
  }
  if (endpointId === "openai" || endpointId === "openrouter" || endpointId === "ollama") {
    return endpointId;
  }
  return "generic";
}

export function createLlmAdapter(config: LlmAdapterConfig): LlmAdapter {
  switch (config.protocol) {
    case "anthropic-messages":
      return new AnthropicAdapter({
        apiKey: requireApiKey(config),
        model: config.model,
        thinking: config.thinking,
      });
    case "openai-chat":
      return new OpenAICompatibleAdapter({
        apiKey: config.apiKey ?? "local",
        model: config.model,
        provider: config.endpointId,
        providerKind: resolveOpenAICompatibleProviderKind(config.endpointId, config.compat),
        baseUrl: config.baseUrl,
        headers: config.headers,
        thinking: config.thinking,
      });
    case "openai-codex":
      return new OpenAICodexAdapter({
        model: config.model,
        baseUrl: config.baseUrl,
        reasoningEffort: config.reasoningEffort,
        thinking: config.thinking,
      });
    case "gemini":
      return new GeminiAdapter({
        apiKey: requireApiKey(config),
        model: config.model,
        baseUrl: config.baseUrl,
        thinking: config.thinking,
      });
    case "openai-responses":
      throw new Error(
        `${config.protocol} endpoints are not supported by the native adapter factory yet. Use openai-chat for OpenAI-compatible chat endpoints.`,
      );
  }
}

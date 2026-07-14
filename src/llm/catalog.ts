import type {
  LlmEndpointConfig,
  LlmEndpointInputConfig,
  LlmEndpointModelConfig,
  LlmProtocol,
} from "../config/schema";

export type BuiltInLlmEndpoint = LlmEndpointConfig & {
  defaultModel: string;
};

// Maintained by hand; there is no auto-fetch of provider specs. When vendors
// ship new defaults, update the model ids and context/output limits here and
// in tests/llm-provider-defaults.test.ts together.
export const DEFAULT_LLM_ENDPOINTS: Record<string, BuiltInLlmEndpoint> = {
  anthropic: {
    label: "Anthropic",
    protocol: "anthropic-messages",
    auth: { type: "env", env: "ANTHROPIC_API_KEY" },
    defaultModel: "claude-sonnet-4-20250514",
    models: {
      "claude-sonnet-4-20250514": {
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
        capabilities: { tools: true, images: true },
      },
    },
  },
  openai: {
    label: "OpenAI",
    protocol: "openai-responses",
    auth: { type: "env", env: "OPENAI_API_KEY" },
    defaultModel: "gpt-5.4",
    models: {
      "gpt-5.4": {
        contextWindowTokens: 1_050_000,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, images: true },
      },
    },
  },
  "openai-codex": {
    label: "OpenAI Codex",
    protocol: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: { type: "codex" },
    defaultModel: "gpt-5.6-sol",
    models: {
      "gpt-5.6-sol": {
        label: "GPT-5.6 Sol",
        contextWindowTokens: 258_400,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, images: true },
        compat: {
          kind: "openai",
          maxTokensField: "max_completion_tokens",
          thinkingFormat: "openai",
        },
      },
      "gpt-5.6-terra": {
        label: "GPT-5.6 Terra",
        contextWindowTokens: 258_400,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, images: true },
        compat: {
          kind: "openai",
          maxTokensField: "max_completion_tokens",
          thinkingFormat: "openai",
        },
      },
      "gpt-5.6-luna": {
        label: "GPT-5.6 Luna",
        contextWindowTokens: 258_400,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, images: true },
        compat: {
          kind: "openai",
          maxTokensField: "max_completion_tokens",
          thinkingFormat: "openai",
        },
      },
      "gpt-5.5": {
        contextWindowTokens: 258_400,
        maxOutputTokens: 64_000,
        capabilities: { tools: true, images: true },
        compat: {
          kind: "openai",
          maxTokensField: "max_completion_tokens",
          thinkingFormat: "openai",
        },
      },
    },
  },
  openrouter: {
    label: "OpenRouter",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { type: "env", env: "OPENROUTER_API_KEY" },
    defaultModel: "openai/gpt-5.4",
    models: {
      "openai/gpt-5.4": {
        contextWindowTokens: 1_050_000,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, images: true },
        compat: {
          kind: "openrouter",
          maxTokensField: "max_tokens",
          thinkingFormat: "openrouter",
        },
      },
    },
  },
  ollama: {
    label: "Ollama",
    protocol: "openai-chat",
    baseUrl: "http://localhost:11434/v1",
    auth: { type: "none" },
    defaultModel: "llama3.2",
    models: {
      "llama3.2": {
        capabilities: { tools: true, images: false },
        compat: {
          kind: "ollama",
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "ollama",
        },
      },
    },
  },
  gemini: {
    label: "Gemini",
    protocol: "gemini",
    auth: { type: "env", env: "GEMINI_API_KEY" },
    defaultModel: "gemini-2.5-pro",
    models: {
      "gemini-2.5-pro": {
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
        capabilities: { tools: true, images: true },
      },
    },
  },
};

export function getDefaultEndpointModel(endpointId: string): string | undefined {
  return DEFAULT_LLM_ENDPOINTS[endpointId]?.defaultModel;
}

export function getDefaultEndpointProtocol(endpointId: string): LlmProtocol | undefined {
  return DEFAULT_LLM_ENDPOINTS[endpointId]?.protocol;
}

export function resolveEndpointModelMetadata(
  endpoint: Pick<LlmEndpointConfig, "models">,
  model: string,
): LlmEndpointModelConfig | undefined {
  return endpoint.models[model];
}

export function mergeEndpointConfig(
  base: LlmEndpointConfig | undefined,
  override: LlmEndpointInputConfig,
): LlmEndpointConfig {
  return {
    ...base,
    ...override,
    auth: override.auth ?? base?.auth ?? { type: "none" },
    headers: {
      ...(base?.headers ?? {}),
      ...(override.headers ?? {}),
    },
    headerEnv:
      base?.headerEnv || override.headerEnv
        ? {
            ...(base?.headerEnv ?? {}),
            ...(override.headerEnv ?? {}),
          }
        : undefined,
    models: {
      ...(base?.models ?? {}),
      ...Object.fromEntries(
        Object.entries(override.models).map(([modelId, model]) => [
          modelId,
          {
            ...(base?.models[modelId] ?? {}),
            ...model,
            capabilities: {
              ...(base?.models[modelId]?.capabilities ?? {}),
              ...(model.capabilities ?? {}),
            },
            compat: {
              ...(base?.models[modelId]?.compat ?? {}),
              ...(model.compat ?? {}),
            },
          },
        ]),
      ),
    },
  };
}

export function mergeLlmEndpoints(
  configured: Record<string, LlmEndpointInputConfig>,
): Record<string, LlmEndpointConfig> {
  const endpoints: Record<string, LlmEndpointConfig> = Object.fromEntries(
    Object.entries(DEFAULT_LLM_ENDPOINTS).map(([id, endpoint]) => [id, endpoint]),
  );
  for (const [id, endpoint] of Object.entries(configured)) {
    endpoints[id] = mergeEndpointConfig(endpoints[id], endpoint);
  }
  return endpoints;
}

export function endpointRequiresCredential(endpoint: LlmEndpointConfig): boolean {
  return endpoint.auth.type === "env" || endpoint.auth.type === "secure_store";
}

export function endpointUsesCodexAuth(endpoint: LlmEndpointConfig): boolean {
  return endpoint.auth.type === "codex";
}

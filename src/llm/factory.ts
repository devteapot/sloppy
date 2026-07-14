import {
  isSensitiveLlmHeaderName,
  type LlmEndpointAuthConfig,
  type LlmEndpointModelCapabilitiesConfig,
  type LlmEndpointModelCompatConfig,
  type LlmProtocol,
  type LlmReasoningEffort,
} from "../config/schema";

import { AnthropicAdapter } from "./anthropic";
import { GeminiAdapter } from "./gemini";
import { OpenAICodexAdapter, validateOpenAICodexBaseUrl } from "./openai-codex";
import { OpenAICompatibleAdapter, type OpenAICompatibleProviderKind } from "./openai-compatible";
import { OpenAIResponsesAdapter } from "./openai-responses";
import type { EffectiveThinkingConfig } from "./thinking";
import type { LlmAdapter, LlmRuntimeDescriptor } from "./types";

export { getLlmRuntimeDescriptor, resolveLlmMaxTokens } from "./types";

export type LlmAdapterConfig = {
  endpointId: string;
  protocol: LlmProtocol;
  authType: LlmEndpointAuthConfig["type"];
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: EffectiveThinkingConfig;
  apiKey?: string;
  authHint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  hasSecretHeaders?: boolean;
  maxOutputTokens?: number;
  capabilities?: LlmEndpointModelCapabilitiesConfig;
  compat?: LlmEndpointModelCompatConfig;
};

export function resolveEnforcedMaxOutputTokens(
  protocol: LlmProtocol,
  configuredMaxOutputTokens: number | undefined,
): number | undefined {
  // The Codex subscription Responses endpoint owns its output ceiling and does
  // not accept the public Responses API's max_output_tokens request field.
  return protocol === "openai-codex" ? undefined : configuredMaxOutputTokens;
}

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

function apiKeyOrLocal(config: LlmAdapterConfig): string {
  return config.authType === "none" ? (config.apiKey ?? "local") : requireApiKey(config);
}

function apiKeyUnlessNoAuth(config: LlmAdapterConfig): string | undefined {
  return config.authType === "none" ? config.apiKey : requireApiKey(config);
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

export interface LlmProtocolDriver {
  validate(config: LlmAdapterConfig): string | undefined;
  create(config: LlmAdapterConfig): LlmAdapter;
}

function validateNonCodexAuth(config: LlmAdapterConfig): string | undefined {
  return config.authType === "codex"
    ? `LLM endpoint '${config.endpointId}' uses Codex auth with protocol '${config.protocol}'. Codex auth is only valid with openai-codex.`
    : undefined;
}

function validateEndpointTransport(config: LlmAdapterConfig): string | undefined {
  if (!config.baseUrl) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return `LLM endpoint '${config.endpointId}' has an invalid base URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `LLM endpoint '${config.endpointId}' base URL must use http or https.`;
  }
  if (url.username || url.password || url.search || url.hash) {
    return `LLM endpoint '${config.endpointId}' base URL must not contain credentials, query parameters, or a fragment.`;
  }

  const credentialBearing =
    config.authType !== "none" ||
    config.apiKey !== undefined ||
    config.hasSecretHeaders === true ||
    Object.keys(config.headers ?? {}).some(isSensitiveLlmHeaderName);
  if (credentialBearing && url.protocol !== "https:") {
    return `LLM endpoint '${config.endpointId}' must use https when credentials or secret headers are configured.`;
  }
  return undefined;
}

const protocolDrivers = {
  "anthropic-messages": {
    validate: validateNonCodexAuth,
    create: (config) =>
      new AnthropicAdapter({
        apiKey: apiKeyOrLocal(config),
        model: config.model,
        providerId: config.endpointId,
        baseUrl: config.baseUrl,
        headers: config.headers,
        thinking: config.thinking,
      }),
  },
  "openai-chat": {
    validate: validateNonCodexAuth,
    create: (config) =>
      new OpenAICompatibleAdapter({
        apiKey: apiKeyUnlessNoAuth(config) ?? "local",
        model: config.model,
        provider: config.endpointId,
        providerKind: resolveOpenAICompatibleProviderKind(config.endpointId, config.compat),
        baseUrl: config.baseUrl,
        headers: config.headers,
        thinking: config.thinking,
        compat: config.compat,
      }),
  },
  "openai-responses": {
    validate: validateNonCodexAuth,
    create: (config) =>
      new OpenAIResponsesAdapter({
        apiKey: apiKeyUnlessNoAuth(config),
        model: config.model,
        providerId: config.endpointId,
        baseUrl: config.baseUrl,
        headers: config.headers,
        reasoningEffort: config.reasoningEffort,
        thinking: config.thinking,
      }),
  },
  "openai-codex": {
    validate: (config) => {
      if (config.authType !== "codex") {
        return `LLM endpoint '${config.endpointId}' uses protocol openai-codex, which requires auth.type=codex.`;
      }
      if (config.headers && Object.keys(config.headers).length > 0) {
        return `LLM endpoint '${config.endpointId}' configures custom headers, but protocol 'openai-codex' owns its authentication headers.`;
      }
      const invalidBaseUrl = validateOpenAICodexBaseUrl(config.baseUrl);
      if (invalidBaseUrl) {
        return `LLM endpoint '${config.endpointId}' is unsafe: ${invalidBaseUrl}`;
      }
      return undefined;
    },
    create: (config) =>
      new OpenAICodexAdapter({
        model: config.model,
        providerId: config.endpointId,
        baseUrl: config.baseUrl,
        reasoningEffort: config.reasoningEffort,
        thinking: config.thinking,
      }),
  },
  gemini: {
    validate: validateNonCodexAuth,
    create: (config) =>
      new GeminiAdapter({
        apiKey: apiKeyOrLocal(config),
        model: config.model,
        providerId: config.endpointId,
        baseUrl: config.baseUrl,
        headers: config.headers,
        thinking: config.thinking,
      }),
  },
} satisfies Record<LlmProtocol, LlmProtocolDriver>;

export function validateLlmAdapterConfig(config: LlmAdapterConfig): string | undefined {
  return validateEndpointTransport(config) ?? protocolDrivers[config.protocol].validate(config);
}

export function createLlmAdapter(config: LlmAdapterConfig): LlmAdapter {
  const invalidReason = validateLlmAdapterConfig(config);
  if (invalidReason) {
    throw new Error(invalidReason);
  }

  const adapter = protocolDrivers[config.protocol].create(config);

  const runtimeDescriptor = {
    endpointId: config.endpointId,
    protocol: config.protocol,
    model: config.model,
    maxOutputTokens: resolveEnforcedMaxOutputTokens(config.protocol, config.maxOutputTokens),
    capabilities: config.capabilities ?? {},
    ownsToolLoop: false,
  } satisfies LlmRuntimeDescriptor;
  Object.defineProperty(adapter, "runtimeDescriptor", {
    configurable: false,
    enumerable: false,
    value: runtimeDescriptor,
    writable: false,
  });
  return adapter;
}

import type { LlmReasoningEffort } from "../config/schema";
import { createProviderContinuationIssuer } from "./continuation";
import type { CodexCredentials, FetchLike } from "./openai-codex-auth";
import { resolveCodexCredentials } from "./openai-codex-auth";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesUrl,
  normalizeOpenAIResponsesOutput,
  type OpenAIResponse,
  type OpenAIResponseFunctionCall,
  type OpenAIResponseOutputItem,
  type OpenAIResponseOutputMessage,
  type OpenAIResponseReasoningItem,
  type OpenAIResponsesInputContentPart,
  type OpenAIResponsesRequest,
  type OpenAIResponsesRequestInputItem,
  type OpenAIResponsesRequestTool,
  OpenAIResponsesTransport,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
} from "./openai-responses";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmChatOptions,
  ProviderContinuationIssuer,
} from "./types";

export type { CodexAuthStatus } from "./openai-codex-auth";
export { getCodexAuthStatus, resolveCodexCredentials } from "./openai-codex-auth";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function validateOpenAICodexBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const candidate = new URL(baseUrl);
    const normalizedPath = candidate.pathname.replace(/\/+$/, "");
    if (
      candidate.origin !== "https://chatgpt.com" ||
      normalizedPath !== "/backend-api/codex" ||
      candidate.username ||
      candidate.password ||
      candidate.search ||
      candidate.hash
    ) {
      return "OpenAI Codex subscription auth may only be sent to https://chatgpt.com/backend-api/codex.";
    }
    return undefined;
  } catch {
    return "OpenAI Codex subscription auth requires a valid official Codex base URL.";
  }
}

export type CodexResponseOutputMessage = OpenAIResponseOutputMessage;
export type CodexResponseFunctionCall = OpenAIResponseFunctionCall;
export type CodexResponseReasoningItem = OpenAIResponseReasoningItem;
export type CodexResponseOutputItem = OpenAIResponseOutputItem;
export type CodexResponse = OpenAIResponse;
export type CodexInputContentPart = OpenAIResponsesInputContentPart;
export type CodexRequestInputItem = OpenAIResponsesRequestInputItem;
export type CodexRequestTool = OpenAIResponsesRequestTool;
export type CodexRequest = OpenAIResponsesRequest;

export type OpenAICodexAdapterOptions = {
  model: string;
  providerId?: string;
  baseUrl?: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: EffectiveThinkingConfig;
  authPath?: string;
  fetchFn?: FetchLike;
};

function codexIssuer(
  model: string,
  providerId: string,
  scope = "unspecified",
): ProviderContinuationIssuer {
  return {
    protocol: "openai-codex",
    provider: providerId,
    model,
    scope,
  };
}

function requestHeaders(credentials: CodexCredentials): Headers {
  return new Headers({
    authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    originator: "sloppy",
    "user-agent": "sloppy",
    "openai-beta": "responses=experimental",
    "content-type": "application/json",
    accept: "text/event-stream",
  });
}

export function toCodexInput(
  messages: ConversationMessage[],
  model?: string,
  providerId = "openai-codex",
): CodexRequestInputItem[] {
  return toOpenAIResponsesInput(messages, model ? codexIssuer(model, providerId) : undefined);
}

export const toCodexTools = toOpenAIResponsesTools;

export function buildCodexRequest(
  options: LlmChatOptions,
  model: string,
  reasoningEffort?: LlmReasoningEffort,
  thinking?: EffectiveThinkingConfig,
  providerId = "openai-codex",
): CodexRequest {
  return buildOpenAIResponsesRequest(options, {
    model,
    issuer: codexIssuer(model, providerId),
    reasoningEffort,
    thinking,
    thinkingConfig: "openai-codex",
    includeMaxOutputTokens: false,
  });
}

export function normalizeCodexOutput(
  response: CodexResponse,
  model: string,
  providerId: string,
  fallback?: { text?: string; output?: CodexResponseOutputItem[] },
): AssistantContentBlock[] {
  return normalizeOpenAIResponsesOutput(response, codexIssuer(model, providerId), fallback);
}

export const buildCodexResponseUrl = buildOpenAIResponsesUrl;

export class OpenAICodexAdapter extends OpenAIResponsesTransport {
  constructor(options: OpenAICodexAdapterOptions) {
    const invalidBaseUrl = validateOpenAICodexBaseUrl(options.baseUrl);
    if (invalidBaseUrl) {
      throw new Error(invalidBaseUrl);
    }
    const providerId = options.providerId ?? "openai-codex";
    const fetchFn = options.fetchFn ?? fetch;
    const baseUrl = options.baseUrl ?? DEFAULT_CODEX_BASE_URL;
    const defaultIssuer = createProviderContinuationIssuer({
      protocol: "openai-codex",
      provider: providerId,
      model: options.model,
      baseUrl,
      credentialIdentity: options.authPath ?? "codex-auth-store",
    });
    super({
      model: options.model,
      issuer: defaultIssuer,
      baseUrl,
      reasoningEffort: options.reasoningEffort,
      thinking: options.thinking,
      thinkingConfig: "openai-codex",
      includeMaxOutputTokens: false,
      fetchFn,
      getHeaders: async (signal) =>
        requestHeaders(
          await resolveCodexCredentials({
            authPath: options.authPath,
            fetchFn,
            signal,
          }),
        ),
      getRequestContext: async (signal) => {
        const credentials = await resolveCodexCredentials({
          authPath: options.authPath,
          fetchFn,
          signal,
        });
        return {
          headers: requestHeaders(credentials),
          issuer: createProviderContinuationIssuer({
            protocol: "openai-codex",
            provider: providerId,
            model: options.model,
            baseUrl,
            credentialIdentity: credentials.accountId,
          }),
        };
      },
      errorLabel: "OpenAI Codex",
      // Never forward subscription bearer/account headers through redirects.
      redirect: "error",
    });
  }
}

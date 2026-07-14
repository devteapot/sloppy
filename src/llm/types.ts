import type { LlmTool } from "@slop-ai/consumer/browser";

import type { LlmEndpointModelCapabilitiesConfig, LlmProtocol } from "../config/schema";

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputError?: {
    code: "invalid_json";
    message: string;
    raw: string;
  };
}

export type ThinkingOutputFormat = "raw" | "summary";
export type ThinkingOutputDisplay = "visible" | "hidden";
export type ThinkingTokenCountSource = "reported" | "unavailable";

export interface ThinkingOutputBlock {
  type: "thinking";
  id?: string;
  provider?: string;
  model?: string;
  format: ThinkingOutputFormat;
  display: ThinkingOutputDisplay;
  text: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  tokenCount?: number;
  tokenCountSource?: ThinkingTokenCountSource;
}

export interface ThinkingOutputDelta {
  id?: string;
  provider?: string;
  model?: string;
  format: ThinkingOutputFormat;
  display: ThinkingOutputDisplay;
  delta: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  tokenCount?: number;
  tokenCountSource?: ThinkingTokenCountSource;
  done?: boolean;
}

export interface ToolResultContentBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImageContentBlock {
  type: "image";
  mediaType: string;
  data: string;
}

export interface ProviderContinuationIssuer {
  protocol: LlmProtocol;
  provider: string;
  model: string;
  /** Opaque hash of the wire origin and credential/account identity. */
  scope: string;
}

/**
 * Opaque provider-native state that must survive in private conversation history.
 * Only the adapter matching every issuer field may interpret or replay `data`.
 */
export interface ProviderContinuationContentBlock {
  type: "provider_continuation";
  purpose: "reasoning" | "assistant_message" | "tool_call";
  issuer: ProviderContinuationIssuer;
  data: unknown;
}

export type AssistantContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ProviderContinuationContentBlock;
export type MessageContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | ProviderContinuationContentBlock;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: MessageContentBlock[];
}

export interface LlmResponse {
  content: AssistantContentBlock[];
  thinking?: ThinkingOutputBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  };
}

export type LlmTokenCountSource = "provider" | "local" | "unavailable";

export interface LlmTokenCount {
  tokens?: number;
  source: LlmTokenCountSource;
}

export interface LlmChatOptions {
  system: string;
  messages: ConversationMessage[];
  tools?: LlmTool[];
  maxTokens: number;
  onText?: (chunk: string) => void;
  onThinking?: (delta: ThinkingOutputDelta) => void;
  signal?: AbortSignal;
}

export interface LlmAdapter {
  readonly runtimeDescriptor?: LlmRuntimeDescriptor;
  chat(options: LlmChatOptions): Promise<LlmResponse>;
  countTextTokens?(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount>;
}

export type LlmRuntimeDescriptor = {
  endpointId: string;
  protocol: LlmProtocol;
  model: string;
  maxOutputTokens?: number;
  capabilities: LlmEndpointModelCapabilitiesConfig;
  ownsToolLoop: false;
};

export function getLlmRuntimeDescriptor(llm: LlmAdapter): LlmRuntimeDescriptor | undefined {
  return llm.runtimeDescriptor;
}

export function resolveLlmMaxTokens(llm: LlmAdapter, configuredMaxTokens: number): number {
  const modelLimit = llm.runtimeDescriptor?.maxOutputTokens;
  return modelLimit === undefined ? configuredMaxTokens : Math.min(configuredMaxTokens, modelLimit);
}

export type LlmRequestErrorCode =
  | "authentication"
  | "invalid_request"
  | "network"
  | "overloaded"
  | "provider"
  | "rate_limit"
  | "timeout";

export interface LlmRequestErrorOptions {
  code: LlmRequestErrorCode;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  requestId?: string;
  partialOutput?: boolean;
  cause?: unknown;
}

export class LlmRequestError extends Error {
  readonly code: LlmRequestErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly partialOutput: boolean;
  override readonly cause?: unknown;

  constructor(message: string, options: LlmRequestErrorOptions) {
    super(message);
    this.name = "LlmRequestError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    this.partialOutput = options.partialOutput ?? false;
    this.cause = options.cause;
  }
}

export class LlmAbortError extends Error {
  readonly code = "aborted";

  constructor(message = "Model turn cancelled.") {
    super(message);
    this.name = "LlmAbortError";
  }
}

export function isLlmAbortError(error: unknown): error is LlmAbortError {
  return error instanceof LlmAbortError;
}

export function normalizeLlmAbortError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof LlmAbortError) {
    return error;
  }

  if (signal?.aborted) {
    return new LlmAbortError();
  }

  if (!(error instanceof Error)) {
    return error;
  }

  const candidate = error as Error & {
    code?: string;
    cause?: unknown;
  };
  if (
    candidate.name === "AbortError" ||
    candidate.name === "APIUserAbortError" ||
    candidate.code === "ABORT_ERR" ||
    candidate.code === "ERR_ABORTED"
  ) {
    return new LlmAbortError();
  }

  if (candidate.cause instanceof Error) {
    return normalizeLlmAbortError(candidate.cause, signal);
  }

  return error;
}

export function isProviderContinuationFor(
  block: MessageContentBlock,
  issuer: ProviderContinuationIssuer,
): block is ProviderContinuationContentBlock {
  return (
    block.type === "provider_continuation" &&
    block.issuer.protocol === issuer.protocol &&
    block.issuer.provider === issuer.provider &&
    block.issuer.model === issuer.model &&
    block.issuer.scope === issuer.scope
  );
}

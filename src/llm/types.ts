import type { LlmTool } from "@slop-ai/consumer/browser";

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

export type AssistantContentBlock = TextContentBlock | ToolUseContentBlock;
export type MessageContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: MessageContentBlock[];
}

export type ConversationHistoryEntryKind = "user" | "assistant" | "tool" | "summary";

export type ConversationHistoryEntrySnapshot = {
  kind: ConversationHistoryEntryKind;
  message: ConversationMessage;
};

export type ConversationCompactionSnapshot = {
  compactedAt: string;
  summary: string;
  archivedEntryCount: number;
  retainedEntryCount: number;
};

export type ConversationHistorySnapshot = {
  version: 1;
  archive: ConversationHistoryEntrySnapshot[];
  active: ConversationHistoryEntrySnapshot[];
  compactions: ConversationCompactionSnapshot[];
};

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
  chat(options: LlmChatOptions): Promise<LlmResponse>;
  countTextTokens?(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount>;
}

export class LlmAbortError extends Error {
  readonly code = "aborted";

  constructor(message = "Model turn cancelled.") {
    super(message);
    this.name = "LlmAbortError";
  }
}

export class LlmContextOverflowError extends Error {
  readonly code = "context_overflow";

  constructor(message = "The model context window was exceeded.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmContextOverflowError";
  }
}

export function isLlmAbortError(error: unknown): error is LlmAbortError {
  return error instanceof LlmAbortError;
}

export function isLlmContextOverflowError(error: unknown): error is LlmContextOverflowError {
  return error instanceof LlmContextOverflowError;
}

function errorCode(error: Error & { code?: unknown; type?: unknown }): string {
  const value = error.code ?? error.type;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function looksLikeContextOverflow(error: Error & { code?: unknown; type?: unknown }): boolean {
  const code = errorCode(error);
  if (
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    code === "prompt_too_long" ||
    code === "request_too_large"
  ) {
    return true;
  }

  const message = error.message.toLowerCase();
  return [
    "context length exceeded",
    "context window exceeded",
    "maximum context length",
    "exceeds the context window",
    "prompt is too long",
    "input is too long",
    "too many input tokens",
    "request too large for model",
  ].some((pattern) => message.includes(pattern));
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

export function normalizeLlmError(error: unknown, signal?: AbortSignal): unknown {
  const abortError = normalizeLlmAbortError(error, signal);
  if (abortError instanceof LlmAbortError || abortError instanceof LlmContextOverflowError) {
    return abortError;
  }
  if (!(abortError instanceof Error)) {
    return abortError;
  }

  const candidate = abortError as Error & {
    code?: unknown;
    type?: unknown;
    cause?: unknown;
  };
  if (looksLikeContextOverflow(candidate)) {
    return new LlmContextOverflowError(candidate.message, { cause: candidate });
  }
  if (candidate.cause) {
    const normalizedCause = normalizeLlmError(candidate.cause, signal);
    if (normalizedCause instanceof LlmContextOverflowError) {
      return new LlmContextOverflowError(candidate.message, { cause: candidate });
    }
  }
  return error;
}

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

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
}

export interface ToolResultContentBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type AssistantContentBlock = TextContentBlock | ToolUseContentBlock;
export type MessageContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: MessageContentBlock[];
}

export interface LlmResponse {
  content: AssistantContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LlmChatOptions {
  system: string;
  messages: ConversationMessage[];
  tools?: LlmTool[];
  maxTokens: number;
  onText?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface LlmAdapter {
  chat(options: LlmChatOptions): Promise<LlmResponse>;
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

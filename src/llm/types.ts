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
}

export interface LlmAdapter {
  chat(options: LlmChatOptions): Promise<LlmResponse>;
}

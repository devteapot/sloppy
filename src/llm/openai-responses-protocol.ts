import type { LlmTool } from "@slop-ai/consumer/browser";

import type { LlmReasoningEffort } from "../config/schema";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmChatOptions,
  LlmResponse,
  ProviderContinuationContentBlock,
  ProviderContinuationIssuer,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types";
import { isProviderContinuationFor } from "./types";

type OpenAIResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export type OpenAIResponseOutputMessage = {
  [key: string]: unknown;
  type: "message";
  id?: string;
  role?: "assistant";
  content?: Array<
    | ({ type: "output_text"; text?: string } & Record<string, unknown>)
    | ({ type: "refusal"; refusal?: string } & Record<string, unknown>)
  >;
  phase?: "commentary" | "final_answer" | null;
  status?: string;
};

export type OpenAIResponseFunctionCall = {
  [key: string]: unknown;
  type: "function_call";
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  status?: string;
};

export type OpenAIResponseReasoningItem = {
  [key: string]: unknown;
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  content?: Array<{ type: "reasoning_text"; text: string }>;
  encrypted_content?: string | null;
  status?: "in_progress" | "completed" | "incomplete";
};

export type OpenAIResponseOutputItem =
  | OpenAIResponseOutputMessage
  | OpenAIResponseFunctionCall
  | OpenAIResponseReasoningItem;

export type OpenAIResponse = {
  id?: string;
  status?: string;
  incomplete_details?: {
    reason?: "max_output_tokens" | "content_filter";
  } | null;
  output?: OpenAIResponseOutputItem[];
  usage?: OpenAIResponseUsage;
};

export type OpenAIResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

export type OpenAIResponsesRequestInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: string | OpenAIResponsesInputContentPart[];
      phase?: "commentary" | "final_answer";
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    }
  | OpenAIResponseOutputItem;

export type OpenAIResponsesRequestTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: false;
};

export type OpenAIResponsesRequest = {
  model: string;
  instructions: string;
  input: OpenAIResponsesRequestInputItem[];
  parallel_tool_calls: true;
  store: false;
  max_output_tokens?: number;
  reasoning?: {
    effort: LlmReasoningEffort;
    summary?: "auto" | "concise" | "detailed";
  };
  include?: ["reasoning.encrypted_content"];
  tools?: OpenAIResponsesRequestTool[];
  tool_choice?: "auto";
  stream?: boolean;
};

type OpenAIResponsesContinuationReplacement =
  | { type: "assistant_text" }
  | { type: "tool_use"; id: string };

type OpenAIResponsesContinuationData = {
  kind: "response_output_item";
  item: OpenAIResponseOutputItem;
  replaces?: OpenAIResponsesContinuationReplacement;
};

export type OpenAIResponsesRequestBuildOptions = {
  model: string;
  issuer: ProviderContinuationIssuer;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: EffectiveThinkingConfig;
  thinkingConfig: "openai" | "openai-codex";
  includeMaxOutputTokens: boolean;
};

function isStringOrUndefined(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isAssistantPhase(value: unknown): value is OpenAIResponseOutputMessage["phase"] {
  return (
    value === undefined || value === null || value === "commentary" || value === "final_answer"
  );
}

function parseOpenAIResponseOutputItem(value: unknown): OpenAIResponseOutputItem | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (item.type === "message") {
    if (
      !isStringOrUndefined(item.id) ||
      !isStringOrUndefined(item.status) ||
      !isAssistantPhase(item.phase) ||
      (item.role !== undefined && item.role !== "assistant") ||
      (item.content !== undefined && !Array.isArray(item.content))
    ) {
      return undefined;
    }
    for (const part of item.content ?? []) {
      if (!part || typeof part !== "object") {
        return undefined;
      }
      const candidate = part as Record<string, unknown>;
      if (candidate.type === "output_text" && isStringOrUndefined(candidate.text)) {
        continue;
      }
      if (candidate.type === "refusal" && isStringOrUndefined(candidate.refusal)) {
        continue;
      }
      return undefined;
    }
    return item as OpenAIResponseOutputMessage;
  }

  if (item.type === "function_call") {
    if (
      !isStringOrUndefined(item.id) ||
      !isStringOrUndefined(item.call_id) ||
      !isStringOrUndefined(item.name) ||
      !isStringOrUndefined(item.arguments) ||
      !isStringOrUndefined(item.status)
    ) {
      return undefined;
    }
    return item as OpenAIResponseFunctionCall;
  }

  if (
    item.type !== "reasoning" ||
    typeof item.id !== "string" ||
    !Array.isArray(item.summary) ||
    (item.content !== undefined && !Array.isArray(item.content)) ||
    (item.encrypted_content !== undefined &&
      item.encrypted_content !== null &&
      typeof item.encrypted_content !== "string") ||
    (item.status !== undefined &&
      item.status !== "in_progress" &&
      item.status !== "completed" &&
      item.status !== "incomplete")
  ) {
    return undefined;
  }
  for (const part of item.summary) {
    if (
      !part ||
      typeof part !== "object" ||
      (part as Record<string, unknown>).type !== "summary_text" ||
      typeof (part as Record<string, unknown>).text !== "string"
    ) {
      return undefined;
    }
  }
  for (const part of item.content ?? []) {
    if (
      !part ||
      typeof part !== "object" ||
      (part as Record<string, unknown>).type !== "reasoning_text" ||
      typeof (part as Record<string, unknown>).text !== "string"
    ) {
      return undefined;
    }
  }
  return item as OpenAIResponseReasoningItem;
}

function parseOpenAIResponsesContinuation(
  block: ProviderContinuationContentBlock,
  issuer: ProviderContinuationIssuer,
): OpenAIResponsesContinuationData | undefined {
  if (!isProviderContinuationFor(block, issuer)) {
    return undefined;
  }
  if (!block.data || typeof block.data !== "object") {
    return undefined;
  }
  const data = block.data as Record<string, unknown>;
  if (data.kind !== "response_output_item") {
    return undefined;
  }
  const item = parseOpenAIResponseOutputItem(data.item);
  if (!item) {
    return undefined;
  }
  let replaces: OpenAIResponsesContinuationReplacement | undefined;
  if (data.replaces !== undefined) {
    if (!data.replaces || typeof data.replaces !== "object") {
      return undefined;
    }
    const candidate = data.replaces as Record<string, unknown>;
    if (candidate.type === "assistant_text") {
      replaces = { type: "assistant_text" };
    } else if (candidate.type === "tool_use" && typeof candidate.id === "string") {
      replaces = { type: "tool_use", id: candidate.id };
    } else {
      return undefined;
    }
  }
  return {
    kind: "response_output_item",
    item,
    ...(replaces ? { replaces } : {}),
  };
}

function openAIResponsesContinuationBlock(
  issuer: ProviderContinuationIssuer,
  item: OpenAIResponseOutputItem,
  replaces?: OpenAIResponsesContinuationReplacement,
): ProviderContinuationContentBlock {
  return {
    type: "provider_continuation",
    purpose:
      item.type === "function_call"
        ? "tool_call"
        : item.type === "message"
          ? "assistant_message"
          : "reasoning",
    issuer,
    data: {
      kind: "response_output_item",
      item,
      ...(replaces ? { replaces } : {}),
    } satisfies OpenAIResponsesContinuationData,
  };
}

function parseToolArguments(
  argumentsJson: string,
): Pick<ToolUseContentBlock, "input" | "inputError"> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown> };
    }
    return { input: { value: parsed } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: {},
      inputError: {
        code: "invalid_json",
        message: `Tool arguments were not valid JSON: ${message}`,
        raw: argumentsJson,
      },
    };
  }
}

function textFromMessage(message: ConversationMessage): string {
  return message.content
    .filter(
      (block): block is Extract<ConversationMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

export function toOpenAIResponsesInput(
  messages: ConversationMessage[],
  issuer?: ProviderContinuationIssuer,
): OpenAIResponsesRequestInputItem[] {
  const input: OpenAIResponsesRequestInputItem[] = [];

  for (const message of messages) {
    const toolResults = message.content.filter(
      (block): block is ToolResultContentBlock => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        input.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
      }
      continue;
    }

    if (message.role === "user") {
      const parts: OpenAIResponsesInputContentPart[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.length > 0) {
          parts.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
          });
        }
      }
      if (parts.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content: parts.some((part) => part.type === "input_image")
            ? parts
            : parts.map((part) => (part.type === "input_text" ? part.text : "")).join(""),
        });
      }
      continue;
    }

    const continuations = new Map<
      ProviderContinuationContentBlock,
      OpenAIResponsesContinuationData
    >();
    if (issuer) {
      for (const block of message.content) {
        if (block.type !== "provider_continuation") {
          continue;
        }
        const continuation = parseOpenAIResponsesContinuation(block, issuer);
        if (continuation) {
          continuations.set(block, continuation);
        }
      }
    }

    if (continuations.size === 0) {
      const text = textFromMessage(message);
      if (text.length > 0) {
        input.push({
          type: "message",
          role: message.role,
          content: text,
          phase: "final_answer",
        });
      }
      for (const block of message.content) {
        if (block.type === "tool_use") {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
            status: "completed",
          });
        }
      }
      continue;
    }

    const replacesText = [...continuations.values()].some(
      (continuation) => continuation.replaces?.type === "assistant_text",
    );
    const replacedToolUses = new Set(
      [...continuations.values()].flatMap((continuation) =>
        continuation.replaces?.type === "tool_use" ? [continuation.replaces.id] : [],
      ),
    );
    for (const block of message.content) {
      if (block.type === "provider_continuation") {
        const continuation = continuations.get(block);
        if (continuation) {
          input.push(continuation.item);
        }
        continue;
      }
      if (block.type === "text" && block.text.length > 0 && !replacesText) {
        input.push({
          type: "message",
          role: "assistant",
          content: block.text,
          phase: "final_answer",
        });
        continue;
      }
      if (block.type === "tool_use" && !replacedToolUses.has(block.id)) {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: "completed",
        });
      }
    }
  }

  return input;
}

export function toOpenAIResponsesTools(tools: LlmTool[]): OpenAIResponsesRequestTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));
}

function resolveThinkingConfig(
  thinking: EffectiveThinkingConfig | undefined,
  thinkingConfig: OpenAIResponsesRequestBuildOptions["thinkingConfig"],
) {
  return thinkingConfig === "openai-codex"
    ? (thinking?.openaiCodex ?? thinking?.openai)
    : thinking?.openai;
}

export function buildOpenAIResponsesRequest(
  options: LlmChatOptions,
  config: OpenAIResponsesRequestBuildOptions,
): OpenAIResponsesRequest {
  const request: OpenAIResponsesRequest = {
    model: config.model,
    instructions: options.system,
    input: toOpenAIResponsesInput(options.messages, config.issuer),
    parallel_tool_calls: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(config.includeMaxOutputTokens ? { max_output_tokens: options.maxTokens } : {}),
  };

  if (config.thinking?.effectiveEnabled || config.reasoningEffort) {
    const providerThinking = resolveThinkingConfig(config.thinking, config.thinkingConfig);
    const summary = config.thinking ? (providerThinking?.summary ?? "auto") : "none";
    request.reasoning = {
      effort: providerThinking?.effort ?? config.reasoningEffort ?? "medium",
      ...(summary !== "none" ? { summary } : {}),
    };
  }

  if (options.tools?.length) {
    request.tools = toOpenAIResponsesTools(options.tools);
    request.tool_choice = "auto";
  }

  return request;
}

export function normalizeOpenAIResponsesOutput(
  response: OpenAIResponse,
  issuer: ProviderContinuationIssuer,
  fallback?: { text?: string; output?: OpenAIResponseOutputItem[] },
): AssistantContentBlock[] {
  const output = response.output?.length ? response.output : (fallback?.output ?? []);
  const blocks: AssistantContentBlock[] = [];

  for (const item of output) {
    if (item.type === "reasoning") {
      blocks.push(openAIResponsesContinuationBlock(issuer, item));
      continue;
    }

    if (item.type === "message") {
      const text =
        item.content
          ?.map((part) => {
            if (part.type === "output_text") {
              return part.text ?? "";
            }
            return part.refusal ?? "";
          })
          .join("") ?? "";
      blocks.push(
        openAIResponsesContinuationBlock(issuer, item, {
          type: "assistant_text",
        }),
      );
      if (text) {
        blocks.push({ type: "text", text });
      }
      continue;
    }

    if (item.type === "function_call" && item.name && item.call_id) {
      blocks.push(
        openAIResponsesContinuationBlock(issuer, item, {
          type: "tool_use",
          id: item.call_id,
        }),
      );
      blocks.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        ...parseToolArguments(item.arguments ?? "{}"),
      });
    }
  }

  if (
    !blocks.some((block) => block.type === "text" || block.type === "tool_use") &&
    fallback?.text
  ) {
    blocks.push({ type: "text", text: fallback.text });
  }

  return blocks;
}

export function normalizeOpenAIResponsesStopReason(
  response: OpenAIResponse,
  content: AssistantContentBlock[],
): LlmResponse["stopReason"] {
  if (content.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason !== "content_filter"
  ) {
    return "max_tokens";
  }
  return "end_turn";
}

export function buildOpenAIResponsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

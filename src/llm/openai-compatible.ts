import type { LlmTool } from "@slop-ai/consumer/browser";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  ThinkingOutputBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types";
import { LlmAbortError, normalizeLlmError } from "./types";

export type OpenAICompatibleProviderKind = "openai" | "openrouter" | "ollama" | "generic";

interface OpenAICompatibleClient {
  chat: {
    completions: {
      create(
        parameters: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<ChatCompletion>;
      stream(
        parameters: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): {
        on(event: "content", listener: (delta: string, snapshot: string) => void): void;
        on(event: "chunk", listener: (chunk: unknown, snapshot: unknown) => void): void;
        finalChatCompletion(): Promise<ChatCompletion>;
        abort?(): void;
      };
    };
  };
  responses?: {
    inputTokens: {
      count(
        parameters: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<{ input_tokens?: number }>;
    };
  };
}

function toOpenAITools(tools: LlmTool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

function parseToolArguments(
  argumentsJson: string,
): Pick<ToolUseContentBlock, "input" | "inputError"> {
  const parsed = parseToolArgumentsJson(argumentsJson);
  if (parsed) {
    return parsed;
  }

  const repaired = parseToolArgumentsWithTrailingBraceRepair(argumentsJson);
  if (repaired) {
    return repaired;
  }

  try {
    JSON.parse(argumentsJson);
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

  return {
    input: {},
    inputError: {
      code: "invalid_json",
      message: "Tool arguments could not be normalized.",
      raw: argumentsJson,
    },
  };
}

function normalizeParsedToolArguments(
  parsed: unknown,
): Pick<ToolUseContentBlock, "input" | "inputError"> {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { input: parsed as Record<string, unknown> };
  }

  return { input: { value: parsed } };
}

function parseToolArgumentsJson(
  argumentsJson: string,
): Pick<ToolUseContentBlock, "input" | "inputError"> | null {
  try {
    return normalizeParsedToolArguments(JSON.parse(argumentsJson) as unknown);
  } catch {
    return null;
  }
}

function parseToolArgumentsWithTrailingBraceRepair(
  argumentsJson: string,
): Pick<ToolUseContentBlock, "input" | "inputError"> | null {
  let candidate = argumentsJson.trimEnd();

  for (let attempts = 0; attempts < 4 && /[}\]]$/.test(candidate); attempts += 1) {
    candidate = candidate.slice(0, -1).trimEnd();
    const parsed = parseToolArgumentsJson(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function extractTextContent(
  content: ChatCompletion["choices"][number]["message"]["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  return "";
}

function toOpenAIToolResultMessage(block: ToolResultContentBlock): ChatCompletionMessageParam {
  return {
    role: "tool",
    tool_call_id: block.toolUseId,
    content: block.content,
  };
}

function toOpenAIAssistantMessage(
  message: ConversationMessage,
): ChatCompletionAssistantMessageParam {
  const text = message.content
    .filter((block): block is AssistantContentBlock => block.type !== "tool_result")
    .filter(
      (block): block is Extract<AssistantContentBlock, { type: "text" }> => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block): block is ToolUseContentBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input),
      },
    }));

  return {
    role: "assistant",
    content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function toOpenAIMessages(
  system: string,
  messages: ConversationMessage[],
): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: system,
    },
  ];

  for (const message of messages) {
    const toolResults = message.content.filter(
      (block): block is ToolResultContentBlock => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      converted.push(...toolResults.map((block) => toOpenAIToolResultMessage(block)));
      continue;
    }

    if (message.role === "assistant") {
      converted.push(toOpenAIAssistantMessage(message));
      continue;
    }

    const parts: ChatCompletionContentPart[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        });
      }
    }
    if (parts.some((part) => part.type === "image_url")) {
      converted.push({ role: "user", content: parts });
    } else {
      converted.push({
        role: "user",
        content: parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      });
    }
  }

  return converted;
}

function normalizeAssistantContent(completion: ChatCompletion): AssistantContentBlock[] {
  const choice = completion.choices[0];
  if (!choice) {
    return [];
  }

  const blocks: AssistantContentBlock[] = [];
  const text = `${extractTextContent(choice.message.content)}${choice.message.refusal ?? ""}`;
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    if (toolCall.type !== "function") {
      continue;
    }

    const parsed = parseToolArguments(toolCall.function.arguments);
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      ...parsed,
    });
  }

  return blocks;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reasoningTextFromRecord(record: Record<string, unknown>): {
  text: string;
  format: "raw" | "summary";
} {
  const raw =
    stringField(record, "reasoning_content") ||
    stringField(record, "thinking") ||
    stringField(record, "reasoning");
  if (raw) {
    return { text: raw, format: "raw" };
  }

  const details = record.reasoning_details;
  if (Array.isArray(details)) {
    const text = details
      .map((item) => {
        const detail = recordFromUnknown(item);
        return detail ? stringField(detail, "text") || stringField(detail, "summary") : "";
      })
      .join("");
    if (text) {
      return { text, format: "summary" };
    }
  }

  return { text: "", format: "raw" };
}

function extractReasoningText(completion: ChatCompletion): {
  text: string;
  format: "raw" | "summary";
} {
  const choice = completion.choices[0];
  const message = choice?.message as unknown as Record<string, unknown> | undefined;
  if (!message) {
    return { text: "", format: "raw" };
  }

  return reasoningTextFromRecord(message);
}

function extractReasoningDelta(chunk: unknown): {
  text: string;
  format: "raw" | "summary";
} {
  const record = recordFromUnknown(chunk);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = recordFromUnknown(choices[0]);
  const delta = recordFromUnknown(firstChoice?.delta);
  return delta ? reasoningTextFromRecord(delta) : { text: "", format: "raw" };
}

function reasoningTokens(completion: ChatCompletion): number | undefined {
  const usage = completion.usage as
    | {
        completion_tokens_details?: {
          reasoning_tokens?: number;
        };
        output_tokens_details?: {
          reasoning_tokens?: number;
        };
      }
    | undefined;
  return (
    usage?.completion_tokens_details?.reasoning_tokens ??
    usage?.output_tokens_details?.reasoning_tokens
  );
}

function normalizeThinkingContent(
  completion: ChatCompletion,
  provider: string,
  model: string,
  thinking: EffectiveThinkingConfig | undefined,
): ThinkingOutputBlock[] | undefined {
  const { text, format } = extractReasoningText(completion);
  if (!text || !thinking?.effectiveEnabled) {
    return undefined;
  }
  const tokenCount = reasoningTokens(completion);
  return [
    {
      type: "thinking",
      id: `${provider}-thinking-0`,
      provider,
      model,
      format,
      display: thinking.display,
      text,
      tokenCount,
      tokenCountSource: tokenCount === undefined ? "unavailable" : "reported",
    },
  ];
}

type StreamedThinkingState = {
  text: string;
  format: "raw" | "summary";
  startedAt?: string;
  startedMs?: number;
};

function thinkingBlockFromStream(
  streamed: StreamedThinkingState | undefined,
  completion: ChatCompletion,
  provider: string,
  model: string,
  thinking: EffectiveThinkingConfig | undefined,
): ThinkingOutputBlock[] | undefined {
  if (!streamed?.text || !thinking?.effectiveEnabled) {
    return undefined;
  }
  const tokenCount = reasoningTokens(completion);
  return [
    {
      type: "thinking",
      id: `${provider}-thinking-0`,
      provider,
      model,
      format: streamed.format,
      display: thinking.display,
      text: streamed.text,
      startedAt: streamed.startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: streamed.startedMs ? Date.now() - streamed.startedMs : undefined,
      tokenCount,
      tokenCountSource: tokenCount === undefined ? "unavailable" : "reported",
    },
  ];
}

function normalizeStopReason(completion: ChatCompletion): LlmResponse["stopReason"] {
  const choice = completion.choices[0];
  if (!choice) {
    return "end_turn";
  }

  if ((choice.message.tool_calls?.length ?? 0) > 0 || choice.finish_reason === "tool_calls") {
    return "tool_use";
  }

  if (choice.finish_reason === "length") {
    return "max_tokens";
  }

  return "end_turn";
}

function buildChatParameters(
  provider: OpenAICompatibleProviderKind,
  options: LlmChatOptions,
  model: string,
  thinking?: EffectiveThinkingConfig,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(options.system, options.messages),
    parallel_tool_calls: true,
  };

  if (provider === "openai") {
    parameters.max_completion_tokens = options.maxTokens;
  } else {
    parameters.max_tokens = options.maxTokens;
  }

  if (options.tools?.length) {
    parameters.tools = toOpenAITools(options.tools);
    parameters.tool_choice = "auto";
  }

  if (thinking) {
    applyThinkingParameters(parameters, provider, thinking);
  }

  return parameters;
}

function applyThinkingParameters(
  parameters: Record<string, unknown>,
  provider: OpenAICompatibleProviderKind,
  thinking: EffectiveThinkingConfig,
): void {
  if (provider === "openai") {
    if (thinking.effectiveEnabled) {
      parameters.reasoning_effort = thinking.openai?.effort ?? thinking.effectiveEffort;
      Object.assign(parameters, thinking.openai?.options ?? {});
    } else {
      parameters.reasoning_effort = "minimal";
    }
    return;
  }

  if (provider === "openrouter") {
    parameters.reasoning = {
      enabled: thinking.effectiveEnabled,
      effort: thinking.openrouter?.effort ?? thinking.effectiveEffort,
      exclude: thinking.openrouter?.exclude ?? false,
      ...(thinking.openrouter?.options ?? {}),
    };
    return;
  }

  if (provider === "ollama") {
    parameters.think =
      thinking.ollama?.think ?? (thinking.effectiveEnabled ? thinking.effectiveEffort : false);
    Object.assign(parameters, thinking.ollama?.options ?? {});
  }
}

export class OpenAICompatibleAdapter implements LlmAdapter {
  private client: OpenAICompatibleClient;
  private model: string;
  private provider: string;
  private providerKind: OpenAICompatibleProviderKind;
  private baseUrl?: string;
  private thinking?: EffectiveThinkingConfig;

  constructor(options: {
    apiKey: string;
    model: string;
    provider: string;
    providerKind?: OpenAICompatibleProviderKind;
    baseUrl?: string;
    headers?: Record<string, string>;
    thinking?: EffectiveThinkingConfig;
    client?: OpenAICompatibleClient;
  }) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        defaultHeaders: options.headers,
      }) as unknown as OpenAICompatibleClient);
    this.model = options.model;
    this.provider = options.provider;
    this.providerKind = options.providerKind ?? toOpenAICompatibleProviderKind(options.provider);
    this.baseUrl = options.baseUrl;
    this.thinking = options.thinking;
  }

  async countTextTokens(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount> {
    if (options?.signal?.aborted) {
      throw new LlmAbortError();
    }

    if (
      this.providerKind !== "openai" ||
      (this.baseUrl && !isOpenAIBaseUrl(this.baseUrl)) ||
      !this.client.responses
    ) {
      return { source: "unavailable" };
    }

    try {
      const count = await this.client.responses.inputTokens.count(
        {
          model: this.model,
          input: text,
        },
        {
          signal: options?.signal,
        },
      );
      return count.input_tokens === undefined
        ? { source: "unavailable" }
        : { tokens: count.input_tokens, source: "provider" };
    } catch (error) {
      throw normalizeLlmError(error, options?.signal);
    }
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const parameters = buildChatParameters(this.providerKind, options, this.model, this.thinking);
    try {
      const streamed = options.onText
        ? await this.streamChat(parameters, options.onText, options.onThinking, options.signal)
        : {
            completion: await this.client.chat.completions.create(parameters, {
              signal: options.signal,
            }),
            thinking: undefined,
          };

      const thinking =
        normalizeThinkingContent(streamed.completion, this.provider, this.model, this.thinking) ??
        thinkingBlockFromStream(
          streamed.thinking,
          streamed.completion,
          this.provider,
          this.model,
          this.thinking,
        );
      if (!streamed.thinking) {
        emitThinkingBlocks(thinking, options.onThinking);
      }
      return {
        content: normalizeAssistantContent(streamed.completion),
        thinking,
        stopReason: normalizeStopReason(streamed.completion),
        usage: {
          inputTokens: streamed.completion.usage?.prompt_tokens,
          outputTokens: streamed.completion.usage?.completion_tokens,
          thinkingTokens: reasoningTokens(streamed.completion),
        },
      } satisfies LlmResponse;
    } catch (error) {
      throw normalizeLlmError(error, options.signal);
    }
  }

  private async streamChat(
    parameters: Record<string, unknown>,
    onText: NonNullable<LlmChatOptions["onText"]>,
    onThinking: LlmChatOptions["onThinking"],
    signal?: AbortSignal,
  ): Promise<{ completion: ChatCompletion; thinking?: StreamedThinkingState }> {
    const stream = this.client.chat.completions.stream(parameters, {
      signal,
    });
    const abortStream = () => {
      stream.abort?.();
    };

    try {
      signal?.addEventListener("abort", abortStream, { once: true });
      stream.on("content", (delta) => {
        onText(delta);
      });
      const thinking: StreamedThinkingState = {
        text: "",
        format: "raw",
      };
      stream.on("chunk", (chunk) => {
        if (!onThinking) {
          return;
        }
        const { text, format } = extractReasoningDelta(chunk);
        if (!text) {
          return;
        }
        if (!thinking.startedAt) {
          thinking.startedAt = new Date().toISOString();
          thinking.startedMs = Date.now();
        }
        thinking.text += text;
        thinking.format = format;
        onThinking({
          id: `${this.provider}-thinking-0`,
          provider: this.provider,
          model: this.model,
          format,
          display: this.thinking?.display ?? "visible",
          delta: text,
          startedAt: thinking.startedAt,
        });
      });
      const completion = await stream.finalChatCompletion();
      if (thinking.text && onThinking) {
        const tokenCount = reasoningTokens(completion);
        onThinking({
          id: `${this.provider}-thinking-0`,
          provider: this.provider,
          model: this.model,
          format: thinking.format,
          display: this.thinking?.display ?? "visible",
          delta: "",
          startedAt: thinking.startedAt,
          completedAt: new Date().toISOString(),
          elapsedMs: thinking.startedMs ? Date.now() - thinking.startedMs : undefined,
          tokenCount,
          tokenCountSource: tokenCount === undefined ? "unavailable" : "reported",
          done: true,
        });
      }
      return {
        completion,
        thinking: thinking.text ? thinking : undefined,
      };
    } finally {
      signal?.removeEventListener("abort", abortStream);
    }
  }
}

function toOpenAICompatibleProviderKind(provider: string): OpenAICompatibleProviderKind {
  if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
    return provider;
  }
  return "generic";
}

function emitThinkingBlocks(
  blocks: ThinkingOutputBlock[] | undefined,
  onThinking: LlmChatOptions["onThinking"],
): void {
  if (!onThinking) {
    return;
  }
  for (const block of blocks ?? []) {
    onThinking({
      id: block.id,
      provider: block.provider,
      model: block.model,
      format: block.format,
      display: block.display,
      delta: block.text,
      startedAt: block.startedAt ?? new Date().toISOString(),
      tokenCount: block.tokenCount,
      tokenCountSource: block.tokenCountSource,
      done: true,
    });
  }
}

function isOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
  } catch {
    return false;
  }
}

export {
  buildChatParameters as buildOpenAICompatibleRequest,
  normalizeAssistantContent as normalizeOpenAICompatibleContent,
  toOpenAIMessages,
  toOpenAITools,
};

import type { LlmTool } from "@slop-ai/consumer/browser";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types";
import { LlmAbortError, normalizeLlmAbortError } from "./types";

type OpenAICompatibleProvider = "openai" | "openrouter" | "ollama";

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
        finalChatCompletion(): Promise<ChatCompletion>;
        abort?(): void;
      };
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

    const text = message.content
      .filter(
        (block): block is Extract<ConversationMessage["content"][number], { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");

    converted.push({
      role: "user",
      content: text,
    });
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
  provider: OpenAICompatibleProvider,
  options: LlmChatOptions,
  model: string,
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

  return parameters;
}

export class OpenAICompatibleAdapter implements LlmAdapter {
  private client: OpenAICompatibleClient;
  private model: string;
  private provider: OpenAICompatibleProvider;

  constructor(options: {
    apiKey: string;
    model: string;
    provider: OpenAICompatibleProvider;
    baseUrl?: string;
    client?: OpenAICompatibleClient;
  }) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
      }) as unknown as OpenAICompatibleClient);
    this.model = options.model;
    this.provider = options.provider;
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const parameters = buildChatParameters(this.provider, options, this.model);
    try {
      const completion = options.onText
        ? await this.streamChat(parameters, options.onText, options.signal)
        : await this.client.chat.completions.create(parameters, {
            signal: options.signal,
          });

      return {
        content: normalizeAssistantContent(completion),
        stopReason: normalizeStopReason(completion),
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      } satisfies LlmResponse;
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    }
  }

  private async streamChat(
    parameters: Record<string, unknown>,
    onText: NonNullable<LlmChatOptions["onText"]>,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
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
      return await stream.finalChatCompletion();
    } finally {
      signal?.removeEventListener("abort", abortStream);
    }
  }
}

export {
  buildChatParameters as buildOpenAICompatibleRequest,
  normalizeAssistantContent as normalizeOpenAICompatibleContent,
  toOpenAIMessages,
  toOpenAITools,
};

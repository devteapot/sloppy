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

type OpenAICompatibleProvider = "openai" | "openrouter" | "ollama";

interface OpenAICompatibleClient {
  chat: {
    completions: {
      create(parameters: Record<string, unknown>): Promise<ChatCompletion>;
      stream(parameters: Record<string, unknown>): {
        on(event: "content", listener: (delta: string, snapshot: string) => void): void;
        finalChatCompletion(): Promise<ChatCompletion>;
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

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return { value: parsed };
  } catch {
    return { _raw: argumentsJson };
  }
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

    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments),
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
    const parameters = buildChatParameters(this.provider, options, this.model);
    const completion = options.onText
      ? await this.streamChat(parameters, options.onText)
      : await this.client.chat.completions.create(parameters);

    return {
      content: normalizeAssistantContent(completion),
      stopReason: normalizeStopReason(completion),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    } satisfies LlmResponse;
  }

  private async streamChat(
    parameters: Record<string, unknown>,
    onText: NonNullable<LlmChatOptions["onText"]>,
  ): Promise<ChatCompletion> {
    const stream = this.client.chat.completions.stream(parameters);
    stream.on("content", (delta) => {
      onText(delta);
    });
    return stream.finalChatCompletion();
  }
}

export {
  buildChatParameters as buildOpenAICompatibleRequest,
  normalizeAssistantContent as normalizeOpenAICompatibleContent,
  toOpenAIMessages,
  toOpenAITools,
};

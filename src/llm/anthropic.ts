import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCountTokensParams,
  MessageParam,
  MessageTokensCount,
  ThinkingConfigParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { LlmTool } from "@slop-ai/consumer/browser";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  MessageContentBlock,
  ThinkingOutputBlock,
} from "./types";
import { LlmAbortError, normalizeLlmError } from "./types";

interface AnthropicMessageStream {
  abort(): void;
  on(event: "text", listener: (delta: string) => void): void;
  on(event: "thinking", listener: (delta: string, snapshot: string) => void): void;
  finalMessage(): Promise<Message>;
}

interface AnthropicMessagesClient {
  stream(
    body: Anthropic.MessageStreamParams,
    options?: { signal?: AbortSignal },
  ): AnthropicMessageStream;
  countTokens(
    body: MessageCountTokensParams,
    options?: { signal?: AbortSignal },
  ): Promise<MessageTokensCount>;
}

interface AnthropicClient {
  messages: AnthropicMessagesClient;
}

function toAnthropicTools(tools: LlmTool[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as Tool["input_schema"],
  }));
}

function toAnthropicBlock(block: MessageContentBlock): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: block.data,
        },
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      } satisfies ToolUseBlockParam;
    case "tool_result": {
      const result: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
      };

      if (block.isError) {
        result.is_error = true;
      }

      return result;
    }
  }
}

function toAnthropicMessages(messages: ConversationMessage[]): MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => toAnthropicBlock(block)),
  }));
}

function normalizeAssistantContent(content: ContentBlock[]): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return blocks;
}

function buildThinkingConfig(
  thinking: EffectiveThinkingConfig | undefined,
  maxTokens: number,
): ThinkingConfigParam | undefined {
  if (!thinking) {
    return undefined;
  }

  if (!thinking.effectiveEnabled) {
    return { type: "disabled" };
  }

  const config = thinking.anthropic;
  const output = config?.output ?? "summarized";
  const type = config?.type ?? "adaptive";
  if (type === "disabled") {
    return { type: "disabled" };
  }
  if (type === "enabled") {
    const budget = Math.min(config?.budgetTokens ?? 1024, maxTokens - 1);
    if (budget < 1024) {
      return undefined;
    }
    return { type: "enabled", budget_tokens: budget, display: output };
  }
  return { type: "adaptive", display: output };
}

function normalizeThinkingContent(
  content: ContentBlock[],
  thinking: EffectiveThinkingConfig | undefined,
  model: string,
): ThinkingOutputBlock[] {
  if (!thinking?.effectiveEnabled) {
    return [];
  }
  return content.flatMap((block, index): ThinkingOutputBlock[] => {
    if (block.type !== "thinking" || !block.thinking) {
      return [];
    }
    return [
      {
        type: "thinking",
        id: `anthropic-thinking-${index}`,
        provider: "anthropic",
        model,
        format: "summary",
        display: thinking.display,
        text: block.thinking,
        tokenCountSource: "unavailable",
      },
    ];
  });
}

export class AnthropicAdapter implements LlmAdapter {
  private client: AnthropicClient;
  private model: string;
  private thinking?: EffectiveThinkingConfig;

  constructor(options: {
    apiKey: string;
    model: string;
    thinking?: EffectiveThinkingConfig;
    client?: AnthropicClient;
  }) {
    this.client = options.client ?? (new Anthropic({ apiKey: options.apiKey }) as AnthropicClient);
    this.model = options.model;
    this.thinking = options.thinking;
  }

  async countTextTokens(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount> {
    if (options?.signal?.aborted) {
      throw new LlmAbortError();
    }

    try {
      const count = await this.client.messages.countTokens(
        {
          model: this.model,
          messages: [{ role: "user", content: text }],
        },
        {
          signal: options?.signal,
        },
      );
      return { tokens: count.input_tokens, source: "provider" };
    } catch (error) {
      throw normalizeLlmError(error, options?.signal);
    }
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      system: options.system,
      messages: toAnthropicMessages(options.messages),
      max_tokens: options.maxTokens,
    };
    const thinkingConfig = buildThinkingConfig(this.thinking, options.maxTokens);
    if (thinkingConfig) {
      params.thinking = thinkingConfig;
    }

    if (options.tools?.length) {
      params.tools = toAnthropicTools(options.tools);
      params.tool_choice = { type: "auto", disable_parallel_tool_use: false };
    }

    const stream = this.client.messages.stream(params, {
      signal: options.signal,
    });
    const abortStream = () => {
      stream.abort();
    };

    try {
      options.signal?.addEventListener("abort", abortStream, { once: true });

      if (options.onText) {
        stream.on("text", (delta) => {
          options.onText?.(delta);
        });
      }
      let thinkingStartedAt: string | undefined;
      const thinkingStartedMs = { value: 0 };
      let streamedThinking = "";
      if (options.onThinking && this.thinking?.effectiveEnabled) {
        stream.on("thinking", (delta) => {
          if (!thinkingStartedAt) {
            thinkingStartedAt = new Date().toISOString();
            thinkingStartedMs.value = Date.now();
          }
          streamedThinking += delta;
          options.onThinking?.({
            id: "anthropic-thinking-0",
            provider: "anthropic",
            model: this.model,
            format: "summary",
            display: this.thinking?.display ?? "visible",
            delta,
            startedAt: thinkingStartedAt,
          });
        });
      }

      const finalMessage = await stream.finalMessage();
      const thinking = normalizeThinkingContent(finalMessage.content, this.thinking, this.model);
      if (options.onThinking && thinking.length > 0) {
        for (const block of thinking) {
          if (!streamedThinking) {
            options.onThinking({
              id: block.id,
              provider: block.provider,
              model: block.model,
              format: block.format,
              display: block.display,
              delta: block.text,
              startedAt: block.startedAt ?? new Date().toISOString(),
              tokenCountSource: block.tokenCountSource,
              done: true,
            });
            continue;
          }
          const completedAt = new Date().toISOString();
          options.onThinking({
            id: block.id,
            provider: block.provider,
            model: block.model,
            format: block.format,
            display: block.display,
            delta: "",
            startedAt: thinkingStartedAt,
            completedAt,
            elapsedMs: thinkingStartedMs.value ? Date.now() - thinkingStartedMs.value : undefined,
            tokenCountSource: block.tokenCountSource,
            done: true,
          });
        }
      }
      const stopReason =
        finalMessage.stop_reason === "tool_use"
          ? "tool_use"
          : finalMessage.stop_reason === "max_tokens"
            ? "max_tokens"
            : "end_turn";

      return {
        content: normalizeAssistantContent(finalMessage.content),
        thinking,
        stopReason,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      } satisfies LlmResponse;
    } catch (error) {
      throw normalizeLlmError(error, options.signal);
    } finally {
      options.signal?.removeEventListener("abort", abortStream);
    }
  }
}

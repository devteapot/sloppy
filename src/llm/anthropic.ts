import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCountTokensParams,
  MessageParam,
  MessageTokensCount,
  RedactedThinkingBlockParam,
  ThinkingBlockParam,
  ThinkingConfigParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { LlmTool } from "@slop-ai/consumer/browser";
import { createProviderContinuationIssuer } from "./continuation";
import { rejectRedirectFetch } from "./fetch-policy";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  MessageContentBlock,
  ProviderContinuationContentBlock,
  ProviderContinuationIssuer,
  ThinkingOutputBlock,
} from "./types";
import { isProviderContinuationFor, LlmAbortError, normalizeLlmAbortError } from "./types";

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

function toAnthropicContinuation(
  block: ProviderContinuationContentBlock,
  issuer: ProviderContinuationIssuer,
): ThinkingBlockParam | RedactedThinkingBlockParam | undefined {
  if (!isProviderContinuationFor(block, issuer)) {
    return undefined;
  }
  if (!block.data || typeof block.data !== "object") {
    return undefined;
  }

  const data = block.data as Record<string, unknown>;
  if (
    data.type === "thinking" &&
    typeof data.thinking === "string" &&
    typeof data.signature === "string"
  ) {
    return {
      type: "thinking",
      thinking: data.thinking,
      signature: data.signature,
    };
  }
  if (data.type === "redacted_thinking" && typeof data.data === "string") {
    return {
      type: "redacted_thinking",
      data: data.data,
    };
  }
  return undefined;
}

function toAnthropicBlock(
  block: MessageContentBlock,
  issuer: ProviderContinuationIssuer,
): ContentBlockParam | undefined {
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
    case "provider_continuation":
      return toAnthropicContinuation(block, issuer);
  }
}

function toAnthropicMessages(
  messages: ConversationMessage[],
  issuer: ProviderContinuationIssuer,
): MessageParam[] {
  return messages.flatMap((message) => {
    const content = message.content.flatMap((block) => {
      const converted = toAnthropicBlock(block, issuer);
      return converted ? [converted] : [];
    });
    return content.length > 0 ? [{ role: message.role, content }] : [];
  });
}

function normalizeAssistantContent(
  content: ContentBlock[],
  issuer: ProviderContinuationIssuer,
): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];

  for (const block of content) {
    if (block.type === "thinking" && typeof block.signature === "string") {
      blocks.push({
        type: "provider_continuation",
        purpose: "reasoning",
        issuer,
        data: {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        } satisfies ThinkingBlockParam,
      });
      continue;
    }

    if (block.type === "redacted_thinking") {
      blocks.push({
        type: "provider_continuation",
        purpose: "reasoning",
        issuer,
        data: {
          type: "redacted_thinking",
          data: block.data,
        } satisfies RedactedThinkingBlockParam,
      });
      continue;
    }

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
  providerId: string,
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
        provider: providerId,
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
  private providerId: string;
  private thinking?: EffectiveThinkingConfig;
  private issuer: ProviderContinuationIssuer;

  constructor(options: {
    apiKey: string;
    model: string;
    providerId?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    thinking?: EffectiveThinkingConfig;
    client?: AnthropicClient;
  }) {
    this.client =
      options.client ??
      (new Anthropic({
        apiKey: options.apiKey,
        authToken: null,
        baseURL: options.baseUrl ?? "https://api.anthropic.com",
        defaultHeaders: options.headers,
        fetch: rejectRedirectFetch,
        // Sloppy owns bounded retries so SDK retries cannot stack underneath it.
        maxRetries: 0,
      }) as AnthropicClient);
    this.model = options.model;
    this.providerId = options.providerId ?? "anthropic";
    this.thinking = options.thinking;
    this.issuer = createProviderContinuationIssuer({
      protocol: "anthropic-messages",
      provider: this.providerId,
      model: this.model,
      baseUrl: options.baseUrl ?? "https://api.anthropic.com",
      credentialIdentity: options.apiKey,
      headers: options.headers,
    });
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
      throw normalizeLlmAbortError(error, options?.signal);
    }
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      system: options.system,
      messages: toAnthropicMessages(options.messages, this.issuer),
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
            provider: this.providerId,
            model: this.model,
            format: "summary",
            display: this.thinking?.display ?? "visible",
            delta,
            startedAt: thinkingStartedAt,
          });
        });
      }

      const finalMessage = await stream.finalMessage();
      const thinking = normalizeThinkingContent(
        finalMessage.content,
        this.thinking,
        this.model,
        this.providerId,
      );
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
        content: normalizeAssistantContent(finalMessage.content, this.issuer),
        thinking,
        stopReason,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      } satisfies LlmResponse;
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    } finally {
      options.signal?.removeEventListener("abort", abortStream);
    }
  }
}

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { LlmTool } from "@slop-ai/consumer/browser";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  MessageContentBlock,
} from "./types";
import { LlmAbortError, normalizeLlmAbortError } from "./types";

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

export class AnthropicAdapter implements LlmAdapter {
  private client: Anthropic;
  private model: string;

  constructor(options: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
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

      const finalMessage = await stream.finalMessage();
      const stopReason =
        finalMessage.stop_reason === "tool_use"
          ? "tool_use"
          : finalMessage.stop_reason === "max_tokens"
            ? "max_tokens"
            : "end_turn";

      return {
        content: normalizeAssistantContent(finalMessage.content),
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

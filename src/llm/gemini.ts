import type { Content, FunctionCall, GenerateContentResponse, Tool } from "@google/genai";
import {
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromText,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
} from "@google/genai";
import type { LlmTool } from "@slop-ai/consumer/browser";
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
import { LlmAbortError, normalizeLlmAbortError } from "./types";

interface GeminiClient {
  models: {
    countTokens?(parameters: Record<string, unknown>): Promise<{ totalTokens?: number }>;
    generateContent(parameters: Record<string, unknown>): Promise<GenerateContentResponse>;
    generateContentStream(
      parameters: Record<string, unknown>,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

export interface GeminiStreamState {
  text: string;
  thinkingText: string;
  thinkingStartedAt?: string;
  thinkingStartedMs?: number;
  functionCalls: FunctionCall[];
  finishReason?: FinishReason;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}

function parseToolResultValue(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function createFunctionCallPart(block: ToolUseContentBlock) {
  const part = createPartFromFunctionCall(block.name, block.input);
  if (part.functionCall) {
    part.functionCall.id = block.id;
  }
  return part;
}

function createFunctionResponsePart(
  block: ToolResultContentBlock,
  toolUseNames: Map<string, string>,
) {
  const toolName = toolUseNames.get(block.toolUseId) ?? "unknown_tool";
  const response = block.isError
    ? { error: parseToolResultValue(block.content) }
    : { output: parseToolResultValue(block.content) };
  return createPartFromFunctionResponse(block.toolUseId, toolName, response);
}

function toGeminiTools(tools: LlmTool[]): Tool[] {
  if (tools.length === 0) {
    return [];
  }

  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parametersJsonSchema: tool.function.parameters,
      })),
    },
  ];
}

function toGeminiContents(messages: ConversationMessage[]): Content[] {
  const contents: Content[] = [];
  const toolUseNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = message.content.flatMap((block) => {
        if (block.type === "text") {
          return [createPartFromText(block.text)];
        }

        if (block.type === "tool_use") {
          toolUseNames.set(block.id, block.name);
          return [createFunctionCallPart(block)];
        }

        return [];
      });

      contents.push({ role: "model", parts });
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is ToolResultContentBlock => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      contents.push({
        role: "user",
        parts: toolResults.map((block) => createFunctionResponsePart(block, toolUseNames)),
      });
      continue;
    }

    contents.push({
      role: "user",
      parts: message.content.flatMap((block) => {
        if (block.type === "text") {
          return [createPartFromText(block.text)];
        }
        if (block.type === "image") {
          return [{ inlineData: { mimeType: block.mediaType, data: block.data } }];
        }
        return [];
      }),
    });
  }

  return contents;
}

function extractGeminiText(response: GenerateContentResponse): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text ?? "")
    .join("");
}

function extractGeminiThinkingText(response: GenerateContentResponse): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => typeof part.text === "string" && part.thought === true)
    .map((part) => part.text ?? "")
    .join("");
}

function extractGeminiFunctionCalls(response: GenerateContentResponse): FunctionCall[] {
  return (response.candidates?.[0]?.content?.parts ?? []).flatMap((part) =>
    part.functionCall ? [part.functionCall] : [],
  );
}

function buildAssistantContent(
  text: string,
  functionCalls: FunctionCall[],
): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  functionCalls.forEach((functionCall, index) => {
    blocks.push({
      type: "tool_use",
      id: functionCall.id ?? `gemini-call-${index}`,
      name: functionCall.name ?? "unknown_tool",
      input: functionCall.args ?? {},
    });
  });

  return blocks;
}

function normalizeFinishReason(
  finishReason: FinishReason | undefined,
  functionCalls: FunctionCall[],
): LlmResponse["stopReason"] {
  if (functionCalls.length > 0) {
    return "tool_use";
  }

  if (finishReason === FinishReason.MAX_TOKENS) {
    return "max_tokens";
  }

  return "end_turn";
}

function normalizeGeminiResponse(
  response: GenerateContentResponse,
  thinking?: EffectiveThinkingConfig,
  model?: string,
): LlmResponse {
  const text = extractGeminiText(response);
  const thinkingText = extractGeminiThinkingText(response);
  const functionCalls = extractGeminiFunctionCalls(response);
  const finishReason = response.candidates?.[0]?.finishReason;

  return {
    content: buildAssistantContent(text, functionCalls),
    thinking:
      thinkingText.length > 0
        ? [
            {
              type: "thinking",
              id: "gemini-thinking-0",
              provider: "gemini",
              model,
              format: "raw",
              display: thinking?.display ?? "visible",
              text: thinkingText,
              tokenCount: response.usageMetadata?.thoughtsTokenCount,
              tokenCountSource:
                response.usageMetadata?.thoughtsTokenCount === undefined
                  ? "unavailable"
                  : "reported",
            },
          ]
        : undefined,
    stopReason: normalizeFinishReason(finishReason, functionCalls),
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      thinkingTokens: response.usageMetadata?.thoughtsTokenCount,
    },
  } satisfies LlmResponse;
}

function createGeminiStreamState(): GeminiStreamState {
  return {
    text: "",
    thinkingText: "",
    functionCalls: [],
  };
}

function functionCallKey(functionCall: FunctionCall, index: number): string {
  if (functionCall.id) {
    return functionCall.id;
  }

  return `${index}:${functionCall.name ?? "unknown_tool"}:${JSON.stringify(functionCall.args ?? {})}`;
}

function accumulateGeminiStreamChunk(
  state: GeminiStreamState,
  chunk: GenerateContentResponse,
): GeminiStreamState {
  const text = extractGeminiText(chunk);
  if (text.length > 0) {
    state.text += text;
  }
  const thinkingText = extractGeminiThinkingText(chunk);
  if (thinkingText.length > 0) {
    if (!state.thinkingStartedAt) {
      state.thinkingStartedAt = new Date().toISOString();
      state.thinkingStartedMs = Date.now();
    }
    state.thinkingText += thinkingText;
  }

  const existingByKey = new Map(
    state.functionCalls.map((functionCall, index) => [functionCallKey(functionCall, index), index]),
  );
  for (const [index, functionCall] of extractGeminiFunctionCalls(chunk).entries()) {
    const key = functionCallKey(functionCall, index);
    const existingIndex = existingByKey.get(key);
    if (existingIndex == null) {
      state.functionCalls.push(functionCall);
      continue;
    }

    state.functionCalls[existingIndex] = functionCall;
  }

  const finishReason = chunk.candidates?.[0]?.finishReason;
  if (finishReason) {
    state.finishReason = finishReason;
  }

  if (chunk.usageMetadata?.promptTokenCount != null) {
    state.inputTokens = chunk.usageMetadata.promptTokenCount;
  }
  if (chunk.usageMetadata?.candidatesTokenCount != null) {
    state.outputTokens = chunk.usageMetadata.candidatesTokenCount;
  }
  if (chunk.usageMetadata?.thoughtsTokenCount != null) {
    state.thinkingTokens = chunk.usageMetadata.thoughtsTokenCount;
  }

  return state;
}

function streamStateToLlmResponse(
  state: GeminiStreamState,
  thinking?: EffectiveThinkingConfig,
  model?: string,
): LlmResponse {
  return {
    content: buildAssistantContent(state.text, state.functionCalls),
    thinking:
      state.thinkingText.length > 0
        ? [
            {
              type: "thinking",
              id: "gemini-thinking-0",
              provider: "gemini",
              model,
              format: "raw",
              display: thinking?.display ?? "visible",
              text: state.thinkingText,
              startedAt: state.thinkingStartedAt,
              completedAt: new Date().toISOString(),
              elapsedMs: state.thinkingStartedMs ? Date.now() - state.thinkingStartedMs : undefined,
              tokenCount: state.thinkingTokens,
              tokenCountSource: state.thinkingTokens === undefined ? "unavailable" : "reported",
            },
          ]
        : undefined,
    stopReason: normalizeFinishReason(state.finishReason, state.functionCalls),
    usage: {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      thinkingTokens: state.thinkingTokens,
    },
  } satisfies LlmResponse;
}

function geminiThinkingConfig(
  thinking: EffectiveThinkingConfig | undefined,
  model: string,
): Record<string, unknown> | undefined {
  if (!thinking) {
    return undefined;
  }
  if (!thinking.effectiveEnabled) {
    return { thinkingBudget: 0 };
  }
  const provider = thinking.gemini;
  const useThinkingLevel = model.toLowerCase().startsWith("gemini-3");
  return {
    includeThoughts: provider?.includeThoughts ?? true,
    thinkingBudget: useThinkingLevel ? provider?.thinkingBudget : (provider?.thinkingBudget ?? -1),
    thinkingLevel: useThinkingLevel
      ? (provider?.thinkingLevel ?? "medium")
      : provider?.thinkingLevel,
    ...(provider?.options ?? {}),
  };
}

function buildGeminiRequest(
  options: LlmChatOptions,
  model: string,
  thinking?: EffectiveThinkingConfig,
): Record<string, unknown> {
  const tools = options.tools?.length ? toGeminiTools(options.tools) : undefined;
  const thinkingConfig = geminiThinkingConfig(thinking, model);

  return {
    model,
    contents: toGeminiContents(options.messages),
    config: {
      abortSignal: options.signal,
      systemInstruction: options.system,
      maxOutputTokens: options.maxTokens,
      thinkingConfig,
      tools,
      toolConfig: tools
        ? {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO,
            },
          }
        : undefined,
      automaticFunctionCalling: {
        disable: true,
      },
    },
  };
}

export class GeminiAdapter implements LlmAdapter {
  private client: GeminiClient;
  private model: string;
  private thinking?: EffectiveThinkingConfig;

  constructor(options: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    thinking?: EffectiveThinkingConfig;
    client?: GeminiClient;
  }) {
    this.client =
      options.client ??
      (new GoogleGenAI({
        apiKey: options.apiKey,
        httpOptions: options.baseUrl
          ? {
              baseUrl: options.baseUrl,
            }
          : undefined,
      }) as unknown as GeminiClient);
    this.model = options.model;
    this.thinking = options.thinking;
  }

  async countTextTokens(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount> {
    if (options?.signal?.aborted) {
      throw new LlmAbortError();
    }

    if (!this.client.models.countTokens) {
      return { source: "unavailable" };
    }

    try {
      const response = await this.client.models.countTokens({
        model: this.model,
        contents: toGeminiContents([{ role: "user", content: [{ type: "text", text }] }]),
        config: {
          abortSignal: options?.signal,
        },
      });
      return response.totalTokens === undefined
        ? { source: "unavailable" }
        : { tokens: response.totalTokens, source: "provider" };
    } catch (error) {
      throw normalizeLlmAbortError(error, options?.signal);
    }
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const parameters = buildGeminiRequest(options, this.model, this.thinking);
    try {
      if (!options.onText) {
        const response = await this.client.models.generateContent(parameters);
        const normalized = normalizeGeminiResponse(response, this.thinking, this.model);
        if (options.onThinking) {
          emitGeminiThinkingBlocks(
            normalized.thinking,
            options.onThinking,
            this.thinking,
            this.model,
          );
        }
        return normalized;
      }

      const stream = await this.client.models.generateContentStream(parameters);
      const state = createGeminiStreamState();
      for await (const chunk of stream) {
        const delta = extractGeminiText(chunk);
        if (delta.length > 0) {
          options.onText(delta);
        }
        const thinkingDelta = extractGeminiThinkingText(chunk);
        if (thinkingDelta.length > 0) {
          const startedAt = state.thinkingStartedAt ?? new Date().toISOString();
          options.onThinking?.({
            id: "gemini-thinking-0",
            provider: "gemini",
            model: this.model,
            format: "raw",
            display: this.thinking?.display ?? "visible",
            delta: thinkingDelta,
            startedAt,
          });
        }
        accumulateGeminiStreamChunk(state, chunk);
      }

      const response = streamStateToLlmResponse(state, this.thinking, this.model);
      const thinking = response.thinking?.[0];
      if (thinking && options.onThinking) {
        options.onThinking({
          id: thinking.id,
          provider: thinking.provider,
          model: this.model,
          format: thinking.format,
          display: this.thinking?.display ?? "visible",
          delta: "",
          startedAt: thinking.startedAt,
          completedAt: thinking.completedAt,
          elapsedMs: thinking.elapsedMs,
          tokenCount: thinking.tokenCount,
          tokenCountSource: thinking.tokenCountSource,
          done: true,
        });
      }
      return response;
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    }
  }
}

function emitGeminiThinkingBlocks(
  blocks: ThinkingOutputBlock[] | undefined,
  onThinking: NonNullable<LlmChatOptions["onThinking"]>,
  thinking: EffectiveThinkingConfig | undefined,
  model: string,
): void {
  for (const block of blocks ?? []) {
    onThinking({
      id: block.id,
      provider: block.provider,
      model,
      format: block.format,
      display: thinking?.display ?? block.display,
      delta: block.text,
      startedAt: block.startedAt ?? new Date().toISOString(),
      tokenCount: block.tokenCount,
      tokenCountSource: block.tokenCountSource,
      done: true,
    });
  }
}

export {
  accumulateGeminiStreamChunk,
  buildAssistantContent as buildGeminiAssistantContent,
  buildGeminiRequest,
  createGeminiStreamState,
  normalizeGeminiResponse,
  streamStateToLlmResponse,
  toGeminiContents,
  toGeminiTools,
};

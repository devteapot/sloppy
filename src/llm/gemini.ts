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

interface GeminiClient {
  models: {
    generateContent(parameters: Record<string, unknown>): Promise<GenerateContentResponse>;
    generateContentStream(
      parameters: Record<string, unknown>,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

export interface GeminiStreamState {
  text: string;
  functionCalls: FunctionCall[];
  finishReason?: FinishReason;
  inputTokens: number;
  outputTokens: number;
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
      parts: message.content
        .filter(
          (block): block is Extract<ConversationMessage["content"][number], { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => createPartFromText(block.text)),
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

function normalizeGeminiResponse(response: GenerateContentResponse): LlmResponse {
  const text = extractGeminiText(response);
  const functionCalls = extractGeminiFunctionCalls(response);
  const finishReason = response.candidates?.[0]?.finishReason;

  return {
    content: buildAssistantContent(text, functionCalls),
    stopReason: normalizeFinishReason(finishReason, functionCalls),
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  } satisfies LlmResponse;
}

function createGeminiStreamState(): GeminiStreamState {
  return {
    text: "",
    functionCalls: [],
    inputTokens: 0,
    outputTokens: 0,
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

  return state;
}

function streamStateToLlmResponse(state: GeminiStreamState): LlmResponse {
  return {
    content: buildAssistantContent(state.text, state.functionCalls),
    stopReason: normalizeFinishReason(state.finishReason, state.functionCalls),
    usage: {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    },
  } satisfies LlmResponse;
}

function buildGeminiRequest(options: LlmChatOptions, model: string): Record<string, unknown> {
  const tools = options.tools?.length ? toGeminiTools(options.tools) : undefined;

  return {
    model,
    contents: toGeminiContents(options.messages),
    config: {
      abortSignal: options.signal,
      systemInstruction: options.system,
      maxOutputTokens: options.maxTokens,
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

  constructor(options: {
    apiKey: string;
    model: string;
    baseUrl?: string;
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
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const parameters = buildGeminiRequest(options, this.model);
    try {
      if (!options.onText) {
        const response = await this.client.models.generateContent(parameters);
        return normalizeGeminiResponse(response);
      }

      const stream = await this.client.models.generateContentStream(parameters);
      const state = createGeminiStreamState();
      for await (const chunk of stream) {
        const delta = extractGeminiText(chunk);
        if (delta.length > 0) {
          options.onText(delta);
        }
        accumulateGeminiStreamChunk(state, chunk);
      }

      return streamStateToLlmResponse(state);
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    }
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

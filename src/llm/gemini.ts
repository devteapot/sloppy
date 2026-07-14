import type { Content, FunctionCall, GenerateContentResponse, Part, Tool } from "@google/genai";
import {
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromText,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
} from "@google/genai";
import type { LlmTool } from "@slop-ai/consumer/browser";
import { createProviderContinuationIssuer } from "./continuation";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  ProviderContinuationContentBlock,
  ProviderContinuationIssuer,
  ThinkingOutputBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types";
import { isProviderContinuationFor, LlmAbortError, normalizeLlmAbortError } from "./types";

interface GeminiClient {
  models: {
    countTokens?(parameters: Record<string, unknown>): Promise<{ totalTokens?: number }>;
    generateContent(parameters: Record<string, unknown>): Promise<GenerateContentResponse>;
    generateContentStream(
      parameters: Record<string, unknown>,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

interface GeminiInternalApiClient {
  apiCall(url: string, requestInit: RequestInit): Promise<Response>;
}

function rejectGeminiRedirects(client: GoogleGenAI): void {
  // @google/genai does not currently expose a fetch hook or redirect option.
  // Its model APIs all pass through this transport method, so pin the SDK
  // version with tests and force Fetch's redirect policy at the last boundary
  // before credentials are sent.
  const apiClient = (client as unknown as { apiClient?: GeminiInternalApiClient }).apiClient;
  if (!apiClient?.apiCall) {
    throw new Error("The Gemini SDK transport does not expose its expected request boundary.");
  }
  const apiCall = apiClient.apiCall.bind(apiClient);
  apiClient.apiCall = (url, requestInit) =>
    apiCall(url, {
      ...requestInit,
      redirect: "error",
    });
}

function createGeminiClient(options: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): GeminiClient {
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      baseUrl: options.baseUrl ?? "https://generativelanguage.googleapis.com",
      headers: options.headers,
    },
  });
  rejectGeminiRedirects(client);
  return client as unknown as GeminiClient;
}

export interface GeminiStreamState {
  text: string;
  thinkingText: string;
  thinkingStartedAt?: string;
  thinkingStartedMs?: number;
  assistantParts: Part[];
  finishReason?: FinishReason;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}

type GeminiPortableCompanion =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "tool_call";
      toolUseId: string;
    };

type GeminiContinuationData =
  | {
      kind: "part";
      part: Part;
      companion?: GeminiPortableCompanion;
    }
  | {
      kind: "function_call";
      id: string;
      thoughtSignature: string;
    }
  | {
      kind: "thought";
      text: string;
      thoughtSignature: string;
    };

function geminiIssuer(
  model: string,
  providerId: string,
  scope = "unspecified",
): ProviderContinuationIssuer {
  return {
    protocol: "gemini",
    provider: providerId,
    model,
    scope,
  };
}

function parseGeminiContinuation(
  block: ProviderContinuationContentBlock,
  model: string,
  providerId: string,
  continuationScope = "unspecified",
): GeminiContinuationData | undefined {
  if (!isProviderContinuationFor(block, geminiIssuer(model, providerId, continuationScope))) {
    return undefined;
  }
  if (!block.data || typeof block.data !== "object") {
    return undefined;
  }
  const data = block.data as Record<string, unknown>;
  if (data.kind === "part" && data.part && typeof data.part === "object") {
    const part = data.part as Record<string, unknown>;
    const functionCall = part.functionCall;
    const hasValidText = typeof part.text === "string";
    const hasValidFunctionCall =
      functionCall !== null &&
      typeof functionCall === "object" &&
      typeof (functionCall as Record<string, unknown>).name === "string";
    if (typeof part.thoughtSignature !== "string" || (!hasValidText && !hasValidFunctionCall)) {
      return undefined;
    }

    let companion: GeminiPortableCompanion | undefined;
    if (data.companion !== undefined) {
      if (!data.companion || typeof data.companion !== "object") {
        return undefined;
      }
      const candidate = data.companion as Record<string, unknown>;
      if (candidate.kind === "text" && typeof candidate.text === "string") {
        companion = { kind: "text", text: candidate.text };
      } else if (candidate.kind === "tool_call" && typeof candidate.toolUseId === "string") {
        companion = { kind: "tool_call", toolUseId: candidate.toolUseId };
      } else {
        return undefined;
      }
    }

    return {
      kind: "part",
      part: data.part as Part,
      companion,
    };
  }
  if (
    data.kind === "function_call" &&
    typeof data.id === "string" &&
    typeof data.thoughtSignature === "string"
  ) {
    return {
      kind: "function_call",
      id: data.id,
      thoughtSignature: data.thoughtSignature,
    };
  }
  if (
    data.kind === "thought" &&
    typeof data.text === "string" &&
    typeof data.thoughtSignature === "string"
  ) {
    return {
      kind: "thought",
      text: data.text,
      thoughtSignature: data.thoughtSignature,
    };
  }
  return undefined;
}

function geminiContinuationBlock(
  model: string,
  providerId: string,
  data: GeminiContinuationData,
  continuationScope = "unspecified",
): ProviderContinuationContentBlock {
  const purpose =
    data.kind === "function_call" || (data.kind === "part" && data.companion?.kind === "tool_call")
      ? "tool_call"
      : data.kind === "part" && data.part.thought !== true
        ? "assistant_message"
        : "reasoning";
  return {
    type: "provider_continuation",
    purpose,
    issuer: geminiIssuer(model, providerId, continuationScope),
    data,
  };
}

function parseToolResultValue(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function createFunctionCallPart(block: ToolUseContentBlock, thoughtSignature?: string) {
  const part = createPartFromFunctionCall(block.name, block.input);
  if (part.functionCall) {
    part.functionCall.id = block.id;
  }
  if (thoughtSignature) {
    part.thoughtSignature = thoughtSignature;
  }
  return part;
}

function createFunctionResponsePart(
  block: ToolResultContentBlock,
  toolUses: Map<string, { name: string; responseId: string | undefined }>,
) {
  const toolUse = toolUses.get(block.toolUseId);
  const toolName = toolUse?.name ?? "unknown_tool";
  const response = block.isError
    ? { error: parseToolResultValue(block.content) }
    : { output: parseToolResultValue(block.content) };
  const part = createPartFromFunctionResponse(
    toolUse?.responseId ?? block.toolUseId,
    toolName,
    response,
  );
  if (toolUse && toolUse.responseId === undefined && part.functionResponse) {
    delete part.functionResponse.id;
  }
  return part;
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

function toGeminiContents(
  messages: ConversationMessage[],
  model?: string,
  providerId = "gemini",
  continuationScope = "unspecified",
): Content[] {
  const contents: Content[] = [];
  const toolUses = new Map<string, { name: string; responseId: string | undefined }>();

  for (const message of messages) {
    if (message.role === "assistant") {
      const functionCallSignatures = new Map<string, string>();
      if (model) {
        for (const block of message.content) {
          if (block.type !== "provider_continuation") {
            continue;
          }
          const continuation = parseGeminiContinuation(block, model, providerId, continuationScope);
          if (continuation?.kind === "function_call") {
            functionCallSignatures.set(continuation.id, continuation.thoughtSignature);
          }
        }
      }
      const parts: Part[] = [];
      let pendingCompanion: GeminiPortableCompanion | undefined;

      for (const block of message.content) {
        if (block.type === "provider_continuation" && model) {
          const continuation = parseGeminiContinuation(block, model, providerId, continuationScope);
          if (continuation?.kind === "part") {
            parts.push(continuation.part);
            pendingCompanion = continuation.companion;
            continue;
          }
          if (continuation?.kind === "thought") {
            parts.push({
              thought: true,
              text: continuation.text,
              thoughtSignature: continuation.thoughtSignature,
            });
          }
          continue;
        }

        if (block.type === "text") {
          if (pendingCompanion?.kind === "text" && pendingCompanion.text === block.text) {
            pendingCompanion = undefined;
            continue;
          }
          pendingCompanion = undefined;
          parts.push(createPartFromText(block.text));
          continue;
        }

        if (block.type === "tool_use") {
          if (pendingCompanion?.kind === "tool_call" && pendingCompanion.toolUseId === block.id) {
            const rawPart = parts.at(-1);
            toolUses.set(block.id, {
              name: block.name,
              responseId: rawPart?.functionCall?.id,
            });
            pendingCompanion = undefined;
            continue;
          }
          pendingCompanion = undefined;
          toolUses.set(block.id, { name: block.name, responseId: block.id });
          parts.push(createFunctionCallPart(block, functionCallSignatures.get(block.id)));
          continue;
        }

        pendingCompanion = undefined;
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is ToolResultContentBlock => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      contents.push({
        role: "user",
        parts: toolResults.map((block) => createFunctionResponsePart(block, toolUses)),
      });
      continue;
    }

    const parts = message.content.flatMap((block) => {
      if (block.type === "text") {
        return [createPartFromText(block.text)];
      }
      if (block.type === "image") {
        return [{ inlineData: { mimeType: block.mediaType, data: block.data } }];
      }
      return [];
    });
    if (parts.length > 0) {
      contents.push({ role: "user", parts });
    }
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
  model?: string,
  providerId = "gemini",
  functionCallSignatures: ReadonlyMap<string, string> = new Map(),
  thoughtContinuations: ReadonlyArray<{ text: string; thoughtSignature: string }> = [],
  continuationScope = "unspecified",
): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  if (model) {
    for (const continuation of thoughtContinuations) {
      blocks.push(
        geminiContinuationBlock(
          model,
          providerId,
          {
            kind: "thought",
            ...continuation,
          },
          continuationScope,
        ),
      );
    }
  }
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  functionCalls.forEach((functionCall, index) => {
    const id = functionCall.id ?? `gemini-call-${index}`;
    const thoughtSignature = functionCallSignatures.get(id);
    if (model && thoughtSignature) {
      blocks.push(
        geminiContinuationBlock(
          model,
          providerId,
          {
            kind: "function_call",
            id,
            thoughtSignature,
          },
          continuationScope,
        ),
      );
    }
    blocks.push({
      type: "tool_use",
      id,
      name: functionCall.name ?? "unknown_tool",
      input: functionCall.args ?? {},
    });
  });

  return blocks;
}

function buildAssistantContentFromParts(
  parts: Part[],
  model?: string,
  providerId = "gemini",
  continuationScope = "unspecified",
): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  let functionCallIndex = 0;
  let canMergeText = false;

  for (const part of parts) {
    if (part.thought === true) {
      if (model && typeof part.thoughtSignature === "string") {
        blocks.push(
          geminiContinuationBlock(
            model,
            providerId,
            {
              kind: "part",
              part,
            },
            continuationScope,
          ),
        );
      }
      canMergeText = false;
      continue;
    }

    if (part.functionCall) {
      const id = part.functionCall.id ?? `gemini-call-${functionCallIndex}`;
      functionCallIndex += 1;
      if (model && typeof part.thoughtSignature === "string") {
        blocks.push(
          geminiContinuationBlock(
            model,
            providerId,
            {
              kind: "part",
              part,
              companion: { kind: "tool_call", toolUseId: id },
            },
            continuationScope,
          ),
        );
      }
      blocks.push({
        type: "tool_use",
        id,
        name: part.functionCall.name ?? "unknown_tool",
        input: part.functionCall.args ?? {},
      });
      canMergeText = false;
      continue;
    }

    if (typeof part.text === "string") {
      if (model && typeof part.thoughtSignature === "string") {
        blocks.push(
          geminiContinuationBlock(
            model,
            providerId,
            {
              kind: "part",
              part,
              companion: part.text.length > 0 ? { kind: "text", text: part.text } : undefined,
            },
            continuationScope,
          ),
        );
        if (part.text.length > 0) {
          blocks.push({ type: "text", text: part.text });
        }
        canMergeText = false;
        continue;
      }

      if (part.text.length > 0) {
        const previous = blocks.at(-1);
        if (canMergeText && previous?.type === "text") {
          previous.text += part.text;
        } else {
          blocks.push({ type: "text", text: part.text });
        }
        canMergeText = true;
      }
    }
  }

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
  providerId = "gemini",
  continuationScope = "unspecified",
): LlmResponse {
  const thinkingText = extractGeminiThinkingText(response);
  const functionCalls = extractGeminiFunctionCalls(response);
  const finishReason = response.candidates?.[0]?.finishReason;
  const parts = response.candidates?.[0]?.content?.parts ?? [];

  return {
    content: buildAssistantContentFromParts(parts, model, providerId, continuationScope),
    thinking:
      thinkingText.length > 0
        ? [
            {
              type: "thinking",
              id: "gemini-thinking-0",
              provider: providerId,
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
    assistantParts: [],
  };
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

  for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
    if (!part.functionCall) {
      state.assistantParts.push(part);
      continue;
    }

    if (part.functionCall.id) {
      const existingIndex = state.assistantParts.findIndex(
        (candidate) => candidate.functionCall?.id === part.functionCall?.id,
      );
      if (existingIndex >= 0) {
        state.assistantParts[existingIndex] = part;
      } else {
        state.assistantParts.push(part);
      }
      continue;
    }
    state.assistantParts.push(part);
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
  providerId = "gemini",
  continuationScope = "unspecified",
): LlmResponse {
  const functionCalls = state.assistantParts.flatMap((part) =>
    part.functionCall ? [part.functionCall] : [],
  );
  return {
    content: buildAssistantContentFromParts(
      state.assistantParts,
      model,
      providerId,
      continuationScope,
    ),
    thinking:
      state.thinkingText.length > 0
        ? [
            {
              type: "thinking",
              id: "gemini-thinking-0",
              provider: providerId,
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
    stopReason: normalizeFinishReason(state.finishReason, functionCalls),
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
  providerId = "gemini",
  continuationScope = "unspecified",
): Record<string, unknown> {
  const tools = options.tools?.length ? toGeminiTools(options.tools) : undefined;
  const thinkingConfig = geminiThinkingConfig(thinking, model);

  return {
    model,
    contents: toGeminiContents(options.messages, model, providerId, continuationScope),
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
  private providerId: string;
  private thinking?: EffectiveThinkingConfig;
  private continuationScope: string;

  constructor(options: {
    apiKey: string;
    model: string;
    providerId?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    thinking?: EffectiveThinkingConfig;
    client?: GeminiClient;
  }) {
    this.client =
      options.client ??
      createGeminiClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        headers: options.headers,
      });
    this.model = options.model;
    this.providerId = options.providerId ?? "gemini";
    this.thinking = options.thinking;
    this.continuationScope = createProviderContinuationIssuer({
      protocol: "gemini",
      provider: this.providerId,
      model: this.model,
      baseUrl: options.baseUrl ?? "https://generativelanguage.googleapis.com",
      credentialIdentity: options.apiKey,
      headers: options.headers,
    }).scope;
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
        contents: toGeminiContents(
          [{ role: "user", content: [{ type: "text", text }] }],
          this.model,
          this.providerId,
          this.continuationScope,
        ),
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

    const parameters = buildGeminiRequest(
      options,
      this.model,
      this.thinking,
      this.providerId,
      this.continuationScope,
    );
    try {
      if (!options.onText) {
        const response = await this.client.models.generateContent(parameters);
        const normalized = normalizeGeminiResponse(
          response,
          this.thinking,
          this.model,
          this.providerId,
          this.continuationScope,
        );
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
        // The SDK receives the abort signal but its async iterator does not
        // reliably stop mid-stream; bail out between chunks ourselves.
        if (options.signal?.aborted) {
          throw new LlmAbortError();
        }
        const delta = extractGeminiText(chunk);
        if (delta.length > 0) {
          options.onText(delta);
        }
        const thinkingDelta = extractGeminiThinkingText(chunk);
        if (thinkingDelta.length > 0) {
          const startedAt = state.thinkingStartedAt ?? new Date().toISOString();
          options.onThinking?.({
            id: "gemini-thinking-0",
            provider: this.providerId,
            model: this.model,
            format: "raw",
            display: this.thinking?.display ?? "visible",
            delta: thinkingDelta,
            startedAt,
          });
        }
        accumulateGeminiStreamChunk(state, chunk);
      }

      const response = streamStateToLlmResponse(
        state,
        this.thinking,
        this.model,
        this.providerId,
        this.continuationScope,
      );
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

import type { LlmReasoningEffort } from "../config/schema";
import { createProviderContinuationIssuer } from "./continuation";
import type { FetchLike } from "./openai-codex-auth";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesUrl,
  normalizeOpenAIResponsesOutput,
  normalizeOpenAIResponsesStopReason,
  type OpenAIResponsesRequestBuildOptions,
} from "./openai-responses-protocol";
import {
  normalizeOpenAIResponsesThinking,
  parseOpenAIResponsesStreamingResponse,
  throwOpenAIResponsesResponseError,
} from "./openai-responses-stream";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  ProviderContinuationIssuer,
} from "./types";
import { LlmAbortError, normalizeLlmAbortError } from "./types";

export type {
  OpenAIResponse,
  OpenAIResponseFunctionCall,
  OpenAIResponseOutputItem,
  OpenAIResponseOutputMessage,
  OpenAIResponseReasoningItem,
  OpenAIResponsesInputContentPart,
  OpenAIResponsesRequest,
  OpenAIResponsesRequestBuildOptions,
  OpenAIResponsesRequestInputItem,
  OpenAIResponsesRequestTool,
} from "./openai-responses-protocol";
export {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesUrl,
  normalizeOpenAIResponsesOutput,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
} from "./openai-responses-protocol";

const DEFAULT_OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";

export type OpenAIResponsesTransportOptions = OpenAIResponsesRequestBuildOptions & {
  baseUrl: string;
  fetchFn?: FetchLike;
  getHeaders: (signal?: AbortSignal) => Headers | Promise<Headers>;
  getRequestContext?: (
    signal?: AbortSignal,
  ) =>
    | { headers: Headers; issuer: ProviderContinuationIssuer }
    | Promise<{ headers: Headers; issuer: ProviderContinuationIssuer }>;
  errorLabel: string;
  redirect?: RequestRedirect;
};

export type OpenAIResponsesAdapterOptions = {
  model: string;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: EffectiveThinkingConfig;
  fetchFn?: FetchLike;
};

function buildApiHeaders(apiKey?: string, configured?: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  return headers;
}

export class OpenAIResponsesTransport implements LlmAdapter {
  private readonly fetchFn: FetchLike;

  constructor(protected readonly config: OpenAIResponsesTransportOptions) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  protected async countResponseInputTokens(
    text: string,
    signal?: AbortSignal,
  ): Promise<LlmTokenCount> {
    if (signal?.aborted) {
      throw new LlmAbortError();
    }

    try {
      const context = await this.resolveRequestContext(signal);
      if (signal?.aborted) {
        throw new LlmAbortError();
      }
      const headers = new Headers(context.headers);
      headers.set("accept", "application/json");
      const response = await this.fetchFn(
        `${buildOpenAIResponsesUrl(this.config.baseUrl)}/input_tokens`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ model: this.config.model, input: text }),
          signal,
          redirect: this.config.redirect,
        },
      );
      if (!response.ok) {
        await throwOpenAIResponsesResponseError(response, this.config.errorLabel);
      }
      const payload = (await response.json()) as { input_tokens?: unknown };
      if (signal?.aborted) {
        throw new LlmAbortError();
      }
      return typeof payload.input_tokens === "number" && Number.isFinite(payload.input_tokens)
        ? { tokens: payload.input_tokens, source: "provider" }
        : { source: "unavailable" };
    } catch (error) {
      throw normalizeLlmAbortError(error, signal);
    }
  }

  private async resolveRequestContext(
    signal?: AbortSignal,
  ): Promise<{ headers: Headers; issuer: ProviderContinuationIssuer }> {
    return this.config.getRequestContext
      ? this.config.getRequestContext(signal)
      : { headers: await this.config.getHeaders(signal), issuer: this.config.issuer };
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    try {
      const context = await this.resolveRequestContext(options.signal);
      if (options.signal?.aborted) {
        throw new LlmAbortError();
      }
      const request = buildOpenAIResponsesRequest(options, {
        ...this.config,
        issuer: context.issuer,
      });
      const response = await this.fetchFn(buildOpenAIResponsesUrl(this.config.baseUrl), {
        method: "POST",
        headers: context.headers,
        body: JSON.stringify({ ...request, stream: true }),
        signal: options.signal,
        redirect: this.config.redirect,
      });
      if (!response.ok) {
        await throwOpenAIResponsesResponseError(response, this.config.errorLabel);
      }

      const streamed = await parseOpenAIResponsesStreamingResponse(response, {
        onText: options.onText,
        onThinking: options.onThinking,
        thinking: this.config.thinking,
        issuer: context.issuer,
        signal: options.signal,
        errorLabel: this.config.errorLabel,
      });
      if (streamed.response.incomplete_details?.reason === "content_filter") {
        throw new Error(
          `${this.config.errorLabel} response was incomplete because content was filtered.`,
        );
      }
      const content = normalizeOpenAIResponsesOutput(streamed.response, context.issuer, {
        text: streamed.text,
        output: streamed.output,
      });
      const thinking = normalizeOpenAIResponsesThinking(
        streamed,
        this.config.thinking,
        context.issuer,
        streamed.response.usage?.output_tokens_details?.reasoning_tokens,
      );
      if (thinking && options.onThinking && streamed.thinkingText) {
        const block = thinking[0];
        if (block) {
          options.onThinking({
            id: block.id,
            provider: block.provider,
            model: block.model,
            format: block.format,
            display: block.display,
            delta: "",
            startedAt: block.startedAt,
            completedAt: block.completedAt,
            elapsedMs: block.elapsedMs,
            tokenCount: block.tokenCount,
            tokenCountSource: block.tokenCountSource,
            done: true,
          });
        }
      }

      return {
        content,
        thinking,
        stopReason: normalizeOpenAIResponsesStopReason(streamed.response, content),
        usage: {
          inputTokens: streamed.response.usage?.input_tokens,
          outputTokens: streamed.response.usage?.output_tokens,
          thinkingTokens: streamed.response.usage?.output_tokens_details?.reasoning_tokens,
        },
      };
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    }
  }
}

export class OpenAIResponsesAdapter extends OpenAIResponsesTransport {
  constructor(options: OpenAIResponsesAdapterOptions) {
    const providerId = options.providerId ?? "openai";
    const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_RESPONSES_BASE_URL;
    super({
      model: options.model,
      issuer: createProviderContinuationIssuer({
        protocol: "openai-responses",
        provider: providerId,
        model: options.model,
        baseUrl,
        credentialIdentity: options.apiKey,
        headers: options.headers,
      }) satisfies ProviderContinuationIssuer,
      baseUrl,
      reasoningEffort: options.reasoningEffort,
      thinking: options.thinking,
      thinkingConfig: "openai",
      includeMaxOutputTokens: true,
      fetchFn: options.fetchFn,
      getHeaders: () => buildApiHeaders(options.apiKey, options.headers),
      errorLabel: "OpenAI Responses",
      redirect: "error",
    });
  }

  async countTextTokens(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount> {
    return this.countResponseInputTokens(text, options?.signal);
  }
}

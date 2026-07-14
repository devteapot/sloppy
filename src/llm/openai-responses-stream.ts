import type { OpenAIResponse, OpenAIResponseOutputItem } from "./openai-responses-protocol";
import type { EffectiveThinkingConfig } from "./thinking";
import type { LlmChatOptions, ProviderContinuationIssuer, ThinkingOutputBlock } from "./types";
import { LlmAbortError } from "./types";

type OpenAIResponseStreamEvent = {
  type?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  summary_index?: number;
  code?: string;
  message?: string;
  delta?: string;
  text?: string;
  item?: OpenAIResponseOutputItem;
  response?: OpenAIResponse & {
    error?: {
      message?: string;
      code?: string;
    };
  };
  error?: {
    message?: string;
    code?: string;
  };
};

type ResponseErrorPayload = {
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
  message?: string;
};

export async function throwOpenAIResponsesResponseError(
  response: Response,
  errorLabel: string,
): Promise<never> {
  let message = response.statusText || `HTTP ${response.status}`;
  let providerCode: string | undefined;
  try {
    const text = await response.text();
    if (text) {
      try {
        const data = JSON.parse(text) as ResponseErrorPayload;
        message = data.error?.message ?? data.message ?? text;
        providerCode = data.error?.code ?? data.error?.type;
      } catch {
        message = text;
      }
    }
  } catch {
    // best-effort error body extraction
  }

  const error = new Error(`${errorLabel} request failed: ${message}`) as Error & {
    status?: number;
    headers?: Headers;
    code?: string;
    requestId?: string;
  };
  error.status = response.status;
  error.headers = response.headers;
  error.code = providerCode;
  error.requestId =
    response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  throw error;
}

function eventError(event: OpenAIResponseStreamEvent, errorLabel: string): Error | null {
  if (event.type === "error") {
    return Object.assign(
      new Error(
        event.message ?? event.error?.message ?? `${errorLabel} stream returned an error event.`,
      ),
      { code: event.code ?? event.error?.code },
    );
  }
  if (event.type === "response.failed") {
    return Object.assign(
      new Error(event.response?.error?.message ?? `${errorLabel} stream returned response.failed.`),
      { code: event.response?.error?.code },
    );
  }
  return null;
}

function attachStreamResponseMetadata(error: Error, response: Response): Error {
  return Object.assign(error, {
    headers: response.headers,
    requestId:
      response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
  });
}

function parseSseEvent(raw: string): OpenAIResponseStreamEvent | null {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  return JSON.parse(data) as OpenAIResponseStreamEvent;
}

export type OpenAIResponsesStreamResult = {
  response: OpenAIResponse;
  text: string;
  output: OpenAIResponseOutputItem[];
  thinkingText: string;
  thinkingFormat: "raw" | "summary";
  thinkingStartedAt?: string;
  thinkingStartedMs?: number;
};

export async function parseOpenAIResponsesStreamingResponse(
  response: Response,
  config: {
    onText?: LlmChatOptions["onText"];
    onThinking?: LlmChatOptions["onThinking"];
    thinking?: EffectiveThinkingConfig;
    issuer: ProviderContinuationIssuer;
    signal?: AbortSignal;
    errorLabel: string;
  },
): Promise<OpenAIResponsesStreamResult> {
  if (!response.body) {
    throw new Error(`${config.errorLabel} streaming response did not include a body.`);
  }

  const reader = response.body.getReader();
  const cancelForAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  config.signal?.addEventListener("abort", cancelForAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let thinkingText = "";
  let thinkingFormat: "raw" | "summary" = "raw";
  let thinkingStartedAt: string | undefined;
  let thinkingStartedMs: number | undefined;
  let finalResponse: OpenAIResponse | null = null;
  let reachedEof = false;
  const output: OpenAIResponseOutputItem[] = [];
  const streamedTextByItem = new Map<string, string>();
  let unkeyedStreamedText = "";
  const streamedThinkingByItem = new Map<string, string>();
  const unkeyedStreamedThinking: Record<"raw" | "summary", string> = {
    raw: "",
    summary: "",
  };

  const textItemKey = (event: OpenAIResponseStreamEvent): string | undefined => {
    if (event.item_id) {
      return `${event.item_id}:${event.content_index ?? 0}`;
    }
    if (event.output_index !== undefined) {
      return `${event.output_index}:${event.content_index ?? 0}`;
    }
    return undefined;
  };

  const thinkingItemKey = (
    event: OpenAIResponseStreamEvent,
    format: "raw" | "summary",
  ): string | undefined => {
    const itemKey =
      event.item_id ?? (event.output_index === undefined ? undefined : String(event.output_index));
    if (!itemKey) {
      return undefined;
    }
    const contentIndex =
      format === "summary" ? (event.summary_index ?? 0) : (event.content_index ?? 0);
    return `${format}:${itemKey}:${contentIndex}`;
  };

  const emitThinkingDelta = (delta: string, format: "raw" | "summary") => {
    if (!delta) {
      return;
    }
    if (!thinkingStartedAt) {
      thinkingStartedAt = new Date().toISOString();
      thinkingStartedMs = Date.now();
    }
    thinkingFormat = format;
    thinkingText += delta;
    config.onThinking?.({
      id: `${config.issuer.provider}-thinking-0`,
      provider: config.issuer.provider,
      model: config.issuer.model,
      format,
      display: config.thinking?.display ?? "visible",
      delta,
      startedAt: thinkingStartedAt,
    });
  };

  const processRawEvent = (raw: string) => {
    const event = parseSseEvent(raw);
    if (!event) {
      return;
    }
    const error = eventError(event, config.errorLabel);
    if (error) {
      throw attachStreamResponseMetadata(error, response);
    }

    if (event.type === "response.output_text.delta" && event.delta) {
      const key = textItemKey(event);
      if (key) {
        streamedTextByItem.set(key, `${streamedTextByItem.get(key) ?? ""}${event.delta}`);
      } else {
        unkeyedStreamedText += event.delta;
      }
      streamedText += event.delta;
      config.onText?.(event.delta);
      return;
    }

    if (
      (event.type === "response.reasoning_text.delta" ||
        event.type === "response.reasoning_summary_text.delta") &&
      event.delta
    ) {
      const format = event.type === "response.reasoning_text.delta" ? "raw" : "summary";
      const key = thinkingItemKey(event, format);
      if (key) {
        streamedThinkingByItem.set(key, `${streamedThinkingByItem.get(key) ?? ""}${event.delta}`);
      } else {
        unkeyedStreamedThinking[format] += event.delta;
      }
      emitThinkingDelta(event.delta, format);
      return;
    }

    if (
      (event.type === "response.reasoning_text.done" ||
        event.type === "response.reasoning_summary_text.done") &&
      event.text
    ) {
      const format = event.type === "response.reasoning_text.done" ? "raw" : "summary";
      const key = thinkingItemKey(event, format);
      const accumulated = key
        ? (streamedThinkingByItem.get(key) ?? "")
        : unkeyedStreamedThinking[format];
      const recovered = event.text.startsWith(accumulated)
        ? event.text.slice(accumulated.length)
        : "";
      if (key) {
        streamedThinkingByItem.set(key, event.text);
      } else {
        unkeyedStreamedThinking[format] = event.text;
      }
      emitThinkingDelta(recovered, format);
      return;
    }

    if (event.type === "response.output_text.done" && event.text) {
      const key = textItemKey(event);
      const accumulated = key ? (streamedTextByItem.get(key) ?? "") : unkeyedStreamedText;
      const recovered = event.text.startsWith(accumulated)
        ? event.text.slice(accumulated.length)
        : "";
      if (key) {
        streamedTextByItem.set(key, event.text);
      } else {
        unkeyedStreamedText = event.text;
      }
      if (recovered) {
        streamedText += recovered;
        config.onText?.(recovered);
      }
      return;
    }

    if (event.type === "response.output_item.done" && event.item) {
      output.push(event.item);
      return;
    }

    if (
      (event.type === "response.completed" ||
        event.type === "response.done" ||
        event.type === "response.incomplete") &&
      event.response
    ) {
      finalResponse = event.response;
    }
  };

  try {
    readLoop: while (true) {
      if (config.signal?.aborted) {
        throw new LlmAbortError();
      }
      const { done, value } = await reader.read();
      if (config.signal?.aborted) {
        throw new LlmAbortError();
      }
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const separator = buffer.match(/\r?\n\r?\n/);
        const separatorLength = separator?.[0].length ?? 2;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        processRawEvent(raw);
        if (finalResponse) {
          break readLoop;
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (!finalResponse) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        processRawEvent(buffer);
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", cancelForAbort);
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (!finalResponse) {
    throw Object.assign(
      new Error(`${config.errorLabel} stream ended before a terminal response event.`),
      { code: "incomplete_stream" },
    );
  }

  return {
    response: finalResponse,
    text: streamedText,
    output,
    thinkingText,
    thinkingFormat,
    thinkingStartedAt,
    thinkingStartedMs,
  };
}

export function normalizeOpenAIResponsesThinking(
  streamed: OpenAIResponsesStreamResult,
  thinking: EffectiveThinkingConfig | undefined,
  issuer: ProviderContinuationIssuer,
  tokenCount: number | undefined,
): ThinkingOutputBlock[] | undefined {
  if (!streamed.thinkingText || !thinking?.effectiveEnabled) {
    return undefined;
  }
  const completedAt = new Date().toISOString();
  return [
    {
      type: "thinking",
      id: `${issuer.provider}-thinking-0`,
      provider: issuer.provider,
      model: issuer.model,
      format: streamed.thinkingFormat,
      display: thinking.display,
      text: streamed.thinkingText,
      startedAt: streamed.thinkingStartedAt,
      completedAt,
      elapsedMs: streamed.thinkingStartedMs ? Date.now() - streamed.thinkingStartedMs : undefined,
      tokenCount,
      tokenCountSource: tokenCount === undefined ? "unavailable" : "reported",
    },
  ];
}

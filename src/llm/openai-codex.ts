import type { LlmTool } from "@slop-ai/consumer/browser";

import type { LlmReasoningEffort } from "../config/schema";
import type { CodexCredentials, FetchLike } from "./openai-codex-auth";

export type { CodexAuthStatus } from "./openai-codex-auth";
export {
  getCodexAuthStatus,
  resolveCodexCredentials,
} from "./openai-codex-auth";

import { resolveCodexCredentials } from "./openai-codex-auth";
import type { EffectiveThinkingConfig } from "./thinking";
import type {
  AssistantContentBlock,
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  ThinkingOutputBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types";
import { LlmAbortError, normalizeLlmAbortError } from "./types";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

type CodexResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export type CodexResponseOutputItem =
  | {
      type: "message";
      content?: Array<
        { type: "output_text"; text?: string } | { type: "refusal"; refusal?: string }
      >;
      status?: string;
    }
  | {
      type: "function_call";
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      status?: string;
    };

export type CodexResponse = {
  id?: string;
  status?: string;
  output?: CodexResponseOutputItem[];
  usage?: CodexResponseUsage;
};

type CodexStreamEvent = {
  type?: string;
  delta?: string;
  text?: string;
  item?: CodexResponseOutputItem;
  response?: CodexResponse & {
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

export type CodexInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

export type CodexRequestInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: string | CodexInputContentPart[];
      phase?: "final_answer";
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

export type CodexRequestTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: false;
};

export type CodexRequest = {
  model: string;
  instructions: string;
  input: CodexRequestInputItem[];
  parallel_tool_calls: true;
  store: false;
  reasoning?: {
    effort: LlmReasoningEffort;
    summary?: "auto" | "concise" | "detailed";
  };
  tools?: CodexRequestTool[];
  tool_choice?: "auto";
  stream?: boolean;
};

export type OpenAICodexAdapterOptions = {
  model: string;
  baseUrl?: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: EffectiveThinkingConfig;
  authPath?: string;
  fetchFn?: FetchLike;
};

function parseToolArguments(
  argumentsJson: string,
): Pick<ToolUseContentBlock, "input" | "inputError"> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown> };
    }
    return { input: { value: parsed } };
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
}

function textFromMessage(message: ConversationMessage): string {
  return message.content
    .filter(
      (block): block is Extract<ConversationMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function toCodexInput(messages: ConversationMessage[]): CodexRequestInputItem[] {
  const input: CodexRequestInputItem[] = [];

  for (const message of messages) {
    const toolResults = message.content.filter(
      (block): block is ToolResultContentBlock => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        input.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
      }
      continue;
    }

    if (message.role === "user") {
      const parts: CodexInputContentPart[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.length > 0) {
          parts.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
          });
        }
      }
      if (parts.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content: parts.some((part) => part.type === "input_image")
            ? parts
            : parts.map((part) => (part.type === "input_text" ? part.text : "")).join(""),
        });
      }
      continue;
    }

    const text = textFromMessage(message);
    if (text.length > 0) {
      input.push({
        type: "message",
        role: message.role,
        content: text,
        phase: "final_answer",
      });
    }

    for (const block of message.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: "completed",
      });
    }
  }

  return input;
}

function toCodexTools(tools: LlmTool[]): CodexRequestTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));
}

function buildCodexRequest(
  options: LlmChatOptions,
  model: string,
  reasoningEffort?: LlmReasoningEffort,
  thinking?: EffectiveThinkingConfig,
): CodexRequest {
  const request: CodexRequest = {
    model,
    instructions: options.system,
    input: toCodexInput(options.messages),
    parallel_tool_calls: true,
    store: false,
  };

  if (thinking?.effectiveEnabled || reasoningEffort) {
    const summary = thinking
      ? (thinking.openaiCodex?.summary ?? thinking.openai?.summary ?? "auto")
      : "none";
    request.reasoning = {
      effort:
        thinking?.openaiCodex?.effort ?? thinking?.openai?.effort ?? reasoningEffort ?? "medium",
      ...(summary && summary !== "none" ? { summary } : {}),
    };
  }

  if (options.tools?.length) {
    request.tools = toCodexTools(options.tools);
    request.tool_choice = "auto";
  }

  return request;
}

function normalizeCodexOutput(
  response: CodexResponse,
  fallback?: { text?: string; output?: CodexResponseOutputItem[] },
): AssistantContentBlock[] {
  const output = response.output?.length ? response.output : (fallback?.output ?? []);
  const blocks: AssistantContentBlock[] = [];

  for (const item of output) {
    if (item.type === "message") {
      const text =
        item.content
          ?.map((part) => {
            if (part.type === "output_text") {
              return part.text ?? "";
            }
            if (part.type === "refusal") {
              return part.refusal ?? "";
            }
            return "";
          })
          .join("") ?? "";
      if (text) {
        blocks.push({ type: "text", text });
      }
      continue;
    }

    if (item.type === "function_call" && item.name && item.call_id) {
      blocks.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        ...parseToolArguments(item.arguments ?? "{}"),
      });
    }
  }

  if (blocks.length === 0 && fallback?.text) {
    blocks.push({ type: "text", text: fallback.text });
  }

  return blocks;
}

function normalizeCodexStopReason(
  response: CodexResponse,
  content: AssistantContentBlock[],
): LlmResponse["stopReason"] {
  if (content.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }
  if (response.status === "incomplete") {
    return "max_tokens";
  }
  return "end_turn";
}

function responseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function requestHeaders(credentials: CodexCredentials): Headers {
  const headers = new Headers({
    authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    originator: "sloppy",
    "user-agent": "sloppy",
    "openai-beta": "responses=experimental",
    "content-type": "application/json",
    accept: "text/event-stream",
  });
  return headers;
}

async function throwResponseError(response: Response): Promise<never> {
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const text = await response.text();
    if (text) {
      try {
        const data = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = data.error?.message ?? data.message ?? text;
      } catch {
        message = text;
      }
    }
  } catch {
    // best-effort error body extraction
  }
  throw new Error(`OpenAI Codex request failed: ${message}`);
}

function eventError(event: CodexStreamEvent): Error | null {
  if (event.type === "error") {
    return new Error(event.error?.message ?? "OpenAI Codex stream returned an error event.");
  }
  if (event.type === "response.failed") {
    return new Error(
      event.response?.error?.message ?? "OpenAI Codex stream returned response.failed.",
    );
  }
  return null;
}

function parseSseEvent(raw: string): CodexStreamEvent | null {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  return JSON.parse(data) as CodexStreamEvent;
}

async function parseStreamingResponse(
  response: Response,
  onText?: LlmChatOptions["onText"],
  onThinking?: LlmChatOptions["onThinking"],
  thinking?: EffectiveThinkingConfig,
  model?: string,
  signal?: AbortSignal,
): Promise<{
  response: CodexResponse;
  text: string;
  output: CodexResponseOutputItem[];
  thinkingText: string;
  thinkingFormat: "raw" | "summary";
  thinkingStartedAt?: string;
  thinkingStartedMs?: number;
}> {
  if (!response.body) {
    throw new Error("OpenAI Codex streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let thinkingText = "";
  let thinkingFormat: "raw" | "summary" = "raw";
  let thinkingStartedAt: string | undefined;
  let thinkingStartedMs: number | undefined;
  let finalResponse: CodexResponse | null = null;
  const output: CodexResponseOutputItem[] = [];

  const processRawEvent = (raw: string) => {
    const event = parseSseEvent(raw);
    if (!event) {
      return;
    }
    const error = eventError(event);
    if (error) {
      throw error;
    }

    if (event.type === "response.output_text.delta" && event.delta) {
      streamedText += event.delta;
      onText?.(event.delta);
      return;
    }

    if (
      (event.type === "response.reasoning_text.delta" ||
        event.type === "response.reasoning_summary_text.delta") &&
      event.delta
    ) {
      if (!thinkingStartedAt) {
        thinkingStartedAt = new Date().toISOString();
        thinkingStartedMs = Date.now();
      }
      thinkingFormat = event.type === "response.reasoning_text.delta" ? "raw" : "summary";
      thinkingText += event.delta;
      onThinking?.({
        id: "openai-codex-thinking-0",
        provider: "openai-codex",
        model,
        format: thinkingFormat,
        display: thinking?.display ?? "visible",
        delta: event.delta,
        startedAt: thinkingStartedAt,
      });
      return;
    }

    if (event.type === "response.output_text.done" && event.text && !streamedText) {
      streamedText = event.text;
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
    while (true) {
      // The fetch carries the abort signal, but bail out between reads too so
      // cancellation does not wait on the next network chunk.
      if (signal?.aborted) {
        throw new LlmAbortError();
      }
      const { done, value } = await reader.read();
      if (done) {
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
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      processRawEvent(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    response: finalResponse ?? { status: "completed", output },
    text: streamedText,
    output,
    thinkingText,
    thinkingFormat,
    thinkingStartedAt,
    thinkingStartedMs,
  };
}

export class OpenAICodexAdapter implements LlmAdapter {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort?: LlmReasoningEffort;
  private readonly thinking?: EffectiveThinkingConfig;
  private readonly authPath?: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAICodexAdapterOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_CODEX_BASE_URL;
    this.reasoningEffort = options.reasoningEffort;
    this.thinking = options.thinking;
    this.authPath = options.authPath;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    try {
      const credentials = await resolveCodexCredentials({
        authPath: this.authPath,
        fetchFn: this.fetchFn,
      });
      const request = buildCodexRequest(options, this.model, this.reasoningEffort, this.thinking);
      const response = await this.fetchFn(responseUrl(this.baseUrl), {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({ ...request, stream: true }),
        signal: options.signal,
      });
      if (!response.ok) {
        await throwResponseError(response);
      }

      const codexResponse = await parseStreamingResponse(
        response,
        options.onText,
        options.onThinking,
        this.thinking,
        this.model,
        options.signal,
      );
      const content = normalizeCodexOutput(codexResponse.response, {
        text: codexResponse.text,
        output: codexResponse.output,
      });
      const thinking = normalizeCodexThinking(
        codexResponse,
        this.thinking,
        this.model,
        codexResponse.response.usage?.output_tokens_details?.reasoning_tokens,
      );
      if (thinking && options.onThinking && codexResponse.thinkingText) {
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
        stopReason: normalizeCodexStopReason(codexResponse.response, content),
        usage: {
          inputTokens: codexResponse.response.usage?.input_tokens,
          outputTokens: codexResponse.response.usage?.output_tokens,
          thinkingTokens: codexResponse.response.usage?.output_tokens_details?.reasoning_tokens,
        },
      };
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    }
  }
}

function normalizeCodexThinking(
  streamed: Awaited<ReturnType<typeof parseStreamingResponse>>,
  thinking: EffectiveThinkingConfig | undefined,
  model: string,
  tokenCount: number | undefined,
): ThinkingOutputBlock[] | undefined {
  if (!streamed.thinkingText || !thinking?.effectiveEnabled) {
    return undefined;
  }
  const completedAt = new Date().toISOString();
  return [
    {
      type: "thinking",
      id: "openai-codex-thinking-0",
      provider: "openai-codex",
      model,
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

export {
  buildCodexRequest,
  normalizeCodexOutput,
  responseUrl as buildCodexResponseUrl,
  toCodexInput,
  toCodexTools,
};

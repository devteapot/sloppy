import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { LlmTool } from "@slop-ai/consumer/browser";

import type { LlmReasoningEffort } from "../config/schema";
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

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_SKEW_MS = 120_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CodexAuthFile = {
  auth_mode?: string;
  OPENAI_API_KEY?: unknown;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

type CodexCredentials = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId: string;
};

type CodexResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
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

export type CodexRequestInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: string;
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
  };
  tools?: CodexRequestTool[];
  tool_choice?: "auto";
  stream?: boolean;
};

export type OpenAICodexAdapterOptions = {
  model: string;
  baseUrl?: string;
  reasoningEffort?: LlmReasoningEffort;
  authPath?: string;
  fetchFn?: FetchLike;
};

export type CodexAuthStatus = {
  available: boolean;
  authPath: string;
  reason?: string;
};

function codexAuthPath(): string {
  const override = process.env.SLOPPY_CODEX_AUTH_PATH?.trim();
  if (override) {
    return resolve(override);
  }

  const home = process.env.HOME;
  if (!home) {
    return resolve(".codex/auth.json");
  }
  return resolve(home, ".codex/auth.json");
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }
  return decodeBase64UrlJson(payload);
}

function tokenExpiryMs(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function tokenAccountId(token: string): string | undefined {
  const payload = jwtPayload(token);
  const direct = payload?.chatgpt_account_id;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  for (const value of Object.values(payload ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const accountId = (value as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) {
      return accountId.trim();
    }
  }

  return undefined;
}

async function readCodexAuthFile(authPath: string): Promise<CodexAuthFile | null> {
  try {
    return JSON.parse(await readFile(authPath, "utf8")) as CodexAuthFile;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function credentialsFromAuthFile(auth: CodexAuthFile): CodexCredentials | null {
  const accessToken = auth.tokens?.access_token?.trim();
  if (!accessToken) {
    return null;
  }

  const accountId = auth.tokens?.account_id?.trim() || tokenAccountId(accessToken);
  if (!accountId) {
    return null;
  }

  return {
    accessToken,
    refreshToken: auth.tokens?.refresh_token?.trim() || undefined,
    idToken: auth.tokens?.id_token?.trim() || undefined,
    accountId,
  };
}

async function writeCodexAuthFile(authPath: string, auth: CodexAuthFile): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true });
  const tempPath = `${authPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, authPath);
}

async function refreshCodexCredentials(
  authPath: string,
  auth: CodexAuthFile,
  fetchFn: FetchLike,
): Promise<CodexCredentials> {
  const refreshToken = auth.tokens?.refresh_token?.trim();
  if (!refreshToken) {
    throw new Error("Codex credentials are expired and no refresh token is available.");
  }

  const response = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(`Codex OAuth refresh failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  const accessToken = data.access_token?.trim();
  if (!accessToken) {
    throw new Error("Codex OAuth refresh did not return an access token.");
  }

  const nextAuth: CodexAuthFile = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: accessToken,
      refresh_token: data.refresh_token?.trim() || auth.tokens?.refresh_token,
      id_token: data.id_token?.trim() || auth.tokens?.id_token,
      account_id: auth.tokens?.account_id || tokenAccountId(accessToken),
    },
    last_refresh: new Date().toISOString(),
  };
  await writeCodexAuthFile(authPath, nextAuth);

  const credentials = credentialsFromAuthFile(nextAuth);
  if (!credentials) {
    throw new Error("Codex OAuth refresh returned credentials without an account id.");
  }
  return credentials;
}

export async function getCodexAuthStatus(options?: {
  authPath?: string;
}): Promise<CodexAuthStatus> {
  const authPath = resolve(options?.authPath ?? codexAuthPath());
  const auth = await readCodexAuthFile(authPath);
  if (!auth) {
    return {
      available: false,
      authPath,
      reason: `No Codex auth file found at ${authPath}. Run \`codex login\` first.`,
    };
  }

  const credentials = credentialsFromAuthFile(auth);
  if (!credentials) {
    return {
      available: false,
      authPath,
      reason: `Codex auth file at ${authPath} does not contain usable ChatGPT credentials. Run \`codex login\` again.`,
    };
  }

  return { available: true, authPath };
}

export async function resolveCodexCredentials(options?: {
  authPath?: string;
  fetchFn?: FetchLike;
}): Promise<CodexCredentials> {
  const authPath = resolve(options?.authPath ?? codexAuthPath());
  const auth = await readCodexAuthFile(authPath);
  if (!auth) {
    throw new Error(`No Codex auth file found at ${authPath}. Run \`codex login\` first.`);
  }

  const credentials = credentialsFromAuthFile(auth);
  if (!credentials) {
    throw new Error(
      `Codex auth file at ${authPath} does not contain usable ChatGPT credentials. Run \`codex login\` again.`,
    );
  }

  const expiresAt = tokenExpiryMs(credentials.accessToken);
  if (expiresAt && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS) {
    return refreshCodexCredentials(authPath, auth, options?.fetchFn ?? fetch);
  }

  return credentials;
}

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

    const text = textFromMessage(message);
    if (text.length > 0) {
      input.push({
        type: "message",
        role: message.role,
        content: text,
        phase: message.role === "assistant" ? "final_answer" : undefined,
      });
    }

    if (message.role !== "assistant") {
      continue;
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
): CodexRequest {
  const request: CodexRequest = {
    model,
    instructions: options.system,
    input: toCodexInput(options.messages),
    parallel_tool_calls: true,
    store: false,
  };

  if (reasoningEffort) {
    request.reasoning = { effort: reasoningEffort };
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
): Promise<{ response: CodexResponse; text: string; output: CodexResponseOutputItem[] }> {
  if (!response.body) {
    throw new Error("OpenAI Codex streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
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
  };
}

export class OpenAICodexAdapter implements LlmAdapter {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort?: LlmReasoningEffort;
  private readonly authPath?: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAICodexAdapterOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_CODEX_BASE_URL;
    this.reasoningEffort = options.reasoningEffort;
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
      const request = buildCodexRequest(options, this.model, this.reasoningEffort);
      const response = await this.fetchFn(responseUrl(this.baseUrl), {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({ ...request, stream: true }),
        signal: options.signal,
      });
      if (!response.ok) {
        await throwResponseError(response);
      }

      const codexResponse = await parseStreamingResponse(response, options.onText);
      const content = normalizeCodexOutput(codexResponse.response, {
        text: codexResponse.text,
        output: codexResponse.output,
      });

      return {
        content,
        stopReason: normalizeCodexStopReason(codexResponse.response, content),
        usage: {
          inputTokens: codexResponse.response.usage?.input_tokens ?? 0,
          outputTokens: codexResponse.response.usage?.output_tokens ?? 0,
        },
      };
    } catch (error) {
      throw normalizeLlmAbortError(error, options.signal);
    }
  }
}

export {
  buildCodexRequest,
  normalizeCodexOutput,
  responseUrl as buildCodexResponseUrl,
  toCodexInput,
  toCodexTools,
};

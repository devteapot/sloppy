import { describe, expect, test } from "bun:test";
import type { LlmTool } from "@slop-ai/consumer/browser";
import type { ChatCompletion } from "openai/resources/chat/completions";

import {
  buildOpenAICompatibleRequest,
  OpenAICompatibleAdapter,
  toOpenAIMessages,
} from "../src/llm/openai-compatible";
import type { EffectiveThinkingConfig } from "../src/llm/thinking";
import type { ConversationMessage } from "../src/llm/types";

const READ_TOOL: LlmTool = {
  type: "function",
  function: {
    name: "filesystem__read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
};

type StreamListener =
  | ((delta: string, snapshot: string) => void)
  | ((chunk: unknown, snapshot: unknown) => void);

function createCompletion(): ChatCompletion {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: "Reading the file now.",
          tool_calls: [
            {
              id: "call_readme",
              type: "function",
              function: {
                name: "filesystem__read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    },
  } as ChatCompletion;
}

const THINKING_CONFIG = {
  enabled: true,
  display: "hidden",
  effort: "medium",
  effectiveEnabled: true,
  effectiveReason: "configured",
  effectiveEffort: "medium",
} satisfies EffectiveThinkingConfig;

describe("OpenAICompatibleAdapter", () => {
  test("honors configured message-role and token-field compatibility", () => {
    const parameters = buildOpenAICompatibleRequest(
      "generic",
      {
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 321,
      },
      "custom-model",
      undefined,
      {
        supportsDeveloperRole: true,
        maxTokensField: "max_completion_tokens",
      },
    );

    expect(parameters.max_completion_tokens).toBe(321);
    expect(parameters.max_tokens).toBeUndefined();
    expect(parameters.messages).toEqual([
      { role: "developer", content: "system prompt" },
      { role: "user", content: "hello" },
    ]);
  });

  test("honors configured thinking format without unsupported effort values", () => {
    const parameters = buildOpenAICompatibleRequest(
      "generic",
      {
        system: "system prompt",
        messages: [],
        maxTokens: 100,
      },
      "custom-model",
      THINKING_CONFIG,
      {
        thinkingFormat: "openrouter",
        supportsReasoningEffort: false,
      },
    );

    expect(parameters.reasoning).toEqual({
      enabled: true,
      exclude: false,
    });
  });

  test("omits assistant messages containing only foreign provider continuation state", () => {
    const messages: ConversationMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "provider_continuation",
            purpose: "reasoning",
            issuer: {
              protocol: "anthropic-messages",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              scope: "foreign-scope",
            },
            data: { type: "thinking", signature: "opaque" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ];

    expect(toOpenAIMessages("system prompt", messages)).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Continue." },
    ]);
  });

  test("converts tool results into OpenAI tool messages", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Read the README." }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          {
            type: "tool_use",
            id: "call_readme",
            name: "filesystem__read",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_readme",
            content: '{"status":"ok","data":{"content":"# Sloppy"}}',
          },
        ],
      },
    ];

    const converted = toOpenAIMessages("system prompt", messages);
    expect(converted).toEqual([
      {
        role: "system",
        content: "system prompt",
      },
      {
        role: "user",
        content: "Read the README.",
      },
      {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [
          {
            id: "call_readme",
            type: "function",
            function: {
              name: "filesystem__read",
              arguments: '{"path":"README.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_readme",
        content: '{"status":"ok","data":{"content":"# Sloppy"}}',
      },
    ]);
  });

  test("streams text and normalizes tool calls", async () => {
    let streamedText = "";
    const completion = createCompletion();
    const client = {
      chat: {
        completions: {
          create: async () => completion,
          stream: () => ({
            on: (event: "content" | "chunk", listener: StreamListener) => {
              if (event === "content") {
                (listener as (delta: string, snapshot: string) => void)(
                  "Reading the file now.",
                  "Reading the file now.",
                );
              }
            },
            finalChatCompletion: async () => completion,
          }),
        },
      },
    };

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "gpt-5.4",
      provider: "openai",
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
      onText: (chunk) => {
        streamedText += chunk;
      },
    });

    expect(streamedText).toBe("Reading the file now.");
    expect(response).toEqual({
      content: [
        { type: "text", text: "Reading the file now." },
        {
          type: "tool_use",
          id: "call_readme",
          name: "filesystem__read",
          input: { path: "README.md" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
      },
    });
  });

  test("requests and surfaces OpenAI-compatible thinking output", async () => {
    let receivedParameters: Record<string, unknown> | undefined;
    const completion = createCompletion() as ChatCompletion & {
      usage: NonNullable<ChatCompletion["usage"]> & {
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    (completion.choices[0]!.message as unknown as Record<string, unknown>).reasoning_content =
      "checked the plan";
    completion.usage.completion_tokens_details = { reasoning_tokens: 8 };
    const client = {
      chat: {
        completions: {
          create: async (parameters: Record<string, unknown>) => {
            receivedParameters = parameters;
            return completion;
          },
          stream: () => {
            throw new Error("stream should not be called");
          },
        },
      },
    };
    const thinkingDeltas: string[] = [];

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "gpt-5.4",
      provider: "openai",
      thinking: THINKING_CONFIG,
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
      onThinking: (delta) => thinkingDeltas.push(delta.delta),
    });

    expect(receivedParameters?.reasoning_effort).toBe("medium");
    expect(thinkingDeltas).toEqual(["checked the plan"]);
    expect(response.thinking).toEqual([
      {
        type: "thinking",
        id: "openai-thinking-0",
        provider: "openai",
        model: "gpt-5.4",
        format: "raw",
        display: "hidden",
        text: "checked the plan",
        tokenCount: 8,
        tokenCountSource: "reported",
      },
    ]);
    expect(response.usage.thinkingTokens).toBe(8);
  });

  test("streams OpenAI-compatible thinking deltas from chunks", async () => {
    const completion = createCompletion() as ChatCompletion & {
      usage: NonNullable<ChatCompletion["usage"]> & {
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    completion.usage.completion_tokens_details = { reasoning_tokens: 3 };
    const client = {
      chat: {
        completions: {
          create: async () => completion,
          stream: () => ({
            on: (event: "content" | "chunk", listener: StreamListener) => {
              if (event === "chunk") {
                const emit = listener as (chunk: unknown, snapshot: unknown) => void;
                emit(
                  {
                    choices: [
                      {
                        delta: {
                          reasoning_content: "streamed ",
                          reasoning_details: [
                            {
                              type: "reasoning.encrypted",
                              data: "opaque-a",
                              id: "reasoning-1",
                              format: "anthropic-claude-v1",
                              index: 0,
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {},
                );
                emit(
                  {
                    choices: [
                      {
                        delta: {
                          reasoning_content: "reasoning",
                          reasoning_details: [
                            {
                              type: "reasoning.summary",
                              summary: "checked the tool",
                              id: "reasoning-2",
                              format: "anthropic-claude-v1",
                              index: 1,
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {},
                );
              }
              if (event === "content") {
                (listener as (delta: string, snapshot: string) => void)(
                  "Reading the file now.",
                  "Reading the file now.",
                );
              }
            },
            finalChatCompletion: async () => completion,
          }),
        },
      },
    };
    const thinkingDeltas: string[] = [];

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "open-model",
      provider: "openrouter",
      thinking: THINKING_CONFIG,
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
      onText: () => undefined,
      onThinking: (delta) => {
        if (delta.delta) thinkingDeltas.push(delta.delta);
      },
    });

    expect(thinkingDeltas).toEqual(["streamed ", "reasoning"]);
    expect(response.thinking).toMatchObject([
      {
        type: "thinking",
        id: "openrouter-thinking-0",
        provider: "openrouter",
        model: "open-model",
        format: "raw",
        display: "hidden",
        text: "streamed reasoning",
        tokenCount: 3,
        tokenCountSource: "reported",
      },
    ]);
    expect(response.usage.thinkingTokens).toBe(3);
    expect(response.content[0]).toMatchObject({
      type: "provider_continuation",
      purpose: "reasoning",
      issuer: {
        protocol: "openai-chat",
        provider: "openrouter",
        model: "open-model",
      },
    });

    const continuation = response.content.find((block) => block.type === "provider_continuation");
    if (continuation?.type !== "provider_continuation") {
      throw new Error("Expected a provider continuation.");
    }
    const replay = toOpenAIMessages(
      "system prompt",
      [
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "call_readme", content: "# Sloppy" }],
        },
      ],
      false,
      continuation.issuer,
    );
    expect(replay[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "streamed reasoning",
      reasoning_details: [
        {
          type: "reasoning.encrypted",
          data: "opaque-a",
          id: "reasoning-1",
          format: "anthropic-claude-v1",
          index: 0,
        },
        {
          type: "reasoning.summary",
          summary: "checked the tool",
          id: "reasoning-2",
          format: "anthropic-claude-v1",
          index: 1,
        },
      ],
    });
  });

  test("replays reasoning for custom endpoint aliases using the endpoint issuer", async () => {
    const requests: Record<string, unknown>[] = [];
    const firstCompletion = createCompletion();
    const reasoningDetails = [
      {
        type: "reasoning.encrypted",
        data: "opaque-reasoning",
        id: "reasoning-alias",
        format: "anthropic-claude-v1",
        index: 0,
      },
    ];
    (firstCompletion.choices[0]?.message as unknown as Record<string, unknown>).reasoning_details =
      reasoningDetails;
    let requestIndex = 0;
    const client = {
      chat: {
        completions: {
          create: async (parameters: Record<string, unknown>) => {
            requests.push(parameters);
            requestIndex += 1;
            return requestIndex === 1 ? firstCompletion : createCompletion();
          },
          stream: () => {
            throw new Error("stream should not be called");
          },
        },
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "open-model",
      provider: "corp-router",
      providerKind: "openrouter",
      client,
    });

    const first = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
    });
    expect(first.content[0]).toMatchObject({
      type: "provider_continuation",
      issuer: { protocol: "openai-chat", provider: "corp-router", model: "open-model" },
    });

    await adapter.chat({
      system: "system prompt",
      messages: [
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "call_readme", content: "# Sloppy" }],
        },
      ],
      tools: [READ_TOOL],
      maxTokens: 256,
    });

    const replayMessages = requests[1]?.messages as Array<Record<string, unknown>>;
    expect(replayMessages[1]?.reasoning_details).toEqual(reasoningDetails);
  });

  test("counts text tokens with the OpenAI input token endpoint", async () => {
    let receivedParameters: Record<string, unknown> | undefined;
    const client = {
      chat: {
        completions: {
          create: async () => createCompletion(),
          stream: () => ({
            on: () => undefined,
            finalChatCompletion: async () => createCompletion(),
          }),
        },
      },
      responses: {
        inputTokens: {
          count: async (parameters: Record<string, unknown>) => {
            receivedParameters = parameters;
            return { input_tokens: 23 };
          },
        },
      },
    };

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "gpt-5.4",
      provider: "openai",
      client,
    });

    const count = await adapter.countTextTokens("state tail");

    expect(count).toEqual({ tokens: 23, source: "provider" });
    expect(receivedParameters).toEqual({
      model: "gpt-5.4",
      input: "state tail",
    });
  });

  test("passes configured endpoint headers to OpenAI-compatible requests", async () => {
    const originalFetch = globalThis.fetch;
    const originalBaseUrl = process.env.OPENAI_BASE_URL;
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    let capturedRedirect: RequestRedirect | undefined;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0];
      const init = args[1];
      capturedUrl = String(input);
      capturedRedirect = init?.redirect;
      capturedHeaders = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => {
        capturedHeaders?.set(key, value);
      });
      return new Response(JSON.stringify(createCompletion()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    process.env.OPENAI_BASE_URL = "https://attacker.example/v1";

    try {
      const adapter = new OpenAICompatibleAdapter({
        apiKey: "test-key",
        model: "gpt-5.4",
        provider: "openai",
        headers: { "x-sloppy-route": "blue" },
      });

      await adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
        tools: [READ_TOOL],
        maxTokens: 256,
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl;
      }
    }

    expect(capturedHeaders?.get("x-sloppy-route")).toBe("blue");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer test-key");
    expect(capturedRedirect).toBe("error");
    expect(capturedUrl).toStartWith("https://api.openai.com/v1/");
  });

  test("leaves text token count unavailable for OpenAI-compatible providers without counters", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => createCompletion(),
          stream: () => ({
            on: () => undefined,
            finalChatCompletion: async () => createCompletion(),
          }),
        },
      },
    };

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "open-model",
      provider: "openrouter",
      client,
    });

    await expect(adapter.countTextTokens("state tail")).resolves.toEqual({
      source: "unavailable",
    });
  });

  test("repairs an extra trailing brace in OpenAI-compatible tool-call JSON", async () => {
    const completion = createCompletion();
    const call = completion.choices[0]?.message.tool_calls?.[0];
    expect(call).toBeDefined();
    if (call?.type === "function") {
      call.function.arguments = '{"path":"README.md"}}';
    }
    const client = {
      chat: {
        completions: {
          create: async () => completion,
          stream: () => ({
            on: () => undefined,
            finalChatCompletion: async () => completion,
          }),
        },
      },
    };

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "gpt-5.4",
      provider: "openai",
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.input).toEqual({ path: "README.md" });
    expect(toolUse?.inputError).toBeUndefined();
  });

  test("marks malformed tool-call JSON instead of passing raw args as params", async () => {
    const completion = createCompletion();
    const call = completion.choices[0]?.message.tool_calls?.[0];
    expect(call).toBeDefined();
    if (call?.type === "function") {
      call.function.arguments = '{"path":"README.md"';
    }
    const client = {
      chat: {
        completions: {
          create: async () => completion,
          stream: () => ({
            on: () => undefined,
            finalChatCompletion: async () => completion,
          }),
        },
      },
    };

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "gpt-5.4",
      provider: "openai",
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.input).toEqual({});
    expect(toolUse?.inputError).toMatchObject({
      code: "invalid_json",
      raw: '{"path":"README.md"',
    });
  });

  test("passes abort signals into streaming requests and normalizes cancellation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let aborted = false;
    const client = {
      chat: {
        completions: {
          create: async () => createCompletion(),
          stream: (_parameters: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
            receivedSignal = options?.signal;
            return {
              on: () => undefined,
              abort: () => {
                aborted = true;
              },
              finalChatCompletion: () =>
                new Promise<ChatCompletion>((_, reject) => {
                  options?.signal?.addEventListener(
                    "abort",
                    () => {
                      const error = new Error("aborted");
                      error.name = "AbortError";
                      reject(error);
                    },
                    { once: true },
                  );
                }),
            };
          },
        },
      },
    };

    const adapter = new OpenAICompatibleAdapter({
      apiKey: "test-key",
      model: "gpt-5.4",
      provider: "openai",
      client,
    });

    const pending = adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
      onText: () => undefined,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "LlmAbortError",
      code: "aborted",
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(aborted).toBe(true);
  });

  test("serializes a user message with interleaved text and image blocks", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<slop-state>...</slop-state>" },
          { type: "text", text: "image /gallery/img-1 (camera frame, ttl 3):" },
          { type: "image", mediaType: "image/jpeg", data: "anVuaw==" },
        ],
      },
    ];

    const converted = toOpenAIMessages("system prompt", messages);

    expect(converted).toEqual([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "<slop-state>...</slop-state>" },
          { type: "text", text: "image /gallery/img-1 (camera frame, ttl 3):" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,anVuaw==" } },
        ],
      },
    ]);
  });
});

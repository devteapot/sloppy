import { describe, expect, test } from "bun:test";
import type { GenerateContentResponse, Part } from "@google/genai";
import { FinishReason } from "@google/genai";
import type { LlmTool } from "@slop-ai/consumer/browser";

import { GeminiAdapter, toGeminiContents } from "../src/llm/gemini";
import type { EffectiveThinkingConfig } from "../src/llm/thinking";
import { type ConversationMessage, LlmAbortError } from "../src/llm/types";

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

function continuationScope(content: ConversationMessage["content"]): string {
  const continuation = content.find((block) => block.type === "provider_continuation");
  if (continuation?.type !== "provider_continuation") {
    throw new Error("Expected a provider continuation.");
  }
  return continuation.issuer.scope;
}

function createTextChunk(text: string): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 2,
    },
  } as GenerateContentResponse;
}

function createThinkingResponse(): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ thought: true, text: "checked options" }, { text: "The answer." }],
        },
        finishReason: FinishReason.STOP,
      },
    ],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 6,
    },
  } as unknown as GenerateContentResponse;
}

function createToolChunk(): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_readme",
                name: "filesystem__read",
                args: { path: "README.md" },
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      },
    ],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 4,
    },
  } as unknown as GenerateContentResponse;
}

function createSignedToolResponse(): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              thought: true,
              text: "inspect the file",
              thoughtSignature: "signed-thought",
            },
            {
              thoughtSignature: "signed-call",
              functionCall: {
                id: "call_readme",
                name: "filesystem__read",
                args: { path: "README.md" },
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      },
    ],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 4,
      thoughtsTokenCount: 2,
    },
  } as unknown as GenerateContentResponse;
}

const THINKING_CONFIG = {
  enabled: true,
  display: "hidden",
  effort: "medium",
  effectiveEnabled: true,
  effectiveReason: "configured",
  effectiveEffort: "medium",
} satisfies EffectiveThinkingConfig;

describe("GeminiAdapter", () => {
  test("rejects redirects at the Gemini SDK request boundary", async () => {
    const originalFetch = globalThis.fetch;
    const originalBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
    let capturedRedirect: RequestRedirect | undefined;
    let capturedUrl = "";
    globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      capturedUrl = String(args[0]);
      capturedRedirect = args[1]?.redirect;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "done" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    process.env.GOOGLE_GEMINI_BASE_URL = "https://attacker.example/v1";

    try {
      const adapter = new GeminiAdapter({
        apiKey: "test-key",
        model: "gemini-2.5-pro",
      });
      const response = await adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "Answer." }] }],
        maxTokens: 256,
      });
      expect(response.content).toEqual([{ type: "text", text: "done" }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBaseUrl === undefined) {
        delete process.env.GOOGLE_GEMINI_BASE_URL;
      } else {
        process.env.GOOGLE_GEMINI_BASE_URL = originalBaseUrl;
      }
    }

    expect(capturedRedirect).toBe("error");
    expect(capturedUrl).toStartWith("https://generativelanguage.googleapis.com/");
  });

  test("omits messages containing only foreign provider continuation state", () => {
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

    expect(toGeminiContents(messages, "gemini-3-pro-preview")).toEqual([
      { role: "user", parts: [{ text: "Continue." }] },
    ]);
  });

  test("converts tool calls and tool results into Gemini contents", () => {
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

    const contents = toGeminiContents(messages);

    expect(contents[0]).toEqual({
      role: "user",
      parts: [{ text: "Read the README." }],
    });
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts?.[0]).toEqual({ text: "Reading it." });
    expect(contents[1]?.parts?.[1]?.functionCall).toEqual({
      id: "call_readme",
      name: "filesystem__read",
      args: { path: "README.md" },
    });
    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts?.[0]?.functionResponse).toEqual({
      id: "call_readme",
      name: "filesystem__read",
      response: {
        output: {
          status: "ok",
          data: {
            content: "# Sloppy",
          },
        },
      },
    });
  });

  test("replays thought signatures in order only for the exact model", async () => {
    const client = {
      models: {
        generateContent: async () => createSignedToolResponse(),
        generateContentStream: async () => createStream(),
      },
    };
    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield createSignedToolResponse();
    }
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      thinking: THINKING_CONFIG,
      client,
    });
    const first = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
    });
    expect(first.content.map((block) => block.type)).toEqual([
      "provider_continuation",
      "provider_continuation",
      "tool_use",
    ]);

    const history: ConversationMessage[] = [
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_readme",
            content: "# Sloppy",
          },
        ],
      },
    ];
    const scope = continuationScope(first.content);
    const sameModel = toGeminiContents(history, "gemini-2.5-pro", "gemini", scope);
    expect(sameModel[0]?.parts).toEqual([
      {
        thought: true,
        text: "inspect the file",
        thoughtSignature: "signed-thought",
      },
      {
        thoughtSignature: "signed-call",
        functionCall: {
          id: "call_readme",
          name: "filesystem__read",
          args: { path: "README.md" },
        },
      },
    ]);

    const otherModel = toGeminiContents(history, "gemini-3-pro-preview", "gemini", scope);
    expect(otherModel[0]?.parts).toEqual([
      {
        functionCall: {
          id: "call_readme",
          name: "filesystem__read",
          args: { path: "README.md" },
        },
      },
    ]);
  });

  test("replays ordinary and empty signed text parts without changing them", async () => {
    const signedParts = [
      {
        text: "The answer.",
        thoughtSignature: "signed-answer",
        partMetadata: { trace: "answer-trace" },
      },
      {
        text: "",
        thought: false,
        thoughtSignature: "signed-tail",
        partMetadata: { phase: "final" },
      },
    ] satisfies Part[];
    const response = {
      candidates: [
        {
          content: { role: "model", parts: signedParts },
          finishReason: FinishReason.STOP,
        },
      ],
    } as unknown as GenerateContentResponse;
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-3-pro-preview",
      providerId: "gemini-edge",
      client: {
        models: {
          generateContent: async () => response,
          generateContentStream: async () => createStream(),
        },
      },
    });
    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield response;
    }

    const normalized = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Answer." }] }],
      maxTokens: 256,
    });
    expect(normalized.content.map((block) => block.type)).toEqual([
      "provider_continuation",
      "text",
      "provider_continuation",
    ]);
    expect(
      normalized.content
        .filter((block) => block.type === "provider_continuation")
        .map((block) => (block.type === "provider_continuation" ? block.purpose : undefined)),
    ).toEqual(["assistant_message", "assistant_message"]);

    const history: ConversationMessage[] = [{ role: "assistant", content: normalized.content }];
    const scope = continuationScope(normalized.content);
    expect(
      toGeminiContents(history, "gemini-3-pro-preview", "gemini-edge", scope)[0]?.parts,
    ).toEqual(signedParts);
    expect(toGeminiContents(history, "gemini-3-pro-preview", "gemini", scope)[0]?.parts).toEqual([
      { text: "The answer." },
    ]);
  });

  test("streams text and normalizes Gemini tool calls", async () => {
    let streamedText = "";
    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield createTextChunk("Reading the file now.");
      yield createToolChunk();
    }

    const client = {
      models: {
        generateContent: async () => createToolChunk(),
        generateContentStream: async () => createStream(),
      },
    };

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
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
        inputTokens: 9,
        outputTokens: 4,
      },
    });
  });

  test("preserves stream part order and distinct signatures for no-id function calls", async () => {
    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  thought: true,
                  text: "plan",
                  thoughtSignature: "signed-thought",
                },
                { text: "first" },
                {
                  thoughtSignature: "signed-call-a",
                  functionCall: { name: "filesystem__read", args: { path: "a" } },
                },
              ],
            },
          },
        ],
      } as unknown as GenerateContentResponse;
      yield {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "second" },
                {
                  thoughtSignature: "signed-call-b",
                  functionCall: { name: "filesystem__read", args: { path: "b" } },
                },
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ],
      } as unknown as GenerateContentResponse;
    }
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      thinking: THINKING_CONFIG,
      client: {
        models: {
          generateContent: async () => createSignedToolResponse(),
          generateContentStream: async () => createStream(),
        },
      },
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read both." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
      onText: () => undefined,
    });

    expect(response.content.map((block) => block.type)).toEqual([
      "provider_continuation",
      "text",
      "provider_continuation",
      "tool_use",
      "text",
      "provider_continuation",
      "tool_use",
    ]);
    expect(
      response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => (block.type === "tool_use" ? block.id : "")),
    ).toEqual(["gemini-call-0", "gemini-call-1"]);
    expect(
      response.content
        .filter((block) => block.type === "provider_continuation" && block.purpose === "tool_call")
        .map((block) =>
          block.type === "provider_continuation"
            ? (block.data as { part?: { thoughtSignature?: string } }).part?.thoughtSignature
            : undefined,
        ),
    ).toEqual(["signed-call-a", "signed-call-b"]);

    const replay = toGeminiContents(
      [
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "gemini-call-0", content: '"a"' },
            { type: "tool_result", toolUseId: "gemini-call-1", content: '"b"' },
          ],
        },
      ],
      "gemini-2.5-pro",
      "gemini",
      continuationScope(response.content),
    );
    expect(replay[0]?.parts).toEqual([
      { thought: true, text: "plan", thoughtSignature: "signed-thought" },
      { text: "first" },
      {
        thoughtSignature: "signed-call-a",
        functionCall: { name: "filesystem__read", args: { path: "a" } },
      },
      { text: "second" },
      {
        thoughtSignature: "signed-call-b",
        functionCall: { name: "filesystem__read", args: { path: "b" } },
      },
    ]);
    expect(replay[1]?.parts?.map((part) => part.functionResponse)).toEqual([
      { name: "filesystem__read", response: { output: "a" } },
      { name: "filesystem__read", response: { output: "b" } },
    ]);
  });

  test("aborts mid-stream without consuming further chunks", async () => {
    const controller = new AbortController();
    let secondChunkYielded = false;
    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield createTextChunk("first");
      secondChunkYielded = true;
      yield createTextChunk("second");
    }

    const client = {
      models: {
        generateContent: async () => createTextChunk("unused"),
        generateContentStream: async () => createStream(),
      },
    };

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      client,
    });

    let streamed = "";
    await expect(
      adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "Stream." }] }],
        maxTokens: 256,
        signal: controller.signal,
        onText: (chunk) => {
          streamed += chunk;
          controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(LlmAbortError);
    expect(streamed).toBe("first");
    expect(secondChunkYielded).toBe(true);
  });

  test("requests and surfaces Gemini thinking output", async () => {
    let receivedParameters: Record<string, unknown> | undefined;
    const client = {
      models: {
        generateContent: async (parameters: Record<string, unknown>) => {
          receivedParameters = parameters;
          return createThinkingResponse();
        },
        generateContentStream: async () => createStream(),
      },
    };

    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield createThinkingResponse();
    }

    const thinkingDeltas: string[] = [];
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      providerId: "gemini-edge",
      thinking: THINKING_CONFIG,
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Answer." }] }],
      maxTokens: 256,
      onThinking: (delta) => thinkingDeltas.push(delta.delta),
    });

    const config = receivedParameters?.config as Record<string, unknown> | undefined;
    expect(config?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingBudget: -1,
    });
    expect(thinkingDeltas).toEqual(["checked options"]);
    expect(response).toMatchObject({
      content: [{ type: "text", text: "The answer." }],
      thinking: [
        {
          type: "thinking",
          provider: "gemini-edge",
          model: "gemini-2.5-pro",
          display: "hidden",
          text: "checked options",
          tokenCount: 6,
          tokenCountSource: "reported",
        },
      ],
      usage: {
        inputTokens: 9,
        outputTokens: 2,
        thinkingTokens: 6,
      },
    });
  });

  test("counts text tokens with Gemini countTokens when available", async () => {
    let receivedParameters: Record<string, unknown> | undefined;
    const client = {
      models: {
        countTokens: async (parameters: Record<string, unknown>) => {
          receivedParameters = parameters;
          return { totalTokens: 17 };
        },
        generateContent: async () => createToolChunk(),
        generateContentStream: async () => createStream(),
      },
    };

    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield createToolChunk();
    }

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      client,
    });

    const count = await adapter.countTextTokens("state tail");

    expect(count).toEqual({ tokens: 17, source: "provider" });
    expect(receivedParameters).toMatchObject({
      model: "gemini-2.5-pro",
      contents: [
        {
          role: "user",
          parts: [{ text: "state tail" }],
        },
      ],
    });
  });

  test("passes abort signals into Gemini requests and normalizes cancellation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = {
      models: {
        generateContent: async (parameters: Record<string, unknown>) => {
          const config = parameters.config as { abortSignal?: AbortSignal } | undefined;
          receivedSignal = config?.abortSignal;
          return await new Promise<GenerateContentResponse>((_, reject) => {
            config?.abortSignal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        },
        generateContentStream: async () => createStream(),
      },
    };

    async function* createStream(): AsyncGenerator<GenerateContentResponse> {
      yield createToolChunk();
    }

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-2.5-pro",
      client,
    });

    const pending = adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the README." }] }],
      tools: [READ_TOOL],
      maxTokens: 256,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "LlmAbortError",
      code: "aborted",
    });
    expect(receivedSignal).toBe(controller.signal);
  });
});

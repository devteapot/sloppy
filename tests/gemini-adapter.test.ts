import { describe, expect, test } from "bun:test";
import type { GenerateContentResponse } from "@google/genai";
import { FinishReason } from "@google/genai";
import type { LlmTool } from "@slop-ai/consumer/browser";

import { GeminiAdapter, toGeminiContents } from "../src/llm/gemini";
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

describe("GeminiAdapter", () => {
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

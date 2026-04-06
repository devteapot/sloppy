import { describe, expect, test } from "bun:test";
import type { LlmTool } from "@slop-ai/consumer/browser";
import type { ChatCompletion } from "openai/resources/chat/completions";

import { OpenAICompatibleAdapter, toOpenAIMessages } from "../src/llm/openai-compatible";
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

describe("OpenAICompatibleAdapter", () => {
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
            on: (_event: "content", listener: (delta: string, snapshot: string) => void) => {
              listener("Reading the file now.", "Reading the file now.");
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
});

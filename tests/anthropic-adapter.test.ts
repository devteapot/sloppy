import { describe, expect, test } from "bun:test";
import type { Message, MessageCountTokensParams } from "@anthropic-ai/sdk/resources/messages";

import { AnthropicAdapter } from "../src/llm/anthropic";
import type { EffectiveThinkingConfig } from "../src/llm/thinking";

const THINKING_CONFIG = {
  enabled: true,
  display: "hidden",
  effort: "medium",
  effectiveEnabled: true,
  effectiveReason: "configured",
  effectiveEffort: "medium",
} satisfies EffectiveThinkingConfig;

describe("AnthropicAdapter", () => {
  test("rejects redirects before SDK credentials can be forwarded", async () => {
    const originalFetch = globalThis.fetch;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    let capturedRedirect: RequestRedirect | undefined;
    let capturedUrl = "";
    globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      capturedUrl = String(args[0]);
      capturedRedirect = args[1]?.redirect;
      return new Response(JSON.stringify({ input_tokens: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    process.env.ANTHROPIC_BASE_URL = "https://attacker.example/v1";

    try {
      const adapter = new AnthropicAdapter({
        apiKey: "test-key",
        model: "claude-sonnet-4-6",
      });
      await expect(adapter.countTextTokens("state tail")).resolves.toEqual({
        tokens: 4,
        source: "provider",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      }
    }

    expect(capturedRedirect).toBe("error");
    expect(capturedUrl).toStartWith("https://api.anthropic.com/");
  });

  test("counts text tokens with the Anthropic countTokens endpoint", async () => {
    let receivedBody: MessageCountTokensParams | undefined;
    const client = {
      messages: {
        stream: () => {
          throw new Error("stream should not be called");
        },
        countTokens: async (body: MessageCountTokensParams) => {
          receivedBody = body;
          return { input_tokens: 19 };
        },
      },
    };

    const adapter = new AnthropicAdapter({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      client,
    });

    const count = await adapter.countTextTokens("state tail");

    expect(count).toEqual({ tokens: 19, source: "provider" });
    expect(receivedBody).toEqual({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "state tail" }],
    });
  });

  test("requests and surfaces Anthropic thinking summaries", async () => {
    let receivedBody: Record<string, unknown> | undefined;
    let thinkingListener: ((delta: string, snapshot: string) => void) | undefined;
    const client = {
      messages: {
        stream: (body: Record<string, unknown>) => {
          receivedBody = body;
          return {
            abort: () => undefined,
            on: (
              event: "text" | "thinking",
              listener: ((delta: string) => void) | ((delta: string, snapshot: string) => void),
            ) => {
              if (event === "thinking") {
                thinkingListener = listener as (delta: string, snapshot: string) => void;
              }
            },
            finalMessage: async () => {
              thinkingListener?.("checked", "checked");
              return {
                id: "msg-test",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [
                  { type: "thinking", thinking: "checked" },
                  { type: "text", text: "done" },
                ],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 3 },
              } as unknown as Message;
            },
          };
        },
        countTokens: async () => ({ input_tokens: 0 }),
      },
    };
    const thinkingDeltas: string[] = [];

    const adapter = new AnthropicAdapter({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      providerId: "anthropic-edge",
      thinking: THINKING_CONFIG,
      client,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Answer." }] }],
      maxTokens: 256,
      onThinking: (delta) => {
        if (delta.delta) thinkingDeltas.push(delta.delta);
      },
    });

    expect(receivedBody?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(thinkingDeltas).toEqual(["checked"]);
    expect(response).toMatchObject({
      content: [{ type: "text", text: "done" }],
      thinking: [
        {
          type: "thinking",
          id: "anthropic-thinking-0",
          provider: "anthropic-edge",
          model: "claude-sonnet-4-6",
          format: "summary",
          display: "hidden",
          text: "checked",
          tokenCountSource: "unavailable",
        },
      ],
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });

  test("replays signed thinking in order only for the exact provider and model", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const responseMessages: Message[] = [
      {
        id: "msg-tool",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "inspect the file", signature: "signed-thinking" },
          { type: "redacted_thinking", data: "redacted-state" },
          {
            type: "tool_use",
            id: "call-readme",
            name: "filesystem__read",
            input: { path: "README.md" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as Message,
      {
        id: "msg-done",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 2 },
      } as unknown as Message,
      {
        id: "msg-other-model",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 2 },
      } as unknown as Message,
      {
        id: "msg-after-foreign-state",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "continued" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 2 },
      } as unknown as Message,
    ];
    const client = {
      messages: {
        stream: (body: Record<string, unknown>) => {
          requestBodies.push(body);
          const message = responseMessages.shift();
          if (!message) throw new Error("missing test response");
          return {
            abort: () => undefined,
            on: () => undefined,
            finalMessage: async () => message,
          };
        },
        countTokens: async () => ({ input_tokens: 0 }),
      },
    };

    const source = new AnthropicAdapter({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      thinking: THINKING_CONFIG,
      client,
    });
    const first = await source.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read README." }] }],
      maxTokens: 256,
    });
    expect(first.content.map((block) => block.type)).toEqual([
      "provider_continuation",
      "provider_continuation",
      "tool_use",
    ]);

    const history = [
      { role: "assistant" as const, content: first.content },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "call-readme",
            content: "# Sloppy",
          },
        ],
      },
    ];
    await source.chat({
      system: "system prompt",
      messages: history,
      maxTokens: 256,
    });
    const sameModelMessages = requestBodies[1]?.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    expect(sameModelMessages[0]?.content).toEqual([
      { type: "thinking", thinking: "inspect the file", signature: "signed-thinking" },
      { type: "redacted_thinking", data: "redacted-state" },
      {
        type: "tool_use",
        id: "call-readme",
        name: "filesystem__read",
        input: { path: "README.md" },
      },
    ]);

    const otherModel = new AnthropicAdapter({
      apiKey: "test-key",
      model: "claude-opus-4-6",
      thinking: THINKING_CONFIG,
      client,
    });
    await otherModel.chat({
      system: "system prompt",
      messages: history,
      maxTokens: 256,
    });
    const otherModelMessages = requestBodies[2]?.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    expect(otherModelMessages[0]?.content).toEqual([
      {
        type: "tool_use",
        id: "call-readme",
        name: "filesystem__read",
        input: { path: "README.md" },
      },
    ]);

    await otherModel.chat({
      system: "system prompt",
      messages: [
        {
          role: "assistant",
          content: first.content.filter((block) => block.type === "provider_continuation"),
        },
        { role: "user", content: [{ type: "text", text: "Continue." }] },
      ],
      maxTokens: 256,
    });
    const foreignOnlyMessages = requestBodies[3]?.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    expect(foreignOnlyMessages).toEqual([
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ]);
  });
});

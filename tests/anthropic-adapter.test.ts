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
          provider: "anthropic",
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

  test("serializes a user message with interleaved text and image blocks", async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const client = {
      messages: {
        stream: (body: Record<string, unknown>) => {
          receivedBody = body;
          return {
            abort: () => undefined,
            on: () => undefined,
            finalMessage: async () =>
              ({
                id: "msg-test",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "a desk" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 3 },
              }) as unknown as Message,
          };
        },
        countTokens: async () => ({ input_tokens: 0 }),
      },
    };

    const adapter = new AnthropicAdapter({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      client,
    });

    await adapter.chat({
      system: "system prompt",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<slop-state>...</slop-state>" },
            { type: "text", text: "image /gallery/img-1 (camera frame, ttl 3):" },
            { type: "image", mediaType: "image/jpeg", data: "anVuaw==" },
          ],
        },
      ],
      maxTokens: 256,
    });

    expect((receivedBody?.messages as unknown[])[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "<slop-state>...</slop-state>" },
        { type: "text", text: "image /gallery/img-1 (camera frame, ttl 3):" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "anVuaw==" },
        },
      ],
    });
  });
});

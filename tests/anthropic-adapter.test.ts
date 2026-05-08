import { describe, expect, test } from "bun:test";
import type { MessageCountTokensParams } from "@anthropic-ai/sdk/resources/messages";

import { AnthropicAdapter } from "../src/llm/anthropic";

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
});

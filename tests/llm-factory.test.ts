import { afterEach, describe, expect, test } from "bun:test";

import type { LlmAdapterConfig } from "../src/llm/factory";
import { createLlmAdapter } from "../src/llm/factory";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;

function createConfig(overrides: Partial<LlmAdapterConfig>): LlmAdapterConfig {
  return {
    endpointId: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-sonnet-4-20250514",
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...overrides,
  };
}

afterEach(() => {
  if (originalAnthropicKey == null) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }

  if (originalGeminiKey == null) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

describe("createLlmAdapter", () => {
  test("creates the native Gemini adapter", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";

    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "gemini",
        protocol: "gemini",
        model: "gemini-2.5-pro",
        apiKey: process.env.GEMINI_API_KEY,
      }),
    );

    expect(adapter.constructor.name).toBe("GeminiAdapter");
  });

  test("creates the OpenAI-compatible adapter for Ollama without an API key", () => {
    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "ollama",
        protocol: "openai-chat",
        model: "llama3.2",
        baseUrl: "http://localhost:11434/v1",
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAICompatibleAdapter");
  });

  test("creates the native OpenAI Codex adapter without an API key", () => {
    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "openai-codex",
        protocol: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAICodexAdapter");
  });

  test("requires API keys for Anthropic-backed providers", () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() =>
      createLlmAdapter(
        createConfig({
          apiKey: undefined,
          authHint:
            "Set ANTHROPIC_API_KEY, store a key for endpoint anthropic in the app, or choose another profile before starting a model turn.",
        }),
      ),
    ).toThrow(
      "No API key was resolved for anthropic. Set ANTHROPIC_API_KEY, store a key for endpoint anthropic in the app, or choose another profile before starting a model turn.",
    );
  });
});

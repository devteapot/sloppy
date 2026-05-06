import { afterEach, describe, expect, test } from "bun:test";

import type { LlmAdapterConfig } from "../src/llm/factory";
import { createLlmAdapter } from "../src/llm/factory";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;

function createConfig(overrides: Partial<LlmAdapterConfig>): LlmAdapterConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKeyEnv: "ANTHROPIC_API_KEY",
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
        provider: "gemini",
        model: "gemini-2.5-pro",
        apiKey: process.env.GEMINI_API_KEY,
        apiKeyEnv: "GEMINI_API_KEY",
      }),
    );

    expect(adapter.constructor.name).toBe("GeminiAdapter");
  });

  test("creates the OpenAI-compatible adapter for Ollama without an API key", () => {
    const adapter = createLlmAdapter(
      createConfig({
        provider: "ollama",
        model: "llama3.2",
        apiKeyEnv: undefined,
        baseUrl: "http://localhost:11434/v1",
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAICompatibleAdapter");
  });

  test("creates the native OpenAI Codex adapter without an API key", () => {
    const adapter = createLlmAdapter(
      createConfig({
        provider: "openai-codex",
        model: "gpt-5.5",
        reasoningEffort: "low",
        apiKeyEnv: undefined,
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAICodexAdapter");
  });

  test("requires API keys for Anthropic-backed providers", () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createLlmAdapter(createConfig({ apiKey: undefined }))).toThrow(
      "No API key was resolved for anthropic. Set ANTHROPIC_API_KEY, store a key in the app, or choose another profile before starting a model turn.",
    );
  });
});

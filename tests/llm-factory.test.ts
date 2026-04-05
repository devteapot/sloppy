import { afterEach, describe, expect, test } from "bun:test";

import type { SloppyConfig } from "../src/config/schema";
import { createLlmAdapter } from "../src/llm/factory";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;

function createConfig(overrides: Partial<SloppyConfig["llm"]>): SloppyConfig {
  return {
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxTokens: 4096,
      ...overrides,
    },
    agent: {
      maxIterations: 12,
      contextBudgetTokens: 24000,
      minSalience: 0.2,
      overviewDepth: 2,
      overviewMaxNodes: 200,
      detailDepth: 4,
      detailMaxNodes: 200,
      historyTurns: 8,
      toolResultMaxChars: 16000,
    },
    providers: {
      builtin: {
        terminal: true,
        filesystem: true,
      },
      discovery: {
        enabled: true,
        paths: [],
      },
      terminal: {
        cwd: process.cwd(),
        historyLimit: 10,
        syncTimeoutMs: 30000,
      },
      filesystem: {
        root: process.cwd(),
        focus: process.cwd(),
        recentLimit: 10,
        searchLimit: 20,
        readMaxBytes: 65536,
      },
    },
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

  test("requires API keys for Anthropic-backed providers", () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createLlmAdapter(createConfig({}))).toThrow(
      "Missing ANTHROPIC_API_KEY. Set it before starting Sloppy.",
    );
  });
});

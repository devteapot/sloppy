import { afterEach, describe, expect, test } from "bun:test";

import type { LlmAdapterConfig } from "../src/llm/factory";
import { createLlmAdapter, getLlmRuntimeDescriptor, resolveLlmMaxTokens } from "../src/llm/factory";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;

function createConfig(overrides: Partial<LlmAdapterConfig>): LlmAdapterConfig {
  return {
    endpointId: "anthropic",
    protocol: "anthropic-messages",
    authType: "env",
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
        authType: "none",
        model: "llama3.2",
        baseUrl: "http://localhost:11434/v1",
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAICompatibleAdapter");
  });

  test("attaches provider-neutral model limits and capabilities", () => {
    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "ollama",
        protocol: "openai-chat",
        authType: "none",
        model: "llama3.2",
        baseUrl: "http://localhost:11434/v1",
        maxOutputTokens: 512,
        capabilities: { tools: false, images: false },
      }),
    );

    expect(getLlmRuntimeDescriptor(adapter)).toEqual({
      endpointId: "ollama",
      protocol: "openai-chat",
      model: "llama3.2",
      maxOutputTokens: 512,
      capabilities: { tools: false, images: false },
      ownsToolLoop: false,
    });
    expect(resolveLlmMaxTokens(adapter, 4096)).toBe(512);
  });

  test("creates the native OpenAI Codex adapter without an API key", () => {
    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "openai-codex",
        protocol: "openai-codex",
        authType: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        maxOutputTokens: 128_000,
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAICodexAdapter");
    expect(getLlmRuntimeDescriptor(adapter)?.maxOutputTokens).toBeUndefined();
    expect(resolveLlmMaxTokens(adapter, 4096)).toBe(4096);
  });

  test("creates the generic OpenAI Responses adapter", () => {
    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "openai",
        protocol: "openai-responses",
        authType: "env",
        model: "gpt-5.4",
        apiKey: "test-openai-key",
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAIResponsesAdapter");
  });

  test("creates the xAI Responses adapter through the shared protocol driver", () => {
    const adapter = createLlmAdapter(
      createConfig({
        endpointId: "xai",
        protocol: "openai-responses",
        authType: "env",
        model: "grok-4.5",
        apiKey: "test-xai-key",
        baseUrl: "https://api.x.ai/v1",
        capabilities: { tools: true, images: true },
      }),
    );

    expect(adapter.constructor.name).toBe("OpenAIResponsesAdapter");
    expect(getLlmRuntimeDescriptor(adapter)).toMatchObject({
      endpointId: "xai",
      protocol: "openai-responses",
      model: "grok-4.5",
      capabilities: { tools: true, images: true },
    });
  });

  test("rejects invalid protocol and auth combinations before construction", () => {
    expect(() =>
      createLlmAdapter(
        createConfig({
          endpointId: "openai-codex",
          protocol: "openai-codex",
          authType: "env",
          model: "gpt-5.6-sol",
        }),
      ),
    ).toThrow("requires auth.type=codex");

    expect(() =>
      createLlmAdapter(
        createConfig({
          endpointId: "anthropic",
          protocol: "anthropic-messages",
          authType: "codex",
        }),
      ),
    ).toThrow("Codex auth is only valid with openai-codex");

    expect(() =>
      createLlmAdapter(
        createConfig({
          endpointId: "openai-codex",
          protocol: "openai-codex",
          authType: "codex",
          baseUrl: "https://attacker.example/capture",
        }),
      ),
    ).toThrow("Codex subscription auth may only be sent");
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

  test("requires API keys for authenticated OpenAI wire protocols", () => {
    for (const protocol of ["openai-chat", "openai-responses"] as const) {
      expect(() =>
        createLlmAdapter(
          createConfig({
            endpointId: "routed-openai",
            protocol,
            authType: "secure_store",
            apiKey: undefined,
          }),
        ),
      ).toThrow("No API key was resolved for routed-openai");
    }
  });

  test("rejects credential-bearing HTTP endpoints at the adapter boundary", () => {
    expect(() =>
      createLlmAdapter(
        createConfig({
          endpointId: "programmatic-proxy",
          protocol: "openai-chat",
          authType: "secure_store",
          apiKey: "secret",
          baseUrl: "http://proxy.example/v1",
        }),
      ),
    ).toThrow("must use https");

    expect(() =>
      createLlmAdapter(
        createConfig({
          endpointId: "header-proxy",
          protocol: "openai-chat",
          authType: "none",
          apiKey: undefined,
          headers: { "x-api-key": "secret" },
          baseUrl: "http://proxy.example/v1",
        }),
      ),
    ).toThrow("must use https");
  });

  test("allows unauthenticated local HTTP endpoints", () => {
    expect(() =>
      createLlmAdapter(
        createConfig({
          endpointId: "local",
          protocol: "openai-chat",
          authType: "none",
          apiKey: undefined,
          baseUrl: "http://127.0.0.1:11434/v1",
        }),
      ),
    ).not.toThrow();
  });
});

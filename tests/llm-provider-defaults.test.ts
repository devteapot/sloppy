import { describe, expect, test } from "bun:test";

import { DEFAULT_LLM_ENDPOINTS, mergeLlmEndpoints } from "../src/llm/catalog";

describe("default LLM endpoint catalog", () => {
  test("ships endpoint metadata for API-compatible defaults", () => {
    expect(DEFAULT_LLM_ENDPOINTS.openai?.models["gpt-5.4"]?.contextWindowTokens).toBe(1_050_000);
    expect(DEFAULT_LLM_ENDPOINTS.openrouter?.models["openai/gpt-5.4"]?.contextWindowTokens).toBe(
      1_050_000,
    );
    expect(DEFAULT_LLM_ENDPOINTS.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("merges custom endpoint model metadata over built-ins", () => {
    const endpoints = mergeLlmEndpoints({
      openai: {
        protocol: "openai-chat",
        auth: { type: "env", env: "CUSTOM_OPENAI_KEY" },
        models: {
          "gpt-5.4": {
            contextWindowTokens: 123,
          },
          "local/test": {
            contextWindowTokens: 456,
          },
        },
      },
    });

    expect(endpoints.openai?.auth).toEqual({ type: "env", env: "CUSTOM_OPENAI_KEY" });
    expect(endpoints.openai?.models["gpt-5.4"]?.contextWindowTokens).toBe(123);
    expect(endpoints.openai?.models["gpt-5.4"]?.capabilities?.tools).toBe(true);
    expect(endpoints.openai?.models["local/test"]?.contextWindowTokens).toBe(456);
  });
});

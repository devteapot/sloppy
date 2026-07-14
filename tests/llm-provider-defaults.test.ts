import { describe, expect, test } from "bun:test";

import { DEFAULT_LLM_ENDPOINTS, mergeLlmEndpoints } from "../src/llm/catalog";

describe("default LLM endpoint catalog", () => {
  test("ships endpoint metadata for API-compatible defaults", () => {
    expect(DEFAULT_LLM_ENDPOINTS.openai?.protocol).toBe("openai-responses");
    expect(DEFAULT_LLM_ENDPOINTS.openai?.models["gpt-5.4"]?.contextWindowTokens).toBe(1_050_000);
    expect(DEFAULT_LLM_ENDPOINTS.openrouter?.models["openai/gpt-5.4"]?.contextWindowTokens).toBe(
      1_050_000,
    );
    expect(DEFAULT_LLM_ENDPOINTS.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("ships the GPT-5.6 family for native Codex subscription profiles", () => {
    const endpoint = DEFAULT_LLM_ENDPOINTS["openai-codex"];

    expect(endpoint?.defaultModel).toBe("gpt-5.6-sol");
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(endpoint?.models[model]).toMatchObject({
        contextWindowTokens: 258_400,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, images: true },
      });
    }
    expect(endpoint?.models["gpt-5.5"]).toBeDefined();
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

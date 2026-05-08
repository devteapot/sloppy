import { describe, expect, test } from "bun:test";

import { resolveModelContextWindowTokens } from "../src/llm/provider-defaults";

describe("resolveModelContextWindowTokens", () => {
  test("uses current GPT-5.5 context metadata for API-compatible providers", () => {
    expect(resolveModelContextWindowTokens("openai", "gpt-5.5")).toBe(1_050_000);
    expect(resolveModelContextWindowTokens("openai", "gpt-5.5-2026-04-23")).toBe(1_050_000);
    expect(resolveModelContextWindowTokens("openrouter", "openai/gpt-5.5")).toBe(1_050_000);
  });

  test("distinguishes GPT-5.4 full-size models from mini and nano", () => {
    expect(resolveModelContextWindowTokens("openai", "gpt-5.4")).toBe(1_050_000);
    expect(resolveModelContextWindowTokens("openai", "gpt-5.4-2026-03-05")).toBe(1_050_000);
    expect(resolveModelContextWindowTokens("openai", "gpt-5.4-mini")).toBe(400_000);
    expect(resolveModelContextWindowTokens("openai", "gpt-5.4-mini-2026-04-23")).toBe(400_000);
    expect(resolveModelContextWindowTokens("openai", "gpt-5.4-nano")).toBe(400_000);
    expect(resolveModelContextWindowTokens("openai", "gpt-5.4-nano-2026-04-23")).toBe(400_000);
  });

  test("normalizes OpenRouter provider-prefixed model names", () => {
    expect(resolveModelContextWindowTokens("openrouter", "openai/gpt-5.4")).toBe(1_050_000);
    expect(resolveModelContextWindowTokens("openrouter", "openai/gpt-5.4-mini")).toBe(400_000);
  });
});

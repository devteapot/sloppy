import { describe, expect, test } from "bun:test";

import { ResilientLlmAdapter, validateLlmRequestPolicy } from "../src/llm/resilience";
import {
  LlmAbortError,
  type LlmAdapter,
  type LlmChatOptions,
  LlmRequestError,
  type LlmResponse,
} from "../src/llm/types";

const response: LlmResponse = {
  content: [{ type: "text", text: "done" }],
  stopReason: "end_turn",
  usage: {},
};

function options(overrides: Partial<LlmChatOptions> = {}): LlmChatOptions {
  return {
    system: "system",
    messages: [],
    maxTokens: 100,
    ...overrides,
  };
}

function policy(overrides: Partial<ConstructorParameters<typeof ResilientLlmAdapter>[1]> = {}) {
  return {
    timeoutMs: 1000,
    maxRetries: 2,
    baseRetryDelayMs: 10,
    maxRetryDelayMs: 100,
    ...overrides,
  };
}

describe("ResilientLlmAdapter", () => {
  test("rejects request policies outside the config schema constraints", () => {
    const adapter: LlmAdapter = {
      async chat() {
        return response;
      },
    };
    const invalidPolicies: Array<[Partial<ReturnType<typeof policy>>, string]> = [
      [{ timeoutMs: 999 }, "timeoutMs must be greater than or equal to 1000"],
      [{ timeoutMs: 1_000.5 }, "timeoutMs must be a safe integer"],
      [{ timeoutMs: Number.NaN }, "timeoutMs must be a safe integer"],
      [{ timeoutMs: Number.MAX_SAFE_INTEGER + 1 }, "timeoutMs must be a safe integer"],
      [{ timeoutMs: 2_147_483_648 }, "timeoutMs must be less than or equal to 2147483647"],
      [{ maxRetries: -1 }, "maxRetries must be greater than or equal to 0"],
      [{ maxRetries: 11 }, "maxRetries must be less than or equal to 10"],
      [{ maxRetries: Number.POSITIVE_INFINITY }, "maxRetries must be a safe integer"],
      [{ baseRetryDelayMs: -1 }, "baseRetryDelayMs must be greater than or equal to 0"],
      [
        { maxRetryDelayMs: 2_147_483_648 },
        "maxRetryDelayMs must be less than or equal to 2147483647",
      ],
      [{ maxRetryDelayMs: -1 }, "maxRetryDelayMs must be greater than or equal to 0"],
      [
        { baseRetryDelayMs: 20, maxRetryDelayMs: 10 },
        "maxRetryDelayMs must be greater than or equal to baseRetryDelayMs",
      ],
    ];

    expect(validateLlmRequestPolicy(policy())).toBeUndefined();
    for (const [overrides, message] of invalidPolicies) {
      const invalidPolicy = policy(overrides);
      expect(validateLlmRequestPolicy(invalidPolicy)).toContain(message);
      expect(() => new ResilientLlmAdapter(adapter, invalidPolicy)).toThrow(message);
    }
  });

  test("copies a validated policy so callers cannot mutate retry bounds", async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async chat() {
        calls += 1;
        throw Object.assign(new Error("temporarily overloaded"), { status: 503 });
      },
    };
    const mutablePolicy = policy({ maxRetries: 0 });
    const resilient = new ResilientLlmAdapter(adapter, mutablePolicy, {
      sleep: async () => {},
    });
    mutablePolicy.maxRetries = 10;

    await expect(resilient.chat(options())).rejects.toBeInstanceOf(LlmRequestError);
    expect(calls).toBe(1);
  });

  test("retries classified transient failures with bounded backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const adapter: LlmAdapter = {
      async chat() {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("temporarily overloaded"), {
            status: 503,
            headers: { "retry-after-ms": calls === 1 ? "25" : "250" },
          });
        }
        return response;
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy(), {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(resilient.chat(options())).resolves.toEqual(response);
    expect(calls).toBe(3);
    expect(delays).toEqual([25, 100]);
  });

  test("does not retry authentication or invalid request failures", async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async chat() {
        calls += 1;
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy(), { sleep: async () => {} });

    const error = await resilient.chat(options()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).code).toBe("authentication");
    expect((error as LlmRequestError).retryable).toBe(false);
    expect(calls).toBe(1);
  });

  test("retries known transient provider error codes without an HTTP status", async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async chat() {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("Internal error"), { code: "server_error" });
        }
        return response;
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy(), { sleep: async () => {} });

    await expect(resilient.chat(options())).resolves.toEqual(response);
    expect(calls).toBe(2);
  });

  test("classifies Anthropic 529 responses as overloaded", async () => {
    const adapter: LlmAdapter = {
      async chat() {
        throw Object.assign(new Error("overloaded_error"), { status: 529 });
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy({ maxRetries: 0 }));

    const error = await resilient.chat(options()).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({ code: "overloaded", retryable: true, status: 529 });
  });

  test("retries an abruptly closed stream only before partial output", async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async chat() {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("stream ended before terminal response"), {
            code: "incomplete_stream",
          });
        }
        return response;
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy(), { sleep: async () => {} });

    await expect(resilient.chat(options())).resolves.toEqual(response);
    expect(calls).toBe(2);
  });

  test("suppresses late callbacks from a failed attempt during retry backoff", async () => {
    let calls = 0;
    let releaseBackoff: (() => void) | undefined;
    const chunks: string[] = [];
    const adapter: LlmAdapter = {
      async chat(chatOptions) {
        calls += 1;
        if (calls === 1) {
          setTimeout(() => chatOptions.onText?.("late-partial"), 0);
          throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
        }
        chatOptions.onText?.("fresh");
        return response;
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy(), {
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseBackoff = resolve;
        }),
    });

    const request = resilient.chat(options({ onText: (chunk) => chunks.push(chunk) }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chunks).toEqual([]);
    releaseBackoff?.();
    await expect(request).resolves.toEqual(response);
    expect(chunks).toEqual(["fresh"]);
  });

  test("preserves absent streaming callbacks for adapters that select transport by callback", async () => {
    let observedTextCallback: LlmChatOptions["onText"];
    let observedThinkingCallback: LlmChatOptions["onThinking"];
    const adapter: LlmAdapter = {
      async chat(chatOptions) {
        observedTextCallback = chatOptions.onText;
        observedThinkingCallback = chatOptions.onThinking;
        return response;
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy());

    await resilient.chat(options());

    expect(observedTextCallback).toBeUndefined();
    expect(observedThinkingCallback).toBeUndefined();
  });

  test("does not retry after partial streamed output", async () => {
    let calls = 0;
    const chunks: string[] = [];
    const adapter: LlmAdapter = {
      async chat(chatOptions) {
        calls += 1;
        chatOptions.onText?.("partial");
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy(), { sleep: async () => {} });

    const error = await resilient
      .chat(options({ onText: (chunk) => chunks.push(chunk) }))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).partialOutput).toBe(true);
    expect(calls).toBe(1);
    expect(chunks).toEqual(["partial"]);
  });

  test("enforces a deadline and suppresses late output", async () => {
    const chunks: string[] = [];
    const adapter: LlmAdapter = {
      async chat(chatOptions) {
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        chatOptions.onText?.("late");
        return response;
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy({ timeoutMs: 1_000, maxRetries: 0 }));

    const error = await resilient
      .chat(options({ onText: (chunk) => chunks.push(chunk) }))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).code).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chunks).toEqual([]);
  });

  test("preserves caller cancellation as LlmAbortError", async () => {
    const controller = new AbortController();
    const adapter: LlmAdapter = {
      async chat() {
        return new Promise(() => {});
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy());
    const request = resilient.chat(options({ signal: controller.signal }));
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(LlmAbortError);
  });

  test("cancels token counting even when the provider ignores abort", async () => {
    const controller = new AbortController();
    const adapter: LlmAdapter = {
      async chat() {
        throw new Error("not used");
      },
      async countTextTokens() {
        return new Promise(() => {});
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy());
    const request = resilient.countTextTokens?.("state", { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(LlmAbortError);
  });

  test("bounds provider token counting with the same request deadline", async () => {
    const adapter: LlmAdapter = {
      async chat() {
        throw new Error("not used");
      },
      async countTextTokens(_text, countOptions) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1_250);
          countOptions?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
            },
            { once: true },
          );
        });
        return { tokens: 1, source: "provider" };
      },
    };
    const resilient = new ResilientLlmAdapter(adapter, policy({ timeoutMs: 1_000, maxRetries: 0 }));

    const error = await resilient.countTextTokens?.("state").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({ code: "timeout", retryable: true });
  });
});

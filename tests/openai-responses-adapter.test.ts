import { describe, expect, test } from "bun:test";

import type { LlmTool } from "@slop-ai/consumer/browser";

import {
  normalizeOpenAIResponsesOutput,
  OpenAIResponsesAdapter,
  toOpenAIResponsesInput,
} from "../src/llm/openai-responses";
import { ResilientLlmAdapter } from "../src/llm/resilience";
import type { EffectiveThinkingConfig } from "../src/llm/thinking";
import {
  type ConversationMessage,
  LlmRequestError,
  type ProviderContinuationIssuer,
} from "../src/llm/types";

const READ_TOOL: LlmTool = {
  type: "function",
  function: {
    name: "filesystem__read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
};

const THINKING_CONFIG = {
  enabled: true,
  display: "visible",
  effort: "medium",
  effectiveEnabled: true,
  effectiveReason: "configured",
  effectiveEffort: "medium",
} satisfies EffectiveThinkingConfig;

describe("OpenAIResponsesAdapter", () => {
  test("counts input tokens with Responses auth, routing, redirect, and abort policies", async () => {
    const controller = new AbortController();
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedSignal: AbortSignal | null | undefined;
    let capturedRedirect: RequestRedirect | undefined;
    const adapter = new OpenAIResponsesAdapter({
      providerId: "openai-edge",
      model: "gpt-5.4",
      apiKey: "sk-test",
      baseUrl: "https://proxy.example/v1/",
      headers: { "x-tenant": "alpha" },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedSignal = init?.signal;
        capturedRedirect = init?.redirect;
        return new Response(JSON.stringify({ input_tokens: 23 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      adapter.countTextTokens("state tail", { signal: controller.signal }),
    ).resolves.toEqual({ tokens: 23, source: "provider" });
    expect(capturedUrl).toBe("https://proxy.example/v1/responses/input_tokens");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer sk-test");
    expect(capturedHeaders?.get("x-tenant")).toBe("alpha");
    expect(capturedHeaders?.get("accept")).toBe("application/json");
    expect(capturedBody).toEqual({ model: "gpt-5.4", input: "state tail" });
    expect(capturedSignal).toBe(controller.signal);
    expect(capturedRedirect).toBe("error");
  });

  test("preserves Responses input-token error metadata", async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: { message: "Slow down", code: "rate_limit_exceeded" },
          }),
          {
            status: 429,
            headers: { "retry-after": "2", "x-request-id": "req_count_123" },
          },
        ),
    });

    const failure = await adapter.countTextTokens("state tail").catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      requestId: "req_count_123",
    });
    expect((failure as { headers?: Headers }).headers?.get("retry-after")).toBe("2");
  });

  test("uses API-key auth, custom headers, max_output_tokens, and flat Responses tools", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedRedirect: RequestRedirect | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedRedirect = init?.redirect;
      return new Response(
        [
          'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted","status":"completed"}}',
          "",
          'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","phase":"commentary","status":"completed","content":[{"type":"output_text","text":"Checking."}]}}',
          "",
          'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_readme","name":"filesystem__read","arguments":"{\\"path\\":\\"README.md\\"}","status":"completed"}}',
          "",
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":12,"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2}}}}',
          "",
        ].join("\n"),
        { status: 200 },
      );
    };
    const adapter = new OpenAIResponsesAdapter({
      providerId: "openai-edge",
      model: "gpt-5.4",
      apiKey: "sk-test",
      baseUrl: "https://proxy.example/v1/",
      headers: { "x-tenant": "alpha" },
      reasoningEffort: "high",
      fetchFn,
    });

    const response = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Read README." }] }],
      tools: [READ_TOOL],
      maxTokens: 512,
    });

    expect(capturedUrl).toBe("https://proxy.example/v1/responses");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer sk-test");
    expect(capturedHeaders?.get("x-tenant")).toBe("alpha");
    expect(capturedHeaders?.get("chatgpt-account-id")).toBeNull();
    expect(capturedRedirect).toBe("error");
    expect(capturedBody).toMatchObject({
      model: "gpt-5.4",
      instructions: "system prompt",
      max_output_tokens: 512,
      reasoning: { effort: "high" },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
      tool_choice: "auto",
    });
    expect(capturedBody?.tools).toEqual([
      {
        type: "function",
        name: "filesystem__read",
        description: "Read a file.",
        parameters: READ_TOOL.function.parameters,
        strict: false,
      },
    ]);
    expect(response.content.map((block) => block.type)).toEqual([
      "provider_continuation",
      "provider_continuation",
      "text",
      "provider_continuation",
      "tool_use",
    ]);
    expect(response.content[0]).toMatchObject({
      type: "provider_continuation",
      issuer: {
        protocol: "openai-responses",
        provider: "openai-edge",
        model: "gpt-5.4",
      },
    });
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      thinkingTokens: 2,
    });
  });

  test("replays opaque items only for the exact Responses issuer", () => {
    const issuer: ProviderContinuationIssuer = {
      protocol: "openai-responses",
      provider: "openai-edge",
      model: "gpt-5.4",
      scope: "test-scope",
    };
    const content = normalizeOpenAIResponsesOutput(
      {
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "inspect" }],
            encrypted_content: "encrypted-reasoning",
            status: "completed",
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Reading it." }],
            status: "completed",
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_readme",
            name: "filesystem__read",
            arguments: '{"path":"README.md"}',
            status: "completed",
          },
        ],
      },
      issuer,
    );
    const history: ConversationMessage[] = [
      { role: "assistant", content },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "call_readme", content: "# Sloppy" }],
      },
    ];

    expect(toOpenAIResponsesInput(history, issuer)).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "inspect" }],
        encrypted_content: "encrypted-reasoning",
        status: "completed",
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Reading it." }],
        status: "completed",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_readme",
        name: "filesystem__read",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "call_readme",
        output: "# Sloppy",
      },
    ]);
    expect(
      toOpenAIResponsesInput(history, {
        ...issuer,
        provider: "another-endpoint",
      }),
    ).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "Reading it.",
        phase: "final_answer",
      },
      {
        type: "function_call",
        call_id: "call_readme",
        name: "filesystem__read",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "call_readme",
        output: "# Sloppy",
      },
    ]);
  });

  test("omits messages containing only foreign provider continuation state", () => {
    const target: ProviderContinuationIssuer = {
      protocol: "openai-responses",
      provider: "openai-edge",
      model: "gpt-5.4",
      scope: "target-scope",
    };
    const history: ConversationMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "provider_continuation",
            purpose: "reasoning",
            issuer: { ...target, scope: "foreign-scope" },
            data: { encrypted_content: "opaque" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ];

    expect(toOpenAIResponsesInput(history, target)).toEqual([
      { type: "message", role: "user", content: "Continue." },
    ]);
  });

  test("round-trips provider-owned output item fields without rebuilding them", () => {
    const issuer: ProviderContinuationIssuer = {
      protocol: "openai-responses",
      provider: "openai-edge",
      model: "gpt-5.4",
      scope: "test-scope",
    };
    const output = [
      {
        type: "message" as const,
        id: "msg_opaque",
        role: "assistant" as const,
        phase: null,
        status: "completed",
        content: [
          {
            type: "output_text" as const,
            text: "Preserve me.",
            annotations: [{ type: "url_citation", url: "https://example.test" }],
            logprobs: [{ token: "Preserve" }],
          },
        ],
        provider_metadata: { trace_id: "trace-1" },
      },
      {
        type: "function_call" as const,
        id: "fc_opaque",
        call_id: "call_opaque",
        name: "filesystem__read",
        namespace: "runtime.filesystem",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
    ];
    const content = normalizeOpenAIResponsesOutput({ status: "completed", output }, issuer);

    expect(toOpenAIResponsesInput([{ role: "assistant", content }], issuer)).toEqual(output);
  });

  test("supports header-provided authentication without inventing a bearer key", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
        { status: 200 },
      );
    };
    const adapter = new OpenAIResponsesAdapter({
      model: "local-model",
      headers: { authorization: "Proxy token", "x-route": "local" },
      fetchFn,
    });

    await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxTokens: 256,
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
    expect(capturedHeaders?.get("authorization")).toBe("Proxy token");
    expect(capturedHeaders?.get("x-route")).toBe("local");
  });

  test("retains HTTP status, headers, provider code, and request id on failures", async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Slow down",
              code: "rate_limit_exceeded",
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "2",
              "x-request-id": "req_123",
            },
          },
        ),
    });

    let failure: unknown;
    try {
      await adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 256,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      requestId: "req_123",
    });
    expect((failure as { headers?: Headers }).headers?.get("retry-after")).toBe("2");
  });

  test("rejects an abruptly closed stream instead of accepting partial output", async () => {
    const chunks: string[] = [];
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
          status: 200,
        }),
    });

    await expect(
      adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 256,
        onText: (chunk) => chunks.push(chunk),
      }),
    ).rejects.toThrow("stream ended before a terminal response event");
    expect(chunks).toEqual(["partial"]);
  });

  test("emits done-only recovered text through the streaming callback", async () => {
    const chunks: string[] = [];
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          [
            'data: {"type":"response.output_text.done","text":"Recovered text."}',
            "",
            'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
    });

    const result = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxTokens: 256,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual(["Recovered text."]);
    expect(result.content).toContainEqual({ type: "text", text: "Recovered text." });
  });

  test("recovers done-only text per output item after another item streamed deltas", async () => {
    const chunks: string[] = [];
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          [
            'data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"First."}',
            "",
            'data: {"type":"response.output_text.done","item_id":"msg_1","content_index":0,"text":"First."}',
            "",
            'data: {"type":"response.output_text.done","item_id":"msg_2","content_index":0,"text":"Second."}',
            "",
            'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
    });

    const result = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxTokens: 256,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual(["First.", "Second."]);
    expect(result.content).toContainEqual({ type: "text", text: "First.Second." });
  });

  test("reconciles reasoning done events per item without duplicating streamed deltas", async () => {
    const thinkingDeltas: string[] = [];
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      thinking: THINKING_CONFIG,
      fetchFn: async () =>
        new Response(
          [
            'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"First"}',
            "",
            'data: {"type":"response.reasoning_summary_text.done","item_id":"rs_1","output_index":0,"summary_index":0,"text":"First complete."}',
            "",
            'data: {"type":"response.reasoning_summary_text.done","item_id":"rs_2","output_index":1,"summary_index":0,"text":"Second."}',
            "",
            'data: {"type":"response.reasoning_summary_text.done","item_id":"rs_2","output_index":1,"summary_index":0,"text":"Second."}',
            "",
            'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"output_tokens_details":{"reasoning_tokens":4}}}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
    });

    const result = await adapter.chat({
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxTokens: 256,
      onThinking: (delta) => {
        if (delta.delta) thinkingDeltas.push(delta.delta);
      },
    });

    expect(thinkingDeltas).toEqual(["First", " complete.", "Second."]);
    expect(result.thinking).toMatchObject([
      {
        type: "thinking",
        format: "summary",
        text: "First complete.Second.",
        tokenCount: 4,
      },
    ]);
  });

  test("stops reading after a terminal event even when the SSE connection stays open", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const fetchFn = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done."}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 64,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("terminal SSE event did not resolve")), 250);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    expect(result.content).toContainEqual({ type: "text", text: "Done." });
    expect(cancelled).toBe(true);
  });

  test("preserves provider error codes from failed stream events", async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"Internal error"}}}\n\n',
          { status: 200 },
        ),
    });

    const failure = await adapter
      .chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 256,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "server_error", message: "Internal error" });
  });

  test("cancels failed streams and preserves response retry metadata", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"Internal error"}}}\n\n',
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: { "retry-after": "2", "x-request-id": "req_stream_123" },
          },
        ),
    });
    const resilient = new ResilientLlmAdapter(adapter, {
      timeoutMs: 1_000,
      maxRetries: 0,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 100,
    });

    const failure = await resilient
      .chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 256,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({
      code: "provider",
      retryable: true,
      retryAfterMs: 2_000,
      requestId: "req_stream_123",
    });
    expect(cancelled).toBe(true);
  });

  test("parses top-level Responses error stream fields", async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: async () =>
        new Response(
          'data: {"type":"error","code":"server_error","message":"Top-level failure"}\n\n',
          { status: 200 },
        ),
    });

    const failure = await adapter
      .chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        maxTokens: 256,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "server_error", message: "Top-level failure" });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmTool } from "@slop-ai/consumer/browser";

import { normalizeCodexOutput, OpenAICodexAdapter, toCodexInput } from "../src/llm/openai-codex";
import { resolveCodexCredentials } from "../src/llm/openai-codex-auth";
import type { EffectiveThinkingConfig } from "../src/llm/thinking";
import { type ConversationMessage, LlmAbortError } from "../src/llm/types";

const originalCodexAuthPath = process.env.SLOPPY_CODEX_AUTH_PATH;

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
  display: "hidden",
  effort: "medium",
  effectiveEnabled: true,
  effectiveReason: "configured",
  effectiveEffort: "medium",
} satisfies EffectiveThinkingConfig;

afterEach(() => {
  if (originalCodexAuthPath == null) {
    delete process.env.SLOPPY_CODEX_AUTH_PATH;
  } else {
    process.env.SLOPPY_CODEX_AUTH_PATH = originalCodexAuthPath;
  }
});

async function writeAuthFile(
  root: string,
  accountId = "codex-account",
  accessToken = "codex-access-token",
): Promise<string> {
  const authPath = join(root, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: "codex-refresh-token",
        account_id: accountId,
      },
    }),
  );
  return authPath;
}

describe("OpenAICodexAdapter", () => {
  test("rejects redirects while refreshing Codex OAuth credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-refresh-redirect-"));
    try {
      const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
      const authPath = await writeAuthFile(root, "codex-account", expiredToken);
      let capturedRedirect: RequestRedirect | undefined;

      const credentials = await resolveCodexCredentials({
        authPath,
        fetchFn: async (_input, init) => {
          capturedRedirect = init?.redirect;
          return new Response(
            JSON.stringify({
              access_token: "refreshed-access-token",
              refresh_token: "refreshed-refresh-token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });

      expect(capturedRedirect).toBe("error");
      expect(credentials).toMatchObject({
        accessToken: "refreshed-access-token",
        accountId: "codex-account",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("propagates chat cancellation through OAuth refresh and skips auth-store writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-refresh-abort-"));
    try {
      const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
      const authPath = await writeAuthFile(root, "codex-account", expiredToken);
      const controller = new AbortController();
      let refreshSignal: AbortSignal | null | undefined;
      let requestCount = 0;
      const adapter = new OpenAICodexAdapter({
        model: "gpt-5.6-sol",
        authPath,
        fetchFn: async (_input, init) => {
          requestCount += 1;
          refreshSignal = init?.signal;
          controller.abort();
          return new Response(
            JSON.stringify({
              access_token: "refreshed-access-token",
              refresh_token: "refreshed-refresh-token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });

      await expect(
        adapter.chat({
          system: "system prompt",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          maxTokens: 256,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(LlmAbortError);

      expect(refreshSignal).toBe(controller.signal);
      expect(requestCount).toBe(1);
      const persisted = JSON.parse(await readFile(authPath, "utf8")) as {
        tokens?: { access_token?: string; refresh_token?: string };
      };
      expect(persisted.tokens).toMatchObject({
        access_token: expiredToken,
        refresh_token: "codex-refresh-token",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes credential temp files when refreshed auth persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-refresh-cleanup-"));
    try {
      const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
      const authPath = await writeAuthFile(root, "codex-account", expiredToken);

      await expect(
        resolveCodexCredentials({
          authPath,
          fetchFn: async () => {
            await rm(authPath);
            await mkdir(authPath);
            return new Response(
              JSON.stringify({
                access_token: "refreshed-access-token",
                refresh_token: "refreshed-refresh-token",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("posts Responses requests with Codex auth headers and normalizes tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-adapter-"));
    try {
      const authPath = await writeAuthFile(root);
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
            'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Reading it."}]}}',
            "",
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_readme","name":"filesystem__read","arguments":"{\\"path\\":\\"README.md\\"}"}}',
            "",
            'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":4}}}',
            "",
          ].join("\n"),
          { status: 200 },
        );
      };
      const messages: ConversationMessage[] = [
        { role: "user", content: [{ type: "text", text: "Read README." }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_previous",
              name: "filesystem__read",
              input: { path: "package.json" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_previous",
              content: '{"name":"sloppy"}',
            },
          ],
        },
      ];

      const adapter = new OpenAICodexAdapter({
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        authPath,
        fetchFn,
      });

      const response = await adapter.chat({
        system: "system prompt",
        messages,
        tools: [READ_TOOL],
        maxTokens: 256,
      });

      expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(capturedHeaders?.get("authorization")).toBe("Bearer codex-access-token");
      expect(capturedHeaders?.get("chatgpt-account-id")).toBe("codex-account");
      expect(capturedHeaders?.get("accept")).toBe("text/event-stream");
      expect(capturedRedirect).toBe("error");
      expect(capturedBody).toMatchObject({
        model: "gpt-5.6-sol",
        instructions: "system prompt",
        reasoning: { effort: "max" },
        tool_choice: "auto",
        stream: true,
      });
      expect(capturedBody).not.toHaveProperty("max_output_tokens");
      expect(capturedBody?.input).toEqual([
        { type: "message", role: "user", content: "Read README." },
        {
          type: "function_call",
          call_id: "call_previous",
          name: "filesystem__read",
          arguments: '{"path":"package.json"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_previous",
          output: '{"name":"sloppy"}',
        },
      ]);
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
        "text",
        "provider_continuation",
        "tool_use",
      ]);
      expect(response.content.filter((block) => block.type !== "provider_continuation")).toEqual([
        { type: "text", text: "Reading it." },
        {
          type: "tool_use",
          id: "call_readme",
          name: "filesystem__read",
          input: { path: "README.md" },
        },
      ]);
      expect(response.stopReason).toBe("tool_use");
      expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to send Codex subscription credentials to custom origins", () => {
    expect(
      () =>
        new OpenAICodexAdapter({
          model: "gpt-5.6-sol",
          baseUrl: "https://attacker.example/capture",
        }),
    ).toThrow("may only be sent to https://chatgpt.com/backend-api/codex");
  });

  test("drops private continuation state after the Codex account changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-account-scope-"));
    try {
      const authPath = await writeAuthFile(root, "account-one", "token-one");
      const bodies: Array<Record<string, unknown>> = [];
      let request = 0;
      const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        request += 1;
        return new Response(
          request === 1
            ? [
                'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_private","summary":[],"encrypted_content":"account-one-state","status":"completed"}}',
                "",
                'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}',
                "",
              ].join("\n")
            : 'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { status: 200 },
        );
      };
      const adapter = new OpenAICodexAdapter({
        model: "gpt-5.6-sol",
        authPath,
        fetchFn,
      });
      const first = await adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "Begin." }] }],
        maxTokens: 256,
      });
      expect(first.content.map((block) => block.type)).toEqual(["provider_continuation"]);

      await writeAuthFile(root, "account-two", "token-two");
      await adapter.chat({
        system: "system prompt",
        messages: [
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "text", text: "Continue." }] },
        ],
        maxTokens: 256,
      });

      expect(bodies[1]?.input).toEqual([{ type: "message", role: "user", content: "Continue." }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborts mid-stream between SSE reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-abort-"));
    try {
      const authPath = await writeAuthFile(root);
      const encoder = new TextEncoder();
      const controller = new AbortController();
      const fetchFn = async (): Promise<Response> =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(
                encoder.encode('data: {"type":"response.output_text.delta","delta":"first"}\n\n'),
              );
              streamController.enqueue(
                encoder.encode('data: {"type":"response.output_text.delta","delta":"second"}\n\n'),
              );
              streamController.close();
            },
          }),
          { status: 200 },
        );
      const adapter = new OpenAICodexAdapter({
        model: "gpt-5.5",
        authPath,
        fetchFn,
      });

      let streamed = "";
      await expect(
        adapter.chat({
          system: "system prompt",
          messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
          maxTokens: 256,
          signal: controller.signal,
          onText: (chunk) => {
            streamed += chunk;
            controller.abort();
          },
        }),
      ).rejects.toBeInstanceOf(LlmAbortError);
      expect(streamed).toBe("first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("streams text deltas and falls back to streamed text when final output is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-stream-"));
    try {
      const authPath = await writeAuthFile(root);
      const encoder = new TextEncoder();
      const fetchFn = async (): Promise<Response> =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'data: {"type":"response.output_text.delta","delta":"hello"}',
                    "",
                    'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2}}}',
                    "",
                  ].join("\n"),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      let streamed = "";
      const adapter = new OpenAICodexAdapter({
        model: "gpt-5.5",
        authPath,
        fetchFn,
      });

      const response = await adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
        maxTokens: 256,
        onText: (chunk) => {
          streamed += chunk;
        },
      });

      expect(streamed).toBe("hello");
      expect(response).toEqual({
        content: [{ type: "text", text: "hello" }],
        stopReason: "end_turn",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requests and surfaces Codex thinking summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-thinking-"));
    try {
      const authPath = await writeAuthFile(root);
      let capturedBody: Record<string, unknown> | undefined;
      const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          [
            'data: {"type":"response.reasoning_summary_text.delta","delta":"checked"}',
            "",
            'data: {"type":"response.output_text.delta","delta":"done"}',
            "",
            'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2,"output_tokens_details":{"reasoning_tokens":5}}}}',
            "",
          ].join("\n"),
          { status: 200 },
        );
      };
      const thinkingDeltas: string[] = [];
      const adapter = new OpenAICodexAdapter({
        model: "gpt-5.5",
        authPath,
        thinking: THINKING_CONFIG,
        fetchFn,
      });

      const response = await adapter.chat({
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
        maxTokens: 256,
        onThinking: (delta) => {
          if (delta.delta) thinkingDeltas.push(delta.delta);
        },
      });

      expect(capturedBody?.reasoning).toEqual({ effort: "medium", summary: "auto" });
      expect(thinkingDeltas).toEqual(["checked"]);
      expect(response.thinking).toMatchObject([
        {
          type: "thinking",
          id: "openai-codex-thinking-0",
          provider: "openai-codex",
          model: "gpt-5.5",
          format: "summary",
          display: "hidden",
          text: "checked",
          tokenCount: 5,
          tokenCountSource: "reported",
        },
      ]);
      expect(response.usage.thinkingTokens).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replays Responses items in order only for the exact provider and model", () => {
    const content = normalizeCodexOutput(
      {
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "inspect the file" }],
            encrypted_content: "encrypted-reasoning",
            status: "completed",
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
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
      "gpt-5.6-sol",
      "openai-codex",
    );
    expect(content.map((block) => block.type)).toEqual([
      "provider_continuation",
      "provider_continuation",
      "text",
      "provider_continuation",
      "tool_use",
    ]);

    const history: ConversationMessage[] = [
      { role: "assistant", content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_readme",
            content: "# Sloppy",
          },
        ],
      },
    ];
    expect(toCodexInput(history, "gpt-5.6-sol")).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "inspect the file" }],
        encrypted_content: "encrypted-reasoning",
        status: "completed",
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
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
    expect(toCodexInput(history, "gpt-5.7")).toEqual([
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
});

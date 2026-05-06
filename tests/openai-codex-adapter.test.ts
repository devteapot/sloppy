import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmTool } from "@slop-ai/consumer/browser";

import { OpenAICodexAdapter } from "../src/llm/openai-codex";
import type { ConversationMessage } from "../src/llm/types";

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

afterEach(() => {
  if (originalCodexAuthPath == null) {
    delete process.env.SLOPPY_CODEX_AUTH_PATH;
  } else {
    process.env.SLOPPY_CODEX_AUTH_PATH = originalCodexAuthPath;
  }
});

async function writeAuthFile(root: string): Promise<string> {
  const authPath = join(root, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
        account_id: "codex-account",
      },
    }),
  );
  return authPath;
}

describe("OpenAICodexAdapter", () => {
  test("posts Responses requests with Codex auth headers and normalizes tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-adapter-"));
    try {
      const authPath = await writeAuthFile(root);
      let capturedUrl = "";
      let capturedHeaders: Headers | undefined;
      let capturedBody: Record<string, unknown> | undefined;
      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
        model: "gpt-5.5",
        reasoningEffort: "low",
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
      expect(capturedBody).toMatchObject({
        model: "gpt-5.5",
        instructions: "system prompt",
        reasoning: { effort: "low" },
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
      expect(response).toEqual({
        content: [
          { type: "text", text: "Reading it." },
          {
            type: "tool_use",
            id: "call_readme",
            name: "filesystem__read",
            input: { path: "README.md" },
          },
        ],
        stopReason: "tool_use",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
        },
      });
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
});

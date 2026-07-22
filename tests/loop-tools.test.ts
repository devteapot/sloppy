import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { action, createSlopServer } from "@slop-ai/server";

import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import { ImageRegistry } from "../src/core/images";
import {
  type AgentToolEvent,
  buildToolFreeRequestHistory,
  runLoop,
  truncateToolResult,
} from "../src/core/loop";
import { createLlmAdapter } from "../src/llm/factory";
import type {
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../src/llm/types";
import { InProcessTransport } from "../src/providers/in-process";
import { createTestConfig } from "./helpers/config";

const TEST_CONFIG = createTestConfig({
  agent: { maxIterations: 3 },
});

describe("buildToolFreeRequestHistory", () => {
  test("converts replayed tool blocks into portable text summaries", () => {
    expect(
      buildToolFreeRequestHistory([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "filesystem__read",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-1",
              content: "read ok",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '[Previous tool call \'filesystem__read\': {"path":"README.md"}]',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[Previous tool result for 'call-1': read ok]",
          },
        ],
      },
    ]);
  });

  test("preserves opaque reasoning continuation while removing portable tool blocks", () => {
    expect(
      buildToolFreeRequestHistory([
        {
          role: "assistant",
          content: [
            {
              type: "provider_continuation",
              purpose: "reasoning",
              issuer: {
                protocol: "openai-responses",
                provider: "openai",
                model: "test-model",
                scope: "test-scope",
              },
              data: { kind: "response_output_item", item: { type: "reasoning" } },
            },
            {
              type: "provider_continuation",
              purpose: "tool_call",
              issuer: {
                protocol: "openai-responses",
                provider: "openai",
                model: "test-model",
                scope: "test-scope",
              },
              data: { kind: "response_output_item", item: { type: "function_call" } },
            },
            { type: "text", text: "Portable answer" },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "provider_continuation",
            purpose: "reasoning",
            issuer: {
              protocol: "openai-responses",
              provider: "openai",
              model: "test-model",
              scope: "test-scope",
            },
            data: { kind: "response_output_item", item: { type: "reasoning" } },
          },
          { type: "text", text: "Portable answer" },
        ],
      },
    ]);
  });
});

class InvalidToolArgumentsLlm implements LlmAdapter {
  calls = 0;
  observedSecondRequest = "";

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: "bad-args",
            name: "demo__workspace__read",
            input: {},
            inputError: {
              code: "invalid_json",
              message: "Tool arguments were not valid JSON: trailing brace",
              raw: '{"path":"README.md"}}',
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    this.observedSecondRequest = JSON.stringify(options.messages);
    return {
      content: [{ type: "text", text: "corrected" }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

class ToolBatchProbeLlm implements LlmAdapter {
  calls = 0;
  observedToolResults: ToolResultContentBlock[] = [];

  constructor(private readonly toolCalls: ToolUseContentBlock[]) {}

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: this.toolCalls,
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    this.observedToolResults = options.messages
      .flatMap((message) => message.content)
      .filter((block): block is ToolResultContentBlock => block.type === "tool_result");
    return {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

class ThinkingReplayProbeLlm implements LlmAdapter {
  calls = 0;
  observedSecondRequest = "";

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      options.onThinking?.({
        id: "thinking-1",
        provider: "openai",
        model: "gpt-5.4",
        format: "raw",
        display: "visible",
        delta: "hidden deliberation",
        tokenCount: 4,
        tokenCountSource: "reported",
      });
      return {
        content: [
          { type: "text", text: "visible assistant text" },
          {
            type: "tool_use",
            id: "call-inspect",
            name: "demo__workspace__inspect",
            input: {},
          },
        ],
        thinking: [
          {
            type: "thinking",
            id: "thinking-1",
            provider: "openai",
            model: "gpt-5.4",
            format: "raw",
            display: "visible",
            text: "hidden deliberation",
            tokenCount: 4,
            tokenCountSource: "reported",
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 2, thinkingTokens: 4 },
      };
    }

    this.observedSecondRequest = JSON.stringify(options.messages);
    return {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 4 },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("truncateToolResult", () => {
  test("does not modify results under the limit", () => {
    const result = "Hello, world!";
    const output = truncateToolResult(result, 4096);
    expect(output).toBe("Hello, world!");
    expect(output.length).toBeLessThanOrEqual(4096);
  });

  test("truncates and appends message when over limit", () => {
    const largeResult = "A".repeat(10000);
    const output = truncateToolResult(largeResult, 4096);
    expect(output.length).toBeLessThanOrEqual(4096);
    expect(output).toContain("truncated");
    expect(output).toContain("chars removed");
    expect(output).toContain("query_state");
    expect(output).toContain("full details]");
  });

  test("ensures total output does not exceed limit", () => {
    const largeResult = "B".repeat(20000);
    const output = truncateToolResult(largeResult, 1000);
    expect(output.length).toBeLessThanOrEqual(1000);
  });

  test("handles empty results", () => {
    const empty = "";
    const output = truncateToolResult(empty, 4096);
    expect(output).toBe("");
    expect(output.length).toBe(0);
  });
});

describe("runLoop tool execution", () => {
  test("rejects tool calls returned by a model declared tools=false", async () => {
    let providerInvocations = 0;
    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        inspect: action(async () => {
          providerInvocations += 1;
          return { value: 42 };
        }),
      },
    }));
    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    history.addUserText("inspect");
    const llm = createLlmAdapter({
      endpointId: "tool-free",
      protocol: "openai-chat",
      authType: "none",
      model: "tool-free-model",
      capabilities: { tools: false },
    });
    llm.chat = async () => ({
      content: [
        {
          type: "tool_use",
          id: "forged-call",
          name: "demo__workspace__inspect",
          input: {},
        },
      ],
      stopReason: "tool_use",
      usage: {},
    });

    try {
      await hub.connect();
      await expect(runLoop({ config: TEST_CONFIG, hub, history, llm })).rejects.toMatchObject({
        code: "provider",
        retryable: false,
      });
      expect(providerInvocations).toBe(0);
    } finally {
      hub.shutdown();
    }
  });

  test("reports unsupported image input as a structured model error", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    history.addUserMessage([
      { type: "text", text: "Describe this image." },
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
    ]);
    const llm = createLlmAdapter({
      endpointId: "text-only",
      protocol: "openai-chat",
      authType: "none",
      model: "text-only-model",
      capabilities: { images: false },
    });
    llm.chat = async () => {
      throw new Error("The adapter must not be called.");
    };

    try {
      await hub.connect();
      await expect(runLoop({ config: TEST_CONFIG, hub, history, llm })).rejects.toMatchObject({
        code: "invalid_request",
        retryable: false,
      });
    } finally {
      hub.shutdown();
    }
  });

  test("returns malformed tool arguments to the model without invoking the provider", async () => {
    let providerInvocations = 0;
    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        read: action(
          { path: "string" },
          async () => {
            providerInvocations += 1;
            return { content: "should not run" };
          },
          {
            label: "Read",
            description: "Read a file.",
            estimate: "instant",
          },
        ),
      },
    }));

    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new InvalidToolArgumentsLlm();
    const events: AgentToolEvent[] = [];
    history.addUserText("read the file");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
        onToolEvent: (event) => events.push(event),
      });

      expect(result.status).toBe("completed");
      expect(providerInvocations).toBe(0);
      expect(llm.observedSecondRequest).toContain("invalid_tool_arguments");
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "completed",
          status: "error",
          errorCode: "invalid_tool_arguments",
        }),
      );
    } finally {
      hub.shutdown();
    }
  });

  test("emits provider result data with affordance result kind", async () => {
    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        inspect: action(async () => ({ value: 42 }), {
          label: "Inspect",
          description: "Inspect structured data.",
          estimate: "fast",
          resultKind: "json",
        }),
      },
    }));

    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new ToolBatchProbeLlm([
      {
        type: "tool_use",
        id: "call-inspect",
        name: "demo__workspace__inspect",
        input: {},
      },
    ]);
    const events: AgentToolEvent[] = [];
    history.addUserText("inspect");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
        onToolEvent: (event) => events.push(event),
      });

      expect(result.status).toBe("completed");
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "completed",
          result: {
            kind: "json",
            data: { value: 42 },
          },
        }),
      );
    } finally {
      hub.shutdown();
    }
  });

  test("does not replay thinking output into the next model call", async () => {
    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        inspect: action(async () => ({ value: 42 }), {
          label: "Inspect",
          description: "Inspect structured data.",
          estimate: "fast",
          resultKind: "json",
        }),
      },
    }));

    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new ThinkingReplayProbeLlm();
    const thinkingDeltas: string[] = [];
    history.addUserText("inspect");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
        onThinking: (delta) => thinkingDeltas.push(delta.delta),
      });

      expect(result.status).toBe("completed");
      expect(thinkingDeltas).toEqual(["hidden deliberation"]);
      expect(llm.observedSecondRequest).toContain("visible assistant text");
      expect(llm.observedSecondRequest).not.toContain("hidden deliberation");
    } finally {
      hub.shutdown();
    }
  });

  test("runs idempotent non-dangerous affordance calls concurrently and preserves result order", async () => {
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let firstSawSecondStarted = false;
    const invocationOrder: string[] = [];

    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        read_a: action(
          async () => {
            invocationOrder.push("a");
            firstSawSecondStarted = await Promise.race([
              secondStartedPromise.then(() => true),
              sleep(100).then(() => false),
            ]);
            return { value: "a", firstSawSecondStarted };
          },
          {
            label: "Read A",
            description: "Read A.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        read_b: action(
          async () => {
            invocationOrder.push("b");
            secondStarted();
            return { value: "b" };
          },
          {
            label: "Read B",
            description: "Read B.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
    }));

    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new ToolBatchProbeLlm([
      {
        type: "tool_use",
        id: "call-a",
        name: "demo__workspace__read_a",
        input: {},
      },
      {
        type: "tool_use",
        id: "call-b",
        name: "demo__workspace__read_b",
        input: {},
      },
    ]);
    history.addUserText("read both values");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
      });

      expect(result.status).toBe("completed");
      expect(firstSawSecondStarted).toBe(true);
      expect(invocationOrder).toEqual(["a", "b"]);
      expect(llm.observedToolResults.map((toolResult) => toolResult.toolUseId)).toEqual([
        "call-a",
        "call-b",
      ]);
    } finally {
      hub.shutdown();
    }
  });

  test("keeps non-idempotent affordance calls sequential", async () => {
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let firstSawSecondStarted = false;
    const invocationOrder: string[] = [];

    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        write_a: action(
          async () => {
            invocationOrder.push("a");
            firstSawSecondStarted = await Promise.race([
              secondStartedPromise.then(() => true),
              sleep(60).then(() => false),
            ]);
            return { value: "a", firstSawSecondStarted };
          },
          {
            label: "Write A",
            description: "Write A.",
            estimate: "fast",
          },
        ),
        write_b: action(
          async () => {
            invocationOrder.push("b");
            secondStarted();
            return { value: "b" };
          },
          {
            label: "Write B",
            description: "Write B.",
            estimate: "fast",
          },
        ),
      },
    }));

    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new ToolBatchProbeLlm([
      {
        type: "tool_use",
        id: "call-a",
        name: "demo__workspace__write_a",
        input: {},
      },
      {
        type: "tool_use",
        id: "call-b",
        name: "demo__workspace__write_b",
        input: {},
      },
    ]);
    history.addUserText("write both values");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
      });

      expect(result.status).toBe("completed");
      expect(firstSawSecondStarted).toBe(false);
      expect(invocationOrder).toEqual(["a", "b"]);
      expect(llm.observedToolResults.map((toolResult) => toolResult.toolUseId)).toEqual([
        "call-a",
        "call-b",
      ]);
    } finally {
      hub.shutdown();
    }
  });
});

describe("runLoop content_ref images", () => {
  const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x42)]);

  function captureServer(uri: string) {
    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("camera", () => ({
      type: "sensor",
      actions: {
        capture: action(
          async () => ({
            ok: true,
            content_ref: { type: "binary", mime: "image/jpeg", summary: "frame", uri },
          }),
          {
            label: "Capture",
            description: "Take a still photo.",
            estimate: "fast",
          },
        ),
      },
    }));
    return server;
  }

  class RequestProbeLlm implements LlmAdapter {
    calls = 0;
    observedToolResults: ToolResultContentBlock[] = [];
    observedSecondMessages: ConversationMessage[] = [];

    async chat(options: LlmChatOptions): Promise<LlmResponse> {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          content: [
            { type: "tool_use", id: "call-capture", name: "demo__camera__capture", input: {} },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      this.observedSecondMessages = options.messages;
      this.observedToolResults = options.messages
        .flatMap((message) => message.content)
        .filter((block): block is ToolResultContentBlock => block.type === "tool_result");
      return {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  async function runCapture(uri: string, config = TEST_CONFIG, imageRegistry?: ImageRegistry) {
    const server = captureServer(uri);
    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      config,
    );
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    const llm = new RequestProbeLlm();
    history.addUserText("what do you see?");
    try {
      await hub.connect();
      await runLoop({ config, hub, history, llm, imageRegistry });
    } finally {
      hub.shutdown();
    }
    return llm;
  }

  test("registers a file:// image content_ref and attaches it to the trail", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loop-content-ref-"));
    try {
      const jpegPath = path.join(dir, "frame.jpg");
      writeFileSync(jpegPath, JPEG_BYTES);
      const registry = new ImageRegistry({ maxLoaded: 4, defaultTtlTurns: 3, maxStored: 16 });

      const llm = await runCapture(pathToFileURL(jpegPath).href, TEST_CONFIG, registry);

      expect(llm.observedToolResults).toHaveLength(1);
      expect(llm.observedToolResults[0]?.content).toContain(
        "[image registered as /gallery/img-1 (loaded, ttl 3) — describe it before it unloads]",
      );

      const registered = registry.get("img-1");
      expect(registered?.source).toBe("tool:demo:/camera");
      expect(registered?.summary).toBe("frame");

      // The trail (last user message) carries caption + image block.
      const trail = llm.observedSecondMessages.at(-1);
      expect(trail?.role).toBe("user");
      const blocks = trail?.content ?? [];
      const captionIndex = blocks.findIndex(
        (block) => block.type === "text" && block.text.startsWith("image /gallery/img-1"),
      );
      expect(captionIndex).toBeGreaterThan(0);
      expect(blocks[captionIndex + 1]).toEqual({
        type: "image",
        mediaType: "image/jpeg",
        data: JPEG_BYTES.toString("base64"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips oversized files and non-file URIs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loop-content-ref-"));
    try {
      const jpegPath = path.join(dir, "frame.jpg");
      writeFileSync(jpegPath, JPEG_BYTES);
      const smallCap = createTestConfig({
        agent: { maxIterations: 3, toolResultImageMaxBytes: 16 },
      });

      const cappedRegistry = new ImageRegistry({ maxLoaded: 4, defaultTtlTurns: 3, maxStored: 16 });
      const oversized = await runCapture(pathToFileURL(jpegPath).href, smallCap, cappedRegistry);
      expect(oversized.observedToolResults[0]?.content).not.toContain("image registered");
      expect(cappedRegistry.list()).toHaveLength(0);

      const remoteRegistry = new ImageRegistry({ maxLoaded: 4, defaultTtlTurns: 3, maxStored: 16 });
      const remote = await runCapture("http://example.com/frame.jpg", TEST_CONFIG, remoteRegistry);
      expect(remote.observedToolResults[0]?.content).not.toContain("image registered");
      expect(remoteRegistry.list()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a registry, content_refs are not materialized", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loop-content-ref-"));
    try {
      const jpegPath = path.join(dir, "frame.jpg");
      writeFileSync(jpegPath, JPEG_BYTES);

      const llm = await runCapture(pathToFileURL(jpegPath).href);

      expect(llm.observedToolResults[0]?.content).not.toContain("image registered");
      const trail = llm.observedSecondMessages.at(-1);
      expect(trail?.content.some((block) => block.type === "image")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

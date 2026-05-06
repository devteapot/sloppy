import { describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import { type AgentToolEvent, runLoop, truncateToolResult } from "../src/core/loop";
import type {
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../src/llm/types";
import { InProcessTransport } from "../src/providers/builtin/in-process";

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    profiles: [],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 3,
    contextBudgetTokens: 24000,
    minSalience: 0.2,
    overviewDepth: 2,
    overviewMaxNodes: 200,
    detailDepth: 4,
    detailMaxNodes: 200,
    historyTurns: 8,
    toolResultMaxChars: 16000,
  },
  maxToolResultSize: 4096,
  providers: {
    builtin: {
      terminal: false,
      filesystem: false,
      memory: false,
      skills: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
      metaRuntime: false,
      spec: false,
      vision: false,
    },
    discovery: {
      enabled: false,
      paths: [],
    },
    terminal: {
      cwd: ".",
      historyLimit: 10,
      syncTimeoutMs: 30000,
    },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: {
      maxMemories: 500,
      defaultWeight: 0.5,
      compactThreshold: 0.2,
    },
    skills: {
      skillsDir: "~/.sloppy/skills",
    },
    web: {
      historyLimit: 20,
    },
    browser: {
      viewportWidth: 1280,
      viewportHeight: 720,
    },
    cron: {
      maxJobs: 50,
    },
    messaging: {
      maxMessages: 500,
    },
    delegation: {
      maxAgents: 10,
    },
    metaRuntime: { globalRoot: "~/.sloppy/meta-runtime", workspaceRoot: ".sloppy/meta-runtime" },
    vision: {
      maxImages: 50,
      defaultWidth: 512,
      defaultHeight: 512,
    },
  },
};

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
    expect(output).toContain("slop_query_state");
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
          kind: "builtin",
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
          kind: "builtin",
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
          kind: "builtin",
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

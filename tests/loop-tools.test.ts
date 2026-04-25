import { describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import { type AgentToolEvent, runLoop, truncateToolResult } from "../src/core/loop";
import type { LlmAdapter, LlmChatOptions, LlmResponse } from "../src/llm/types";
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
    orchestratorMode: false,
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
      orchestration: false,
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
      skillsDir: "~/.hermes/skills",
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
    orchestration: {
      progressTailMaxChars: 2048,
    },
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

class SingleToolCallLlm implements LlmAdapter {
  calls = 0;
  observedSecondRequest = "";

  constructor(
    private readonly toolUse: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    },
  ) {}

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: this.toolUse.id,
            name: this.toolUse.name,
            input: this.toolUse.input,
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

function orchestratorConfig(): SloppyConfig {
  return {
    ...TEST_CONFIG,
    agent: {
      ...TEST_CONFIG.agent,
      orchestratorMode: true,
    },
  };
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

  test("blocks orchestrator-mode filesystem mutations before provider invocation", async () => {
    let providerInvocations = 0;
    const server = createSlopServer({ id: "filesystem", name: "Filesystem" });
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        edit: action(
          {
            path: "string",
            edits: {
              type: "array",
              items: { type: "object" },
            },
          },
          async () => {
            providerInvocations += 1;
            return { ok: true };
          },
          {
            label: "Edit",
            description: "Edit a file.",
            estimate: "instant",
          },
        ),
      },
    }));

    const config = orchestratorConfig();
    const hub = new ConsumerHub(
      [
        {
          id: "filesystem",
          name: "Filesystem",
          kind: "builtin",
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
    const llm = new SingleToolCallLlm({
      id: "edit-file",
      name: "filesystem__workspace__edit",
      input: {
        path: "src/App.tsx",
        edits: [{ oldText: "a", newText: "b" }],
      },
    });
    const events: AgentToolEvent[] = [];
    history.addUserText("fix the file");

    try {
      await hub.connect();
      const result = await runLoop({
        config,
        hub,
        history,
        llm,
        onToolEvent: (event) => events.push(event),
      });

      expect(result.status).toBe("completed");
      expect(providerInvocations).toBe(0);
      expect(llm.observedSecondRequest).toContain("Orchestrator mode cannot call filesystem.edit");
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "completed",
          status: "error",
          errorCode: "orchestrator_tool_restricted",
        }),
      );
    } finally {
      hub.shutdown();
    }
  });

  test("blocks orchestrator-mode setup commands but allows simple verification commands", async () => {
    const invokedCommands: string[] = [];
    const server = createSlopServer({ id: "terminal", name: "Terminal" });
    server.register("session", () => ({
      type: "context",
      actions: {
        execute: action(
          { command: "string" },
          async ({ command }) => {
            invokedCommands.push(command as string);
            return { exitCode: 0, stdout: "ok" };
          },
          {
            label: "Execute",
            description: "Run a shell command.",
            estimate: "fast",
          },
        ),
      },
    }));

    const config = orchestratorConfig();
    const hub = new ConsumerHub(
      [
        {
          id: "terminal",
          name: "Terminal",
          kind: "builtin",
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
    const llm = new SingleToolCallLlm({
      id: "install",
      name: "terminal__session__execute",
      input: { command: "npm install" },
    });
    const events: AgentToolEvent[] = [];
    history.addUserText("install dependencies");

    try {
      await hub.connect();
      await runLoop({
        config,
        hub,
        history,
        llm,
        onToolEvent: (event) => events.push(event),
      });

      expect(invokedCommands).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "completed",
          status: "error",
          errorCode: "orchestrator_tool_restricted",
        }),
      );

      const safeHistory = new ConversationHistory({
        historyTurns: config.agent.historyTurns,
        toolResultMaxChars: config.agent.toolResultMaxChars,
      });
      safeHistory.addUserText("verify build");
      const safeLlm = new SingleToolCallLlm({
        id: "build",
        name: "terminal__session__execute",
        input: { command: "npm run build" },
      });
      await runLoop({
        config,
        hub,
        history: safeHistory,
        llm: safeLlm,
      });
      expect(invokedCommands).toEqual(["npm run build"]);
    } finally {
      hub.shutdown();
    }
  });

  test("blocks orchestrator-mode direct delegation spawns", async () => {
    let providerInvocations = 0;
    const server = createSlopServer({ id: "delegation", name: "Delegation" });
    server.register("session", () => ({
      type: "context",
      actions: {
        spawn_agent: action(
          { name: "string", goal: "string", task_id: "string" },
          async () => {
            providerInvocations += 1;
            return { id: "agent-1" };
          },
          {
            label: "Spawn Agent",
            description: "Spawn a child agent.",
            estimate: "fast",
          },
        ),
      },
    }));

    const config = orchestratorConfig();
    const hub = new ConsumerHub(
      [
        {
          id: "delegation",
          name: "Delegation",
          kind: "builtin",
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
    const llm = new SingleToolCallLlm({
      id: "spawn",
      name: "delegation__session__spawn_agent",
      input: { name: "worker", goal: "do work", task_id: "task-12345678" },
    });
    const events: AgentToolEvent[] = [];
    history.addUserText("start the task");

    try {
      await hub.connect();
      await runLoop({
        config,
        hub,
        history,
        llm,
        onToolEvent: (event) => events.push(event),
      });

      expect(providerInvocations).toBe(0);
      expect(llm.observedSecondRequest).toContain(
        "Orchestrator mode does not spawn delegation agents directly",
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "completed",
          status: "error",
          errorCode: "orchestrator_tool_restricted",
        }),
      );
    } finally {
      hub.shutdown();
    }
  });
});

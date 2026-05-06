import { describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import type { AgentToolEvent } from "../src/core/loop";
import { runLoop } from "../src/core/loop";
import type { LlmAdapter, LlmChatOptions, LlmResponse } from "../src/llm/types";
import { LlmAbortError } from "../src/llm/types";
import { DelegationProvider } from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { createAwaitChildrenHook, createDelegationWaitTool } from "../src/runtime/delegation";

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    profiles: [],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 4,
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
      delegation: true,
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

class SuspendProbeLlm implements LlmAdapter {
  readonly callTimes: number[] = [];
  readonly snapshots: string[] = [];

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.callTimes.push(Date.now());
    this.snapshots.push(
      options.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );

    if (this.callTimes.length === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: "spawn-1",
            name: "delegation__session__spawn_agent",
            input: {
              name: "worker",
              goal: "finish asynchronously",
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    return {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

class ExplicitWaitProbeLlm implements LlmAdapter {
  readonly callTimes: number[] = [];
  readonly snapshots: string[] = [];
  private agentId: string | null = null;

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.callTimes.push(Date.now());
    const text = options.messages
      .flatMap((message) => message.content)
      .map((block) =>
        block.type === "text" ? block.text : block.type === "tool_result" ? block.content : "",
      )
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    this.snapshots.push(text);

    if (this.callTimes.length === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: "spawn-1",
            name: "delegation__session__spawn_agent",
            input: {
              name: "worker",
              goal: "finish asynchronously",
            },
          },
          {
            type: "tool_use",
            id: "mark-1",
            name: "probe__session__mark",
            input: {
              label: "parent-kept-working",
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    if (this.callTimes.length === 2) {
      const match = text.match(/"id":\s*"(agent-[^"]+)"/);
      this.agentId = match?.[1] ?? null;
      expect(this.agentId).toBeString();
      return {
        content: [
          {
            type: "tool_use",
            id: "wait-1",
            name: "slop_wait_for_delegation_event",
            input: {
              agent_ids: [this.agentId],
              timeout_ms: 2000,
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    return {
      content: [{ type: "text", text: "joined" }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

class AbortWaitLlm implements LlmAdapter {
  constructor(private readonly agentId: string) {}

  async chat(): Promise<LlmResponse> {
    return {
      content: [
        {
          type: "tool_use",
          id: "wait-abort",
          name: "slop_wait_for_delegation_event",
          input: {
            agent_ids: [this.agentId],
            timeout_ms: 10_000,
          },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

function createProbeProvider() {
  const server = createSlopServer({ id: "probe", name: "Probe" });
  const marks: string[] = [];

  server.register("session", () => ({
    type: "context",
    props: {
      count: marks.length,
    },
    actions: {
      mark: action(
        {
          label: "string",
        },
        async ({ label }) => {
          marks.push(String(label));
          return { marks: [...marks] };
        },
        {
          label: "Mark",
          description: "Record that the parent did useful work before joining children.",
          estimate: "instant",
        },
      ),
    },
  }));

  return { server, marks };
}

describe("runLoop delegated work suspension", () => {
  test("waits for delegation state patches instead of polling agent status", async () => {
    const delegation = new DelegationProvider({
      runnerFactory: (spawn, callbacks) => {
        let runningTimeout: ReturnType<typeof setTimeout> | undefined;
        let completedTimeout: ReturnType<typeof setTimeout> | undefined;

        return {
          async start() {
            callbacks.onUpdate({ status: "pending", turn_state: "idle" });
            runningTimeout = setTimeout(() => callbacks.onUpdate({ status: "running" }), 10);
            completedTimeout = setTimeout(
              () =>
                callbacks.onUpdate({
                  status: "completed",
                  result: `completed ${spawn.name}`,
                  completed_at: new Date().toISOString(),
                }),
              80,
            );
          },
          async cancel() {
            if (runningTimeout) clearTimeout(runningTimeout);
            if (completedTimeout) clearTimeout(completedTimeout);
            callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
          },
        };
      },
    });
    const hub = new ConsumerHub(
      [
        {
          id: "delegation",
          name: "Delegation",
          kind: "builtin",
          transport: new InProcessTransport(delegation.server),
          transportLabel: "in-process",
          stop: () => delegation.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new SuspendProbeLlm();
    history.addUserText("spawn a worker");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
        hooks: { beforeNextTurn: createAwaitChildrenHook() },
      });

      expect(result.status).toBe("completed");
      expect(llm.callTimes).toHaveLength(2);
      const firstCall = llm.callTimes[0];
      const secondCall = llm.callTimes[1];
      expect(typeof firstCall).toBe("number");
      expect(typeof secondCall).toBe("number");
      expect((secondCall ?? 0) - (firstCall ?? 0)).toBeGreaterThanOrEqual(70);
      expect(llm.snapshots[1] ?? "").toContain('status="completed"');
    } finally {
      hub.shutdown();
    }
  });

  test("wait tool parks until a child event after parent-side work", async () => {
    const delegation = new DelegationProvider({
      runnerFactory: (spawn, callbacks) => {
        let runningTimeout: ReturnType<typeof setTimeout> | undefined;
        let completedTimeout: ReturnType<typeof setTimeout> | undefined;

        return {
          async start() {
            runningTimeout = setTimeout(() => callbacks.onUpdate({ status: "running" }), 10);
            completedTimeout = setTimeout(
              () =>
                callbacks.onUpdate({
                  status: "completed",
                  result: `completed ${spawn.name}`,
                  turn_state: "idle",
                  completed_at: new Date().toISOString(),
                }),
              90,
            );
          },
          async cancel() {
            if (runningTimeout) clearTimeout(runningTimeout);
            if (completedTimeout) clearTimeout(completedTimeout);
            callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
          },
        };
      },
    });
    const probe = createProbeProvider();
    const hub = new ConsumerHub(
      [
        {
          id: "delegation",
          name: "Delegation",
          kind: "builtin",
          transport: new InProcessTransport(delegation.server),
          transportLabel: "in-process",
          stop: () => delegation.stop(),
        },
        {
          id: "probe",
          name: "Probe",
          kind: "builtin",
          transport: new InProcessTransport(probe.server),
          transportLabel: "in-process",
          stop: () => probe.server.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const llm = new ExplicitWaitProbeLlm();
    const toolEvents: AgentToolEvent[] = [];
    history.addUserText("spawn a worker, keep working, then join");

    try {
      await hub.connect();
      const result = await runLoop({
        config: TEST_CONFIG,
        hub,
        history,
        llm,
        hooks: { localTools: () => [createDelegationWaitTool()] },
        onToolEvent: (event) => toolEvents.push(event),
      });

      expect(result.status).toBe("completed");
      expect(probe.marks).toEqual(["parent-kept-working"]);
      expect(llm.callTimes).toHaveLength(3);
      expect((llm.callTimes[2] ?? 0) - (llm.callTimes[1] ?? 0)).toBeGreaterThanOrEqual(70);
      expect(llm.snapshots[2] ?? "").toContain('"event_type": "completed"');
      expect(
        toolEvents.some(
          (event) =>
            event.kind === "started" &&
            event.invocation.kind === "observation" &&
            event.invocation.providerId === "delegation" &&
            event.invocation.path === "/agents",
        ),
      ).toBe(false);
    } finally {
      hub.shutdown();
    }
  });

  test("wait tool aborts when the parent turn is cancelled", async () => {
    let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
    const delegation = new DelegationProvider({
      runnerFactory: (_spawn, callbacks) => ({
        async start() {
          callbacks.onUpdate({ status: "running" });
        },
        async cancel() {
          if (cancelTimeout) clearTimeout(cancelTimeout);
          callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
        },
      }),
    });
    const hub = new ConsumerHub(
      [
        {
          id: "delegation",
          name: "Delegation",
          kind: "builtin",
          transport: new InProcessTransport(delegation.server),
          transportLabel: "in-process",
          stop: () => delegation.stop(),
        },
      ],
      TEST_CONFIG,
    );
    const history = new ConversationHistory({
      historyTurns: TEST_CONFIG.agent.historyTurns,
      toolResultMaxChars: TEST_CONFIG.agent.toolResultMaxChars,
    });
    const abortController = new AbortController();

    try {
      await hub.connect();
      const spawn = await hub.invoke("delegation", "/session", "spawn_agent", {
        name: "long-worker",
        goal: "stay running",
      });
      expect(spawn.status).toBe("ok");
      const agentId = (spawn.data as { id: string }).id;
      history.addUserText("wait for child");

      cancelTimeout = setTimeout(() => abortController.abort(), 40);
      await expect(
        runLoop({
          config: TEST_CONFIG,
          hub,
          history,
          llm: new AbortWaitLlm(agentId),
          signal: abortController.signal,
          hooks: { localTools: () => [createDelegationWaitTool()] },
        }),
      ).rejects.toBeInstanceOf(LlmAbortError);
    } finally {
      if (cancelTimeout) clearTimeout(cancelTimeout);
      hub.shutdown();
    }
  });
});

import { describe, expect, test } from "bun:test";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import { runLoop } from "../src/core/loop";
import type { LlmAdapter, LlmChatOptions, LlmResponse } from "../src/llm/types";
import { DelegationProvider } from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";

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
      delegation: true,
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

describe("runLoop delegated work suspension", () => {
  test("waits for delegation state patches instead of polling agent status", async () => {
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
});

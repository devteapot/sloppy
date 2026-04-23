import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import { Agent } from "../src/core/agent";
import type { ExternalProviderState } from "../src/core/consumer";

const tempPaths: string[] = [];

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    profiles: [],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 12,
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
      orchestration: false,
      vision: false,
    },
    discovery: {
      enabled: true,
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

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }

    await rm(path, { recursive: true, force: true });
  }
});

describe("Agent", () => {
  test("ignores the current session provider descriptor while tracking other external providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sloppy-agent-"));
    tempPaths.push(directory);

    await writeFile(
      join(directory, "self.json"),
      JSON.stringify({
        id: "sloppy-session-self",
        name: "Sloppy Agent Session",
        transport: {
          type: "unix",
          path: "/tmp/slop/sloppy-session-self.sock",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(directory, "native-demo.json"),
      JSON.stringify({
        id: "native-demo",
        name: "Native Demo",
        transport: {
          type: "unix",
          path: "/tmp/slop/native-demo.sock",
        },
      }),
      "utf8",
    );

    let lastStates: ExternalProviderState[] = [];
    const agent = new Agent({
      config: {
        ...TEST_CONFIG,
        providers: {
          ...TEST_CONFIG.providers,
          discovery: {
            enabled: true,
            paths: [directory],
          },
        },
      },
      ignoredProviderIds: ["sloppy-session-self"],
      onExternalProviderStates: (states) => {
        lastStates = states;
      },
    });

    try {
      await agent.start();

      expect(lastStates).toEqual([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/slop/native-demo.sock",
          status: "error",
          lastError: expect.stringContaining("Unix socket connection failed:"),
        },
      ]);
    } finally {
      agent.shutdown();
    }
  });
});

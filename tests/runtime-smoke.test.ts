import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import { runRuntimeSmoke } from "../src/runtime/smoke-runner";

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
      metaRuntime: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
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
    metaRuntime: {
      globalRoot: "~/.sloppy/meta-runtime",
      workspaceRoot: ".sloppy/meta-runtime",
    },
    vision: {
      maxImages: 50,
      defaultWidth: 512,
      defaultHeight: 512,
    },
  },
};

describe("runtime smoke runner", () => {
  test("runs provider-level meta-runtime routing end-to-end", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-test-"));
    try {
      const result = await runRuntimeSmoke({
        config: TEST_CONFIG,
        mode: "providers",
        workspaceRoot,
      });

      expect(result.mode).toBe("providers");
      expect(result.proposalId).toStartWith("proposal-");
      expect(result.channelId).toBeString();
      expect(result.channelId.length).toBeGreaterThan(0);
      expect(result.channelHistory).toHaveLength(1);
      expect(result.channelHistory[0]).toMatchObject({
        content: "runtime smoke: verify typed envelope routing",
        envelope: {
          id: "smoke-message",
          source: "root",
          body: "runtime smoke: verify typed envelope routing",
          topic: "runtime-smoke",
          metadata: { mode: "providers" },
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

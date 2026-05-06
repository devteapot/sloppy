import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import { runRuntimeDoctor } from "../src/runtime/doctor-runner";

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
    discovery: { enabled: false, paths: [] },
    terminal: { cwd: ".", historyLimit: 10, syncTimeoutMs: 30000 },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: { maxMemories: 500, defaultWeight: 0.5, compactThreshold: 0.2 },
    skills: { skillsDir: "~/.hermes/skills" },
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: {
      maxAgents: 10,
      cli: {
        enabled: true,
        adapters: {
          fake: { command: ["node", "--version"] },
        },
      },
    },
    metaRuntime: {
      globalRoot: "~/.sloppy/meta-runtime",
      workspaceRoot: ".sloppy/meta-runtime",
    },
    vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
  },
};

describe("runtime doctor", () => {
  test("reports skipped optional checks and validates configured CLI adapter", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-"));
    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        cliAdapterId: "fake",
        workspaceRoot,
      });

      expect(result.workspaceRoot).toBe(workspaceRoot);
      expect(result.checks).toContainEqual({
        id: "litellm",
        status: "skipped",
        summary: "No OpenAI-compatible base URL provided.",
      });
      expect(result.checks).toContainEqual({
        id: "acp",
        status: "skipped",
        summary: "No ACP adapter id provided.",
      });
      expect(result.checks).toContainEqual({
        id: "cli",
        status: "ok",
        summary: "CLI adapter 'fake' command is configured.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { SubAgentRunner } from "../src/runtime/delegation";

const TEST_CONFIG: SloppyConfig = {
  llm: { provider: "openai", model: "gpt-5.4", profiles: [], maxTokens: 4096 },
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
      metaRuntime: false,
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
    skills: { skillsDir: "~/.sloppy/skills" },
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: { maxAgents: 10 },
    metaRuntime: { globalRoot: "~/.sloppy/meta-runtime", workspaceRoot: ".sloppy/meta-runtime" },
    vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
  },
};

const readyState = {
  status: "ready" as const,
  message: "ready",
  activeProfileId: "stub",
  selectedProvider: "openai" as const,
  selectedModel: "stub-model",
  secureStoreKind: "memory" as const,
  secureStoreStatus: "ready" as const,
  profiles: [
    {
      id: "stub",
      label: "Stub",
      provider: "openai" as const,
      model: "stub-model",
      apiKeyEnv: "STUB_KEY",
      baseUrl: undefined,
      isDefault: true,
      hasKey: true,
      keySource: "env" as const,
      ready: true,
      managed: true,
      origin: "managed" as const,
      canDeleteProfile: false,
      canDeleteApiKey: false,
    },
  ],
};

const stubLlmProfileManager = {
  ensureReady: async () => readyState,
  getState: async () => readyState,
  getConfig: () => TEST_CONFIG,
  updateConfig: () => undefined,
  createAdapter: async () => ({
    async chat() {
      throw new Error("stubLlmProfileManager.createAdapter should not be reached");
    },
  }),
} as unknown as import("../src/llm/profile-manager").LlmProfileManager;

describe("kernel boundary: sub-agent runs with the lean child runtime", () => {
  test("SubAgentRunner passes the delegated goal through unchanged", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-boundary-"));
    try {
      const config: SloppyConfig = {
        ...TEST_CONFIG,
        providers: {
          ...TEST_CONFIG.providers,
          filesystem: { ...TEST_CONFIG.providers.filesystem, root: workspaceRoot },
        },
      };

      const hub = new ConsumerHub([], config);
      await hub.connect();

      const observed: string[] = [];
      let capturedPrompt = "";

      const runner = new SubAgentRunner({
        id: "boundary-1",
        name: "boundary",
        goal: "boundary goal",
        parentHub: hub,
        parentConfig: config,
        llmProfileManager: stubLlmProfileManager,
        agentFactory: (callbacks) => ({
          async start() {},
          async chat(userMessage: string) {
            capturedPrompt = userMessage;
            callbacks.onText?.("done");
            return { status: "completed" as const, response: "done" };
          },
          async resumeWithToolResult(): Promise<never> {
            throw new Error("not used");
          },
          async invokeProvider(): Promise<never> {
            throw new Error("not used");
          },
          async resolveApprovalDirect(): Promise<never> {
            throw new Error("not used");
          },
          rejectApprovalDirect() {},
          cancelActiveTurn() {
            return false;
          },
          clearPendingApproval() {},
          shutdown() {},
        }),
      });

      runner.onChange((event) => {
        observed.push(event.status);
      });

      await runner.start();

      // Wait for completion via store sync.
      const start = Date.now();
      while (Date.now() - start < 2000) {
        if (observed.includes("completed") || observed.includes("failed")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(capturedPrompt).toBe("boundary goal");
      expect(observed).toContain("completed");
      expect(observed).not.toContain("failed");
      runner.shutdown();
      hub.shutdown();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

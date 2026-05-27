import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { SubAgentRunner } from "../src/plugins/first-party/delegation/runtime";
import { createTestConfig } from "./helpers/config";

const TEST_CONFIG = createTestConfig();

const readyState = {
  status: "ready" as const,
  message: "ready",
  activeProfileId: "stub",
  selectedEndpointId: "openai" as const,
  selectedProtocol: "openai-chat" as const,
  selectedModel: "stub-model",
  secureStoreKind: "memory" as const,
  secureStoreStatus: "ready" as const,
  profiles: [
    {
      kind: "native" as const,
      id: "stub",
      label: "Stub",
      endpointId: "openai" as const,
      protocol: "openai-chat" as const,
      model: "stub-model",
      authEnv: "STUB_KEY",
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
        plugins: {
          ...TEST_CONFIG.plugins,
          delegation: {
            ...TEST_CONFIG.plugins.delegation,
            enabled: true,
          },
          "meta-runtime": {
            ...TEST_CONFIG.plugins["meta-runtime"],
            enabled: true,
          },
          cron: {
            ...TEST_CONFIG.plugins.cron,
            enabled: true,
          },
          messaging: {
            ...TEST_CONFIG.plugins.messaging,
            enabled: true,
          },
          filesystem: {
            ...TEST_CONFIG.plugins.filesystem,
            root: workspaceRoot,
          },
        },
      };

      const hub = new ConsumerHub([], config);
      await hub.connect();

      const observed: string[] = [];
      let capturedPrompt = "";
      let capturedPlugins: SloppyConfig["plugins"] | undefined;

      const runner = new SubAgentRunner({
        id: "boundary-1",
        name: "boundary",
        goal: "boundary goal",
        parentHub: hub,
        parentConfig: config,
        llmProfileManager: stubLlmProfileManager,
        agentFactory: (callbacks, childConfig) => {
          capturedPlugins = childConfig.plugins;
          return {
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
          };
        },
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
      expect(capturedPlugins?.delegation.enabled).toBe(false);
      expect(capturedPlugins?.["meta-runtime"].enabled).toBe(false);
      expect(capturedPlugins?.cron.enabled).toBe(false);
      expect(capturedPlugins?.messaging.enabled).toBe(false);
      expect(observed).toContain("completed");
      expect(observed).not.toContain("failed");
      runner.shutdown();
      hub.shutdown();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

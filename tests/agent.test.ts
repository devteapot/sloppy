import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent";
import type { ExternalProviderState } from "../src/core/consumer";
import type { CredentialStore } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { createTestConfig } from "./helpers/config";

const tempPaths: string[] = [];

const TEST_CONFIG = createTestConfig({ discovery: { enabled: true } });

class EmptyCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  async getStatus() {
    return "available" as const;
  }

  async get(): Promise<null> {
    return null;
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}
}

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
  test("public composition supplies delegated child-session construction", async () => {
    const config = createTestConfig({
      llm: {
        defaultProfileId: "delegation-test",
        profiles: [
          {
            kind: "native",
            id: "delegation-test",
            endpointId: "delegation-test",
            model: "test-model",
          },
        ],
        endpoints: {
          "delegation-test": {
            protocol: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            auth: { type: "secure_store" },
            models: { "test-model": {} },
          },
        },
      },
      plugins: {
        delegation: { enabled: true },
        filesystem: { root: process.cwd() },
      },
    });
    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new EmptyCredentialStore(),
      writeConfig: async () => undefined,
    });
    const agent = new Agent({
      config,
      llmProfileManager,
    });

    try {
      await agent.start();
      const result = await agent.invokeProvider("delegation", "/session", "spawn_agent", {
        name: "public-agent-child",
        goal: "Confirm the child session can be constructed.",
      });

      expect(result.status).toBe("ok");
      expect(result.data).toMatchObject({ status: "pending" });
      const childId = (result.data as { id: string }).id;
      let childStatus: unknown;
      let childError: unknown;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const child = await agent.queryProvider("delegation", `/agents/${childId}`, { depth: 1 });
        childStatus = child.properties?.status;
        childError = child.properties?.error;
        if (childStatus === "failed") break;
        await Bun.sleep(10);
      }
      expect(childStatus).toBe("failed");
      expect(String(childError)).not.toContain("child session runtime factory");
    } finally {
      agent.shutdown();
    }
  });

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
          status: "unloaded",
        },
      ]);
      const apps = await agent.queryProvider("apps", "/available", { depth: 2 });
      expect(apps.properties).toMatchObject({
        count: 1,
        unloaded_count: 1,
      });
      expect(apps.children?.[0]?.properties).toMatchObject({
        provider_id: "native-demo",
        status: "unloaded",
      });
    } finally {
      agent.shutdown();
    }
  });
});

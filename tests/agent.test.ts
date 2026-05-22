import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/core/agent";
import type { ExternalProviderState } from "../src/core/consumer";
import { createTestConfig } from "./helpers/config";

const tempPaths: string[] = [];

const TEST_CONFIG = createTestConfig({ discovery: { enabled: true } });

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

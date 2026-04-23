import { describe, expect, test } from "bun:test";
import { createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import type { ProviderTreeView } from "../src/core/subscriptions";
import { buildRuntimeToolSet } from "../src/core/tools";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { NodeSocketClientTransport } from "../src/providers/node-socket";
import type { RegisteredProvider } from "../src/providers/registry";

type QueryToolProviderSchema = {
  properties?: {
    provider?: {
      enum?: string[];
    };
  };
};

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

function createProvider(id: string, name: string): RegisteredProvider {
  const server = createSlopServer({ id, name });
  server.register("workspace", {
    type: "collection",
    props: { focus: "/" },
  });

  return {
    id,
    name,
    kind: "external",
    transport: new InProcessTransport(server),
    transportLabel: "in-process:test",
  };
}

function createBuiltinProvider(id: string, name: string): RegisteredProvider {
  const server = createSlopServer({ id, name });
  server.register("workspace", {
    type: "collection",
    props: { focus: "/" },
  });

  return {
    id,
    name,
    kind: "builtin",
    transport: new InProcessTransport(server),
    transportLabel: "in-process",
  };
}

describe("ConsumerHub", () => {
  test("adds and removes providers after the initial connection", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);

    try {
      await hub.connect();
      expect(hub.getProviderViews()).toHaveLength(0);

      const connected = await hub.addProvider(createProvider("demo", "Demo"));
      expect(connected).toBe(true);
      expect(hub.getProviderViews().map((view) => view.providerId)).toEqual(["demo"]);
      expect(hub.getExternalProviderStates()).toEqual([
        {
          id: "demo",
          name: "Demo",
          transport: "in-process:test",
          status: "connected",
        },
      ]);

      const queryTool = hub
        .getRuntimeToolSet()
        .tools.find((tool) => tool.function.name === "slop_query_state");
      const providerSchema = (queryTool?.function.parameters as QueryToolProviderSchema | undefined)
        ?.properties?.provider;

      expect(queryTool?.function.name).toBe("slop_query_state");
      expect(providerSchema?.enum).toContain("demo");

      hub.removeProvider("demo");
      expect(hub.getProviderViews()).toHaveLength(0);
      expect(hub.getExternalProviderStates()).toEqual([]);

      const queryToolAfterRemoval = hub
        .getRuntimeToolSet()
        .tools.find((tool) => tool.function.name === "slop_query_state");
      const providerSchemaAfterRemoval = (
        queryToolAfterRemoval?.function.parameters as QueryToolProviderSchema | undefined
      )?.properties?.provider;

      expect(providerSchemaAfterRemoval?.enum).not.toContain("demo");
    } finally {
      hub.shutdown();
    }
  });

  test("tracks external provider connection errors", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);

    try {
      await hub.connect();

      const connected = await hub.addProvider({
        id: "missing-socket",
        name: "Missing Socket",
        kind: "external",
        transport: new NodeSocketClientTransport(`/tmp/sloppy-missing-${crypto.randomUUID()}.sock`),
        transportLabel: "unix:/tmp/missing.sock",
      });

      expect(connected).toBe(false);
      expect(hub.getProviderViews()).toHaveLength(0);
      expect(hub.getExternalProviderStates()).toEqual([
        {
          id: "missing-socket",
          name: "Missing Socket",
          transport: "unix:/tmp/missing.sock",
          status: "error",
          lastError: expect.stringContaining("Unix socket connection failed:"),
        },
      ]);

      hub.removeProvider("missing-socket");
      expect(hub.getExternalProviderStates()).toEqual([]);
    } finally {
      hub.shutdown();
    }
  });

  test("does not surface built-in providers in external provider state", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);

    try {
      await hub.connect();

      const connected = await hub.addProvider(createBuiltinProvider("terminal", "Terminal"));

      expect(connected).toBe(true);
      expect(hub.getProviderViews().map((view) => view.providerId)).toEqual(["terminal"]);
      expect(hub.getExternalProviderStates()).toEqual([]);
    } finally {
      hub.shutdown();
    }
  });

  test("skips malformed provider nodes without ids when building runtime tools", () => {
    const view: ProviderTreeView = {
      providerId: "demo",
      providerName: "Demo",
      kind: "external",
      overviewTree: {
        id: "demo",
        type: "collection",
        affordances: [],
        children: [
          {
            id: undefined as unknown as string,
            type: "item",
            affordances: [
              {
                action: "broken",
                label: "Broken",
              },
            ],
          },
          {
            id: "workspace",
            type: "collection",
            affordances: [
              {
                action: "focus",
                label: "Focus",
              },
            ],
          },
        ],
      } as ProviderTreeView["overviewTree"],
    };

    const toolSet = buildRuntimeToolSet([view]);

    expect(toolSet.tools.some((tool) => tool.function.name === "demo__workspace__focus")).toBe(
      true,
    );
  });
});

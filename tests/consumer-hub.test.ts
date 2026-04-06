import { describe, expect, test } from "bun:test";
import { createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { InProcessTransport } from "../src/providers/builtin/in-process";
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
  providers: {
    builtin: {
      terminal: false,
      filesystem: false,
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

      const queryTool = hub
        .getRuntimeToolSet()
        .tools.find((tool) => tool.function.name === "slop_query_state");
      const providerSchema = (queryTool?.function.parameters as QueryToolProviderSchema | undefined)
        ?.properties?.provider;

      expect(queryTool?.function.name).toBe("slop_query_state");
      expect(providerSchema?.enum).toContain("demo");

      hub.removeProvider("demo");
      expect(hub.getProviderViews()).toHaveLength(0);

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
});

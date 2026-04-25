import { describe, expect, spyOn, test } from "bun:test";
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

  test("invoke consults the installed policy and surfaces deny/require_approval decisions", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);

    try {
      await hub.connect();
      await hub.addProvider(createProvider("demo", "Demo"));

      const { CompositePolicy, PolicyDeniedError } = await import("../src/core/policy");

      // Default behavior: allow-all, no policy installed.
      // Install a deny rule and verify it throws.
      const composite = new CompositePolicy();
      composite.add({
        evaluate: (ctx) =>
          ctx.providerId === "demo"
            ? { kind: "deny", reason: "demo provider blocked" }
            : { kind: "allow" },
      });
      hub.setPolicy(composite);

      await expect(hub.invoke("demo", "/workspace", "noop", {})).rejects.toBeInstanceOf(
        PolicyDeniedError,
      );

      // Swap to a require_approval rule; should return an error result with
      // the approval_required code rather than throwing.
      const approvalComposite = new CompositePolicy();
      approvalComposite.add({
        evaluate: () => ({ kind: "require_approval", reason: "needs blessing" }),
      });
      hub.setPolicy(approvalComposite);

      const result = await hub.invoke("demo", "/workspace", "noop", {});
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("approval_required");
      expect(result.error?.message).toContain("needs blessing");
      // Hub should also enqueue an approval into hub.approvals.
      const pending = hub.approvals.list({ providerId: "demo" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe("pending");

      // addPolicyRule on default hub should construct a composite lazily.
      hub.setPolicy(null);
      hub.addPolicyRule({
        evaluate: () => ({ kind: "deny", reason: "added via addPolicyRule" }),
      });
      await expect(hub.invoke("demo", "/workspace", "noop", {})).rejects.toThrow(
        "added via addPolicyRule",
      );
    } finally {
      hub.shutdown();
    }
  });

  test("records dangerous affordances into the registry as trees are observed", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    try {
      await hub.connect();

      const id = "danger-demo";
      const server = createSlopServer({ id, name: "Danger" });
      server.register("session", () => ({
        type: "collection",
        props: {},
        actions: {
          wipe: {
            label: "Wipe",
            dangerous: true,
            handler: async () => ({ ok: true }),
          },
          ping: {
            label: "Ping",
            handler: async () => ({ ok: true }),
          },
        },
      }));

      const provider: RegisteredProvider = {
        id,
        name: "Danger",
        kind: "builtin",
        transport: new InProcessTransport(server),
        transportLabel: "in-process",
      };
      await hub.addProvider(provider);

      // The registry records dangerous affordances regardless of whether the
      // node is currently in a focused detail subtree.
      expect(hub.isDangerousAffordance(id, "/session", "wipe")).toBe(true);
      // Non-dangerous affordances and unknown lookups stay false.
      expect(hub.isDangerousAffordance(id, "/session", "ping")).toBe(false);
      expect(hub.isDangerousAffordance(id, "/nonexistent", "wipe")).toBe(false);
    } finally {
      hub.shutdown();
    }
  });

  test("seeds the dangerous-affordance registry from a deep, unfiltered query", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    try {
      await hub.connect();

      // Build a provider with a dangerous affordance several levels deeper
      // than the overview subscription's depth (overviewDepth: 2 in
      // TEST_CONFIG). Without the addProvider-time deep query, the registry
      // would miss it until the user happened to focus that subtree.
      const id = "deep-danger";
      const server = createSlopServer({ id, name: "Deep" });
      server.register("session", () => ({
        type: "collection",
        props: {},
        children: {
          tasks: {
            type: "collection",
            props: {},
            items: [
              {
                id: "t1",
                props: {},
                actions: {
                  cancel: {
                    label: "Cancel",
                    dangerous: true,
                    handler: async () => ({ ok: true }),
                  },
                },
              },
            ],
          },
        },
      }));

      const provider: RegisteredProvider = {
        id,
        name: "Deep",
        kind: "builtin",
        transport: new InProcessTransport(server),
        transportLabel: "in-process",
      };
      await hub.addProvider(provider);

      expect(hub.isDangerousAffordance(id, "/session/tasks/t1", "cancel")).toBe(true);
    } finally {
      hub.shutdown();
    }
  });

  test("focusState records dangerous affordances and bumps state revision", async () => {
    // Regression: focusState() previously stored the focus snapshot but did
    // not walk it for dangerous affordances or bump the state revision. A
    // dangerous affordance newly visible in the focused subtree could slip
    // past dangerousActionRule until a later patch caught it.
    const hub = new ConsumerHub([], TEST_CONFIG);
    try {
      await hub.connect();

      const id = "focus-danger";
      const server = createSlopServer({ id, name: "FocusDanger" });
      server.register("session", () => ({
        type: "collection",
        props: {},
        actions: {
          destroy: {
            label: "Destroy",
            dangerous: true,
            handler: async () => ({ ok: true }),
          },
        },
      }));

      const provider: RegisteredProvider = {
        id,
        name: "FocusDanger",
        kind: "builtin",
        transport: new InProcessTransport(server),
        transportLabel: "in-process",
      };
      await hub.addProvider(provider);

      // Spy on the (TS-private) recording method so we can prove focusState
      // actually walks the focus snapshot. addProvider() seeds the same
      // affordance via deep discovery, so isDangerousAffordance() alone
      // can't distinguish the two code paths.
      const spy = spyOn(
        hub as unknown as { recordDangerousAffordances: (...args: unknown[]) => void },
        "recordDangerousAffordances",
      );
      const before = hub.getStateRevision();
      const detail = await hub.focusState({ providerId: id, path: "/session" });
      const after = hub.getStateRevision();

      expect(detail.id).toBe("session");
      expect(after).toBeGreaterThan(before);
      expect(spy).toHaveBeenCalledTimes(1);
      const [providerArg, , rootPathArg] = spy.mock.calls[0] ?? [];
      expect(providerArg).toBe(id);
      expect(rootPathArg).toBe("/session");
      // Sticky registry: the entry stays true after focusState runs.
      expect(hub.isDangerousAffordance(id, "/session", "destroy")).toBe(true);
      spy.mockRestore();
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

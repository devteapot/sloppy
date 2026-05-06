import { describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { PolicyDeniedError } from "../src/core/policy";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import type { RegisteredProvider } from "../src/providers/registry";

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

function createDelegationProvider(): {
  provider: RegisteredProvider;
  spawnCount: () => number;
} {
  let spawnCount = 0;
  const server = createSlopServer({ id: "delegation", name: "Delegation" });
  server.register("session", () => ({
    type: "context",
    actions: {
      spawn_agent: action(
        { name: "string", goal: "string", task_id: "string" },
        async () => {
          spawnCount += 1;
          return { id: `agent-${spawnCount}` };
        },
        { label: "Spawn", description: "Spawn", estimate: "fast" },
      ),
    },
  }));
  return {
    provider: {
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(server),
      transportLabel: "in-process:test",
      stop: () => server.stop(),
    },
    spawnCount: () => spawnCount,
  };
}

function createFsProvider(): RegisteredProvider {
  const server = createSlopServer({ id: "filesystem", name: "Filesystem" });
  server.register("workspace", () => ({
    type: "collection",
    actions: {
      edit: action({}, async () => ({ ok: true }), {
        label: "Edit",
        description: "Edit",
        estimate: "instant",
      }),
    },
  }));
  return {
    id: "filesystem",
    name: "Filesystem",
    kind: "builtin",
    transport: new InProcessTransport(server),
    transportLabel: "in-process:test",
    stop: () => server.stop(),
  };
}

describe("policy metadata isolation", () => {
  test("role metadata does not leak from one invoke to the next", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    const { provider: delegationProvider, spawnCount } = createDelegationProvider();
    const fsProvider = createFsProvider();

    try {
      await hub.connect();
      await hub.addProvider(delegationProvider);
      await hub.addProvider(fsProvider);
      hub.addPolicyRule({
        evaluate: (ctx) => {
          if (ctx.roleId === "meta-manager") {
            return { kind: "deny", reason: "meta-manager cannot invoke this action in test." };
          }
          return { kind: "allow" };
        },
      });

      // Role-tagged invoke that the rule denies confirms the rule sees
      // per-call metadata when supplied.
      await expect(
        hub.invoke("filesystem", "/workspace", "edit", {}, { roleId: "meta-manager" }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);

      // Immediately after, an actor-only invoke must not inherit roleId.
      const result = await hub.invoke(
        "delegation",
        "/session",
        "spawn_agent",
        { name: "n", goal: "g", task_id: "task-1" },
        { actor: "scheduler" },
      );
      expect(result.status).toBe("ok");
      expect(spawnCount()).toBe(1);

      // And explicitly: spawn_agent with the denied roleId is still denied.
      await expect(
        hub.invoke(
          "delegation",
          "/session",
          "spawn_agent",
          { name: "n", goal: "g", task_id: "task-2" },
          { roleId: "meta-manager" },
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      expect(spawnCount()).toBe(1);
    } finally {
      hub.shutdown();
    }
  });

  test("approval re-invoke replays the original metadata", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    const { provider: delegationProvider, spawnCount } = createDelegationProvider();

    try {
      await hub.connect();
      await hub.addProvider(delegationProvider);
      // Approval-shaped rule that allows the re-invoke path. The hub now
      // signals approval via the out-of-band `preApproved` flag on
      // InvokeContext rather than a model-controlled `params.confirmed`.
      const seenRoleIds: Array<string | undefined> = [];
      hub.addPolicyRule({
        evaluate: (ctx) => {
          seenRoleIds.push(ctx.roleId);
          if (ctx.preApproved) {
            return { kind: "allow" };
          }
          return { kind: "require_approval", reason: "test approval" };
        },
      });

      // Invoke without any metadata; should enqueue approval.
      const first = await hub.invoke("delegation", "/session", "spawn_agent", {
        name: "n",
        goal: "g",
        task_id: "t",
      });
      expect(first.status).toBe("error");
      expect(first.error?.code).toBe("approval_required");
      const pending = hub.approvals.list({ providerId: "delegation" });
      expect(pending).toHaveLength(1);
      const approvalId = pending[0]?.id;

      await hub.approvals.approve(approvalId);
      expect(spawnCount()).toBe(1);
      // Both passes should have observed roleId === undefined (no leak from
      // any unrelated caller, no spurious tag injected by the queue).
      expect(seenRoleIds).toEqual([undefined, undefined]);
    } finally {
      hub.shutdown();
    }
  });
});

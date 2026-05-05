import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { action, createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { MetaRuntimeProvider } from "../src/providers/builtin/meta-runtime";
import type { RegisteredProvider } from "../src/providers/registry";
import { createBuiltinProviders } from "../src/providers/registry";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

function harness(globalRoot: string, workspaceRoot: string) {
  const provider = new MetaRuntimeProvider({ globalRoot, workspaceRoot });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  return { provider, consumer };
}

function registeredMetaProvider(provider: MetaRuntimeProvider): RegisteredProvider {
  return {
    id: "meta-runtime",
    name: "Meta Runtime",
    kind: "builtin",
    transport: new InProcessTransport(provider.server),
    transportLabel: "in-process:test",
    stop: () => provider.stop(),
    approvals: provider.approvals,
    attachRuntime: (hub) => {
      provider.setHub(hub);
      return {
        stop() {
          provider.setHub(null);
        },
      };
    },
  };
}

function delegationStub(): {
  provider: RegisteredProvider;
  spawns: Array<Record<string, unknown>>;
} {
  const spawns: Array<Record<string, unknown>> = [];
  const server = createSlopServer({ id: "delegation", name: "Delegation" });
  server.register("session", () => ({
    type: "context",
    actions: {
      spawn_agent: action(
        {
          name: "string",
          goal: "string",
          executor: {
            type: "object",
            optional: true,
          },
          capabilityMasks: {
            type: "array",
            optional: true,
          },
        },
        async (params) => {
          spawns.push(params);
          return { id: "agent-spawned", status: "pending" };
        },
        { label: "Spawn Agent", description: "Spawn test agent.", estimate: "fast" },
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
    spawns,
  };
}

function messagingStub(): { provider: RegisteredProvider; sent: string[] } {
  const sent: string[] = [];
  const server = createSlopServer({ id: "messaging", name: "Messaging" });
  server.register("channels", () => ({
    type: "collection",
    items: [
      {
        id: "review",
        props: { id: "review", name: "Review" },
        actions: {
          send: action(
            { message: "string" },
            async ({ message }) => {
              sent.push(String(message));
              return { id: "message-1", channel_id: "review" };
            },
            { label: "Send", description: "Send test message.", estimate: "fast" },
          ),
        },
      },
    ],
  }));
  return {
    provider: {
      id: "messaging",
      name: "Messaging",
      kind: "builtin",
      transport: new InProcessTransport(server),
      transportLabel: "in-process:test",
      stop: () => server.stop(),
    },
    sent,
  };
}

const TEST_CONFIG: SloppyConfig = {
  llm: { provider: "openai", model: "gpt-5.4", profiles: [], maxTokens: 4096 },
  agent: {
    maxIterations: 1,
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
    metaRuntime: {
      globalRoot: "~/.sloppy/meta-runtime",
      workspaceRoot: ".sloppy/meta-runtime",
    },
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: { maxAgents: 10 },
    vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
  },
};

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MetaRuntimeProvider", () => {
  test("applies non-privileged session topology changes without approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Create a review channel",
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "review",
              topic: "review",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;

      const applied = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(applied.status).toBe("ok");

      const channels = await consumer.query("/channels", 2);
      expect(channels.children?.[0]?.id).toBe("review");
      expect(channels.children?.[0]?.properties?.participants).toEqual(["root"]);
    } finally {
      provider.stop();
    }
  });

  test("persistent topology changes require approval and write workspace state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const { provider, consumer } = harness(join(root, "global"), workspaceRoot);

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "workspace",
        summary: "Add reviewer profile",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: {
              id: "reviewer",
              name: "Reviewer",
              instructions: "Inspect changes and report risks.",
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;

      const blocked = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approved = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approved.status).toBe("ok");

      const profiles = await consumer.query("/profiles", 2);
      expect(profiles.children?.[0]?.id).toBe("reviewer");
      const persisted = JSON.parse(await readFile(join(workspaceRoot, "state.json"), "utf8")) as {
        profiles: Array<{ id: string }>;
      };
      expect(persisted.profiles.map((profile) => profile.id)).toContain("reviewer");
    } finally {
      provider.stop();
    }
  });

  test("session deny capability masks auto-apply but allow masks request approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const denyProposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Deny shell writes",
        ops: [
          {
            type: "setCapabilityMask",
            mask: { id: "deny-terminal", provider: "terminal", actions: ["execute"], mode: "deny" },
          },
        ],
      });
      const denyId = (denyProposal.data as { id: string }).id;
      expect((denyProposal.data as { requiresApproval: boolean }).requiresApproval).toBe(false);
      expect((await consumer.invoke(`/proposals/${denyId}`, "apply_proposal", {})).status).toBe(
        "ok",
      );

      const allowProposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Allow filesystem writes",
        ops: [
          {
            type: "setCapabilityMask",
            mask: {
              id: "allow-filesystem",
              provider: "filesystem",
              actions: ["write"],
              mode: "allow",
            },
          },
        ],
      });
      const allowId = (allowProposal.data as { id: string }).id;
      expect((allowProposal.data as { requiresApproval: boolean }).requiresApproval).toBe(true);
      const blocked = await consumer.invoke(`/proposals/${allowId}`, "apply_proposal", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");
    } finally {
      provider.stop();
    }
  });

  test("loads global and workspace state with workspace values winning", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const globalRoot = join(root, "global");
    const workspaceRoot = join(root, "workspace");

    const first = harness(globalRoot, workspaceRoot);
    try {
      await connect(first.consumer);
      const globalProposal = await first.consumer.invoke("/session", "propose_change", {
        scope: "global",
        summary: "Global reviewer",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Global Reviewer" },
          },
        ],
      });
      const workspaceProposal = await first.consumer.invoke("/session", "propose_change", {
        scope: "workspace",
        summary: "Workspace reviewer",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Workspace Reviewer" },
          },
        ],
      });
      for (const proposal of [globalProposal, workspaceProposal]) {
        const proposalId = (proposal.data as { id: string }).id;
        await first.consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
        const approvals = await first.consumer.query("/approvals", 2);
        const approvalId = approvals.children?.find(
          (child) => child.properties?.status === "pending",
        )?.id;
        expect(typeof approvalId).toBe("string");
        await first.consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      }
    } finally {
      first.provider.stop();
    }

    const second = harness(globalRoot, workspaceRoot);
    try {
      await connect(second.consumer);
      const profiles = await second.consumer.query("/profiles", 2);
      expect(profiles.children?.[0]?.properties?.name).toBe("Workspace Reviewer");
      const globalPersisted = JSON.parse(
        await readFile(join(globalRoot, "state.json"), "utf8"),
      ) as {
        profiles: Array<{ id: string; name: string }>;
      };
      const workspacePersisted = JSON.parse(
        await readFile(join(workspaceRoot, "state.json"), "utf8"),
      ) as {
        profiles: Array<{ id: string; name: string }>;
      };
      expect(globalPersisted.profiles).toContainEqual({
        id: "reviewer",
        name: "Global Reviewer",
      });
      expect(globalPersisted.profiles).not.toContainEqual({
        id: "reviewer",
        name: "Workspace Reviewer",
      });
      expect(workspacePersisted.profiles).toContainEqual({
        id: "reviewer",
        name: "Workspace Reviewer",
      });
      expect(workspacePersisted.profiles).not.toContainEqual({
        id: "reviewer",
        name: "Global Reviewer",
      });

      const replaced = await second.consumer.invoke("/session", "import_state", {
        scope: "workspace",
        mode: "replace",
        state: {},
      });
      expect(replaced.status).toBe("error");
      expect(replaced.error?.code).toBe("approval_required");
      const approvals = await second.consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      await second.consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      const afterReplace = await second.consumer.query("/profiles", 2);
      expect(afterReplace.children?.[0]?.properties?.name).toBe("Global Reviewer");
    } finally {
      second.provider.stop();
    }
  });

  test("validates topology proposals before mutating runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Invalid route",
        ops: [
          {
            type: "upsertRoute",
            route: {
              id: "bad-route",
              source: "root",
              match: "*",
              target: "agent:missing",
              enabled: true,
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;
      const applied = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(applied.status).toBe("error");
      expect(applied.error?.message).toContain("unknown target agent missing");

      const routes = await consumer.query("/routes", 2);
      expect(routes.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("expires proposals that pass their ttl before apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Short-lived channel",
        ttl_ms: 1,
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "brief",
              topic: "brief",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;
      await sleep(5);
      const applied = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(applied.status).toBe("error");
      expect(applied.error?.message).toContain("expired before it could be applied");

      const proposal = await consumer.query(`/proposals/${proposalId}`, 1);
      expect(proposal.properties?.status).toBe("expired");
      const channels = await consumer.query("/channels", 2);
      expect(channels.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("dispatch_route invokes delegation using agent topology and executor binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const meta = new MetaRuntimeProvider({
      globalRoot: join(root, "global"),
      workspaceRoot: join(root, "workspace"),
    });
    const delegation = delegationStub();
    const metaRegistration = registeredMetaProvider(meta);
    const hub = new ConsumerHub([metaRegistration, delegation.provider], TEST_CONFIG);

    try {
      await hub.connect();
      const stop = metaRegistration.attachRuntime?.(hub, TEST_CONFIG);
      const consumer = new SlopConsumer(new InProcessTransport(meta.server));
      await connect(consumer);

      const proposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Route reviews to reviewer",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: {
              id: "reviewer",
              name: "Reviewer",
              instructions: "Review carefully.",
            },
          },
          {
            type: "setExecutorBinding",
            binding: {
              id: "fast",
              kind: "llm",
              profileId: "openai-main",
              modelOverride: "gpt-mini",
            },
          },
          {
            type: "setCapabilityMask",
            mask: {
              id: "filesystem-read-only",
              provider: "filesystem",
              actions: ["read"],
              mode: "allow",
            },
          },
          {
            type: "spawnAgent",
            agent: {
              id: "agent-reviewer",
              profileId: "reviewer",
              status: "active",
              channels: [],
              capabilityMaskIds: ["filesystem-read-only"],
              executorBindingId: "fast",
            },
          },
          {
            type: "upsertRoute",
            route: {
              id: "review-route",
              source: "root",
              match: "review",
              target: "agent:agent-reviewer",
              enabled: true,
            },
          },
        ],
      });
      const proposalId = (proposal.data as { id: string }).id;
      await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      await consumer.invoke(`/approvals/${approvalId}`, "approve", {});

      const dispatched = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "please review the runtime",
      });
      expect(dispatched.status).toBe("ok");
      expect(delegation.spawns).toHaveLength(1);
      expect(delegation.spawns[0]).toMatchObject({
        name: "Reviewer",
        goal: "Review carefully.\n\nplease review the runtime",
        executor: { kind: "llm", profileId: "openai-main", modelOverride: "gpt-mini" },
        capabilityMasks: [
          {
            id: "filesystem-read-only",
            provider: "filesystem",
            actions: ["read"],
            mode: "allow",
          },
        ],
      });
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("dispatch_route sends messages to routed channels", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const meta = new MetaRuntimeProvider({
      globalRoot: join(root, "global"),
      workspaceRoot: join(root, "workspace"),
    });
    const messaging = messagingStub();
    const metaRegistration = registeredMetaProvider(meta);
    const hub = new ConsumerHub([metaRegistration, messaging.provider], TEST_CONFIG);

    try {
      await hub.connect();
      const stop = metaRegistration.attachRuntime?.(hub, TEST_CONFIG);
      const consumer = new SlopConsumer(new InProcessTransport(meta.server));
      await connect(consumer);

      const proposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Route notes to review channel",
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "review",
              topic: "review",
              participants: ["root", "reviewer"],
              visibility: "shared",
            },
          },
          {
            type: "upsertRoute",
            route: {
              id: "channel-route",
              source: "root",
              match: "*",
              target: "channel:review",
              enabled: true,
            },
          },
        ],
      });
      const proposalId = (proposal.data as { id: string }).id;
      expect((await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {})).status).toBe(
        "ok",
      );

      const dispatched = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "record this review note",
      });
      expect(dispatched.status).toBe("ok");
      expect(messaging.sent).toEqual(["record this review note"]);
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("exports merged state and approval-gates persistent imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const { provider, consumer } = harness(join(root, "global"), workspaceRoot);

    try {
      await connect(consumer);
      const imported = await consumer.invoke("/session", "import_state", {
        scope: "workspace",
        mode: "merge",
        state: {
          profiles: [{ id: "imported", name: "Imported" }],
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.code).toBe("approval_required");
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      expect((await consumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe("ok");

      const exported = await consumer.invoke("/session", "export_state", {});
      expect(exported.status).toBe("ok");
      expect(
        (exported.data as { profiles: Array<{ id: string; name: string }> }).profiles,
      ).toContainEqual({
        id: "imported",
        name: "Imported",
      });
      const persisted = JSON.parse(await readFile(join(workspaceRoot, "state.json"), "utf8")) as {
        profiles: Array<{ id: string }>;
      };
      expect(persisted.profiles.map((profile) => profile.id)).toContain("imported");
    } finally {
      provider.stop();
    }
  });

  test("registry exposes meta-runtime only when explicitly enabled", () => {
    const config = {
      llm: { provider: "openai", model: "gpt-5.4", profiles: [], maxTokens: 4096 },
      agent: {
        maxIterations: 1,
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
          metaRuntime: true,
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
        metaRuntime: {
          globalRoot: "~/.sloppy/meta-runtime",
          workspaceRoot: ".sloppy/meta-runtime",
        },
        web: { historyLimit: 20 },
        browser: { viewportWidth: 1280, viewportHeight: 720 },
        cron: { maxJobs: 50 },
        messaging: { maxMessages: 500 },
        delegation: { maxAgents: 10 },
        vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
      },
    } satisfies SloppyConfig;

    const providers = createBuiltinProviders(config);
    try {
      expect(providers.map((provider) => provider.id)).toEqual(["meta-runtime"]);
    } finally {
      for (const provider of providers) {
        provider.stop?.();
      }
    }
  });
});

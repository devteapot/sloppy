import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { action, createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { MetaRuntimeProvider } from "../src/providers/builtin/meta-runtime";
import { SkillsProvider } from "../src/providers/builtin/skills";
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
          routeEnvelope: {
            type: "object",
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

function messagingStub(): {
  provider: RegisteredProvider;
  sent: string[];
  envelopes: unknown[];
} {
  const sent: string[] = [];
  const envelopes: unknown[] = [];
  const server = createSlopServer({ id: "messaging", name: "Messaging" });
  server.register("channels", () => ({
    type: "collection",
    items: [
      {
        id: "review",
        props: { id: "review", name: "Review" },
        actions: {
          send: action(
            {
              message: "string",
              envelope: { type: "object", optional: true },
            },
            async ({ message, envelope }) => {
              sent.push(String(message));
              envelopes.push(envelope);
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
    envelopes,
  };
}

function registeredSkillsProvider(provider: SkillsProvider): RegisteredProvider {
  return {
    id: "skills",
    name: "Skills",
    kind: "builtin",
    transport: new InProcessTransport(provider.server),
    transportLabel: "in-process:test",
    stop: () => provider.stop(),
    approvals: provider.approvals,
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
    skills: { skillsDir: "~/.sloppy/skills" },
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

async function readPersistedMetaStateFile(root: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return parsed.kind === "sloppy.meta-runtime.state" &&
    parsed.state &&
    typeof parsed.state === "object" &&
    !Array.isArray(parsed.state)
    ? (parsed.state as Record<string, unknown>)
    : parsed;
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
      const rawPersisted = JSON.parse(
        await readFile(join(workspaceRoot, "state.json"), "utf8"),
      ) as {
        kind: string;
        schema_version: number;
        state: { profiles: Array<{ id: string }> };
      };
      expect(rawPersisted.kind).toBe("sloppy.meta-runtime.state");
      expect(rawPersisted.schema_version).toBe(1);
      expect(rawPersisted.state.profiles.map((profile) => profile.id)).toContain("reviewer");
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
      const globalPersisted = (await readPersistedMetaStateFile(globalRoot)) as {
        profiles: Array<{ id: string; name: string }>;
      };
      const workspacePersisted = (await readPersistedMetaStateFile(workspaceRoot)) as {
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

  test("loads legacy raw meta-runtime state files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-legacy-"));
    tempPaths.push(root);
    const globalRoot = join(root, "global");
    const workspaceRoot = join(root, "workspace");
    await mkdir(globalRoot, { recursive: true });
    await writeFile(
      join(globalRoot, "state.json"),
      `${JSON.stringify(
        {
          profiles: [{ id: "legacy-reviewer", name: "Legacy Reviewer" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const { provider, consumer } = harness(globalRoot, workspaceRoot);

    try {
      await connect(consumer);
      const profiles = await consumer.query("/profiles", 2);
      expect(profiles.children?.map((child) => child.id)).toContain("legacy-reviewer");
    } finally {
      provider.stop();
    }
  });

  test("rejects unsupported meta-runtime state schema envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-schema-"));
    tempPaths.push(root);
    const globalRoot = join(root, "global");
    await mkdir(globalRoot, { recursive: true });
    await writeFile(
      join(globalRoot, "state.json"),
      `${JSON.stringify(
        {
          kind: "sloppy.meta-runtime.state",
          schema_version: 999,
          saved_at: "2026-05-06T00:00:00.000Z",
          state: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(() => harness(globalRoot, join(root, "workspace"))).toThrow(
      "unsupported schema_version 999",
    );
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

  test("rejects invalid route matcher configuration before storing proposals", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Invalid matcher",
        ops: [
          {
            type: "upsertRoute",
            route: {
              id: "bad-regex-route",
              source: "root",
              match: "[",
              matchMode: "regex",
              target: "channel:review",
              enabled: true,
            },
          },
        ],
      });
      expect(proposed.status).toBe("error");
      expect(proposed.error?.message).toContain("valid regular expression");
      const proposals = await consumer.query("/proposals", 2);
      expect(proposals.properties?.count).toBe(0);
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
      expect(String(delegation.spawns[0]?.goal)).toContain("please review the runtime");
      expect(delegation.spawns[0]).toMatchObject({
        name: "Reviewer",
        routeEnvelope: {
          source: "root",
          body: "please review the runtime",
        },
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

  test("dispatch_route rejects agent targets without explicit capability masks", async () => {
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
        summary: "Route to unmasked agent",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Reviewer" },
          },
          {
            type: "spawnAgent",
            agent: {
              id: "agent-reviewer",
              profileId: "reviewer",
              status: "active",
              channels: [],
              capabilityMaskIds: [],
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
      expect((await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {})).status).toBe(
        "error",
      );
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect((await consumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe("ok");

      const dispatched = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "please review the runtime",
      });
      expect(dispatched.status).toBe("ok");
      expect((dispatched.data as { routed: boolean; reason?: string }).routed).toBe(false);
      expect(delegation.spawns).toHaveLength(0);
      const events = await consumer.query("/events", 2);
      const failure = events.children?.find((child) => child.properties?.kind === "route.failed");
      expect(failure?.properties?.metadata).toMatchObject({
        reason_code: "missing_capability_mask",
        agent_id: "agent-reviewer",
      });
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("rejects malformed executor bindings before they enter topology state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const missingProfile = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Bad LLM executor",
        ops: [
          {
            type: "setExecutorBinding",
            binding: {
              id: "bad-llm",
              kind: "llm",
            },
          },
        ],
      });
      expect(missingProfile.status).toBe("error");
      expect(missingProfile.error?.message).toContain("profileId");

      const unknownKind = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Bad executor kind",
        ops: [
          {
            type: "setExecutorBinding",
            binding: {
              id: "bad-kind",
              kind: "worker",
              adapterId: "codex",
            },
          },
        ],
      });
      expect(unknownKind.status).toBe("error");
      expect(unknownKind.error?.message).toContain("No matching discriminator");

      const bindings = await consumer.query("/executor-bindings", 2);
      expect(bindings.properties?.count).toBe(0);
    } finally {
      provider.stop();
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
      expect(messaging.envelopes[0]).toMatchObject({
        source: "root",
        body: "record this review note",
      });
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("dispatch_route accepts typed envelopes and can fan out to multiple routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const meta = new MetaRuntimeProvider({
      globalRoot: join(root, "global"),
      workspaceRoot: join(root, "workspace"),
    });
    const delegation = delegationStub();
    const messaging = messagingStub();
    const metaRegistration = registeredMetaProvider(meta);
    const hub = new ConsumerHub(
      [metaRegistration, delegation.provider, messaging.provider],
      TEST_CONFIG,
    );

    try {
      await hub.connect();
      const stop = metaRegistration.attachRuntime?.(hub, TEST_CONFIG);
      const consumer = new SlopConsumer(new InProcessTransport(meta.server));
      await connect(consumer);

      const proposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Fan out review messages",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Reviewer", instructions: "Review carefully." },
          },
          {
            type: "setCapabilityMask",
            mask: {
              id: "review-read",
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
              capabilityMaskIds: ["review-read"],
            },
          },
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
              id: "agent-route",
              source: "root",
              match: "review",
              target: "agent:agent-reviewer",
              enabled: true,
              priority: 2,
            },
          },
          {
            type: "upsertRoute",
            route: {
              id: "channel-route",
              source: "root",
              match: "review",
              target: "channel:review",
              enabled: true,
              priority: 1,
            },
          },
        ],
      });
      const proposalId = (proposal.data as { id: string }).id;
      const blocked = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect((await consumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe("ok");

      const dispatched = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "fallback body",
        envelope: {
          id: "msg-1",
          body: "please review this typed envelope",
          topic: "audit",
          metadata: { severity: "high" },
        },
        fanout: true,
      });
      expect(dispatched.status).toBe("ok");
      const data = dispatched.data as { routed: boolean; deliveries: Array<{ route_id: string }> };
      expect(data.routed).toBe(true);
      expect(data.deliveries.map((delivery) => delivery.route_id)).toEqual([
        "agent-route",
        "channel-route",
      ]);
      expect(delegation.spawns[0]?.goal).toContain("Route message msg-1 from root:");
      expect(delegation.spawns[0]?.routeEnvelope).toEqual({
        id: "msg-1",
        source: "root",
        body: "please review this typed envelope",
        topic: "audit",
        metadata: { severity: "high" },
      });
      expect(messaging.sent).toEqual(["please review this typed envelope"]);
      expect(messaging.envelopes[0]).toEqual({
        id: "msg-1",
        source: "root",
        body: "please review this typed envelope",
        topic: "audit",
        metadata: { severity: "high" },
      });
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("keeps strategy helpers out of the public meta-runtime session surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      const actions = session.affordances?.map((affordance) => affordance.action) ?? [];
      expect(session.properties?.strategy_surface).toBe("skills");
      expect(session.properties?.strategy_skills).toBeUndefined();
      expect(actions).toContain("propose_change");
      expect(actions).toContain("record_evaluation");
      expect(actions).not.toContain("analyze_runtime_trace");
      expect(actions).not.toContain("prepare_architect_brief");
      expect(actions).not.toContain("start_architect_cycle");
      expect(actions).not.toContain("derive_proposals_from_events");
      expect(actions).not.toContain("start_evolution_cycle");
      expect(actions).not.toContain("record_experiment_evidence");
    } finally {
      provider.stop();
    }
  });

  test("dispatch_route matches typed envelope fields with explicit match modes", async () => {
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
        summary: "Typed route matchers",
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
          {
            type: "upsertRoute",
            route: {
              id: "topic-route",
              source: "root",
              match: "code-review",
              matchField: "topic",
              matchMode: "exact",
              caseSensitive: false,
              target: "channel:review",
              enabled: true,
              priority: 3,
            },
          },
          {
            type: "upsertRoute",
            route: {
              id: "metadata-route",
              source: "root",
              match: "high",
              matchField: "metadata.severity",
              matchMode: "exact",
              target: "channel:review",
              enabled: true,
              priority: 2,
            },
          },
          {
            type: "upsertRoute",
            route: {
              id: "regex-body-route",
              source: "root",
              match: "audit-[0-9]+",
              matchMode: "regex",
              target: "channel:review",
              enabled: true,
              priority: 1,
            },
          },
        ],
      });
      const proposalId = (proposal.data as { id: string }).id;
      expect((await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {})).status).toBe(
        "ok",
      );

      const single = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "fallback body",
        envelope: {
          id: "typed-1",
          body: "no body keyword here",
          topic: "Code-Review",
          metadata: { severity: "low" },
        },
      });
      if (single.status === "error") {
        throw new Error(single.error?.message ?? "typed route dispatch failed");
      }
      expect(single.status).toBe("ok");
      expect((single.data as { route_id: string }).route_id).toBe("topic-route");

      const fanout = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "fallback body",
        envelope: {
          id: "typed-2",
          body: "audit-42",
          topic: "Code-Review",
          metadata: { severity: "high" },
        },
        fanout: true,
      });
      const fanoutData = fanout.data as {
        deliveries: Array<{ route_id: string }>;
      };
      expect(fanoutData.deliveries.map((delivery) => delivery.route_id)).toEqual([
        "topic-route",
        "metadata-route",
        "regex-body-route",
      ]);
      expect(messaging.sent).toEqual(["no body keyword here", "audit-42", "audit-42", "audit-42"]);
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("dispatch_route records trace events when no runtime hub is attached", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Route without attached hub",
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
          {
            type: "upsertRoute",
            route: {
              id: "hubless-route",
              source: "root",
              match: "review",
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
        message: "please review this",
      });
      expect(dispatched.status).toBe("ok");
      expect((dispatched.data as { routed: boolean }).routed).toBe(false);

      const events = await consumer.query("/events", 2);
      const failure = events.children?.find((child) => child.properties?.kind === "route.failed");
      expect(failure?.properties?.routeId).toBe("hubless-route");
      expect(failure?.properties?.metadata).toMatchObject({
        reason_code: "missing_hub",
        route_id: "hubless-route",
        source: "root",
      });
    } finally {
      provider.stop();
    }
  });

  test("dispatch_route honors canary route sample rates", async () => {
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
        summary: "Canary route",
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
          {
            type: "upsertRoute",
            route: {
              id: "canary-route",
              source: "root",
              match: "review",
              target: "channel:review",
              enabled: true,
              traffic: {
                sampleRate: 0,
                experimentId: "experiment-canary",
              },
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
        message: "please review this",
      });
      expect(dispatched.status).toBe("ok");
      expect((dispatched.data as { routed: boolean }).routed).toBe(false);
      expect(messaging.sent).toEqual([]);
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("records evaluations and marks topology experiments promoted without provider scoring", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Experiment channel",
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "experiment-review",
              topic: "experiment-review",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      const proposalId = (proposed.data as { id: string }).id;
      const experimentResult = await consumer.invoke("/session", "create_experiment", {
        proposal_id: proposalId,
        name: "Review routing trial",
        objective: "Determine whether a review channel improves handoff quality.",
        promotion_criteria: {
          min_score: 0.8,
          required_evaluations: 2,
        },
      });
      expect(experimentResult.status).toBe("ok");
      const experimentId = (experimentResult.data as { id: string }).id;

      const premature = await consumer.invoke("/session", "promote_experiment", {
        experiment_id: experimentId,
      });
      expect(premature.status).toBe("error");
      expect(premature.error?.message).toContain("requires at least one recorded evaluation");

      const evaluation = await consumer.invoke("/session", "record_evaluation", {
        experiment_id: experimentId,
        score: 0.1,
        summary: "The evaluator deliberately records a low score to prove scoring is skill-owned.",
        evaluator: "test",
      });
      expect(evaluation.status).toBe("ok");
      const evaluationId = (evaluation.data as { id: string }).id;
      const promoted = await consumer.invoke("/session", "promote_experiment", {
        experiment_id: experimentId,
        evaluation_id: evaluationId,
      });
      expect(promoted.status).toBe("ok");
      expect((promoted.data as { status: string }).status).toBe("promoted");
      expect((promoted.data as { promotionEvaluationId: string }).promotionEvaluationId).toBe(
        evaluationId,
      );

      const channels = await consumer.query("/channels", 2);
      expect(channels.children?.[0]?.id).toBe("experiment-review");
    } finally {
      provider.stop();
    }
  });

  test("records explicit experiment evaluations and archives reusable topology patterns", async () => {
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

      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Review routing pattern candidate",
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
          {
            type: "upsertRoute",
            route: {
              id: "review-route",
              source: "root",
              match: "review",
              target: "channel:review",
              enabled: true,
            },
          },
        ],
      });
      const proposalId = (proposed.data as { id: string }).id;
      const experiment = await consumer.invoke("/session", "create_experiment", {
        proposal_id: proposalId,
        name: "Review routing pattern trial",
        objective: "Verify review traffic is delivered through the review channel.",
        promotion_criteria: {
          min_score: 0.7,
          required_evaluations: 1,
        },
      });
      expect(experiment.status).toBe("ok");
      const experimentId = (experiment.data as { id: string }).id;
      expect((await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {})).status).toBe(
        "ok",
      );

      const routed = await consumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "please review this",
      });
      expect(routed.status).toBe("ok");
      expect((routed.data as { routed: boolean }).routed).toBe(true);

      const evidence = await consumer.invoke("/session", "record_evaluation", {
        experiment_id: experimentId,
        score: 0.9,
        summary: "Review traffic reached the review channel after applying the proposal.",
        evidence: {
          routed: true,
        },
      });
      expect(evidence.status).toBe("ok");
      expect((evidence.data as { score: number }).score).toBeGreaterThanOrEqual(0.7);

      const promoted = await consumer.invoke("/session", "promote_experiment", {
        experiment_id: experimentId,
      });
      expect(promoted.status).toBe("ok");

      const implicitArchive = await consumer.invoke("/session", "archive_topology_pattern", {
        experiment_id: experimentId,
        name: "Implicit route pattern",
      });
      expect(implicitArchive.status).toBe("error");
      expect(implicitArchive.error?.message).toContain("ops");

      const archivedOps = [
        {
          type: "upsertChannel",
          channel: {
            id: "review",
            topic: "review",
            participants: ["root"],
            visibility: "shared",
          },
        },
        {
          type: "upsertRoute",
          route: {
            id: "review-route-template",
            source: "root",
            match: "review",
            target: "channel:review",
            enabled: true,
          },
        },
      ];
      const archived = await consumer.invoke("/session", "archive_topology_pattern", {
        experiment_id: experimentId,
        name: "Review route pattern",
        tags: ["review", "channel"],
        ops: archivedOps,
      });
      expect(archived.status).toBe("ok");
      const patternId = (archived.data as { id: string }).id;
      const patterns = await consumer.query("/patterns", 2);
      expect(patterns.children?.[0]?.id).toBe(patternId);

      const implicitReuse = await consumer.invoke("/session", "propose_from_pattern", {
        pattern_id: patternId,
        summary: "Implicit reuse",
      });
      expect(implicitReuse.status).toBe("error");
      expect(implicitReuse.error?.message).toContain("ops");

      const reused = await consumer.invoke("/session", "propose_from_pattern", {
        pattern_id: patternId,
        summary: "Reuse review route pattern",
        ops: [
          {
            type: "upsertRoute",
            route: {
              id: "review-route-reuse",
              source: "root",
              match: "review",
              target: "channel:review",
              enabled: true,
            },
          },
        ],
      });
      expect(reused.status).toBe("ok");
      const reusedOps = (reused.data as { ops: Array<{ route?: { id?: string } }> }).ops;
      expect(reusedOps).toHaveLength(1);
      expect(reusedOps[0]?.route?.id).toBe("review-route-reuse");
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("approval-gates persistent experiment metadata writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const { provider, consumer } = harness(join(root, "global"), workspaceRoot);

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "workspace",
        summary: "Persistent experiment channel",
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "persistent-experiment",
              topic: "persistent-experiment",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      const proposalId = (proposed.data as { id: string }).id;
      const blockedExperiment = await consumer.invoke("/session", "create_experiment", {
        proposal_id: proposalId,
        name: "Persistent trial",
        objective: "Verify persistent experiment approval.",
      });
      expect(blockedExperiment.status).toBe("error");
      expect(blockedExperiment.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      const createApprovalId = approvals.children?.find(
        (child) => child.properties?.action === "create_experiment",
      )?.id;
      expect(typeof createApprovalId).toBe("string");
      const approvedExperiment = await consumer.invoke(
        `/approvals/${createApprovalId}`,
        "approve",
        {},
      );
      expect(approvedExperiment.status).toBe("ok");
      const experimentId = (approvedExperiment.data as { id: string }).id;

      const blockedEvaluation = await consumer.invoke("/session", "record_evaluation", {
        experiment_id: experimentId,
        score: 1,
        summary: "Persistent evaluation.",
      });
      expect(blockedEvaluation.status).toBe("error");
      expect(blockedEvaluation.error?.code).toBe("approval_required");
      const refreshedApprovals = await consumer.query("/approvals", 2);
      const evaluationApprovalId = refreshedApprovals.children?.find(
        (child) =>
          child.properties?.action === "record_evaluation" &&
          child.properties?.status === "pending",
      )?.id;
      expect(typeof evaluationApprovalId).toBe("string");
      const approvedEvaluation = await consumer.invoke(
        `/approvals/${evaluationApprovalId}`,
        "approve",
        {},
      );
      expect(approvedEvaluation.status).toBe("ok");

      const persisted = (await readPersistedMetaStateFile(workspaceRoot)) as {
        experiments: Array<{ id: string }>;
        evaluations: Array<{ experimentId: string }>;
      };
      expect(persisted.experiments.map((experiment) => experiment.id)).toContain(experimentId);
      expect(persisted.evaluations.map((evaluation) => evaluation.experimentId)).toContain(
        experimentId,
      );
    } finally {
      provider.stop();
    }
  });

  test("rollback_experiment applies a pending rollback proposal before recording rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Experiment channel",
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "rollback-review",
              topic: "rollback-review",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      const proposalId = (proposed.data as { id: string }).id;
      const experimentResult = await consumer.invoke("/session", "create_experiment", {
        proposal_id: proposalId,
        name: "Rollback trial",
        objective: "Exercise rollback proposal application.",
        promotion_criteria: {
          min_score: 0,
          required_evaluations: 1,
        },
      });
      const experimentId = (experimentResult.data as { id: string }).id;
      expect(
        (
          await consumer.invoke("/session", "record_evaluation", {
            experiment_id: experimentId,
            score: 1,
            summary: "Ready to promote.",
          })
        ).status,
      ).toBe("ok");
      expect(
        (await consumer.invoke("/session", "promote_experiment", { experiment_id: experimentId }))
          .status,
      ).toBe("ok");

      const rollbackProposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Remove reviewer from rollback channel",
        ops: [
          {
            type: "rewireChannel",
            channelId: "rollback-review",
            participants: [],
          },
        ],
      });
      const rollbackProposalId = (rollbackProposal.data as { id: string }).id;
      const rollback = await consumer.invoke("/session", "rollback_experiment", {
        experiment_id: experimentId,
        rollback_proposal_id: rollbackProposalId,
      });
      expect(rollback.status).toBe("ok");
      expect((rollback.data as { status: string }).status).toBe("rolled_back");

      const channels = await consumer.query("/channels", 2);
      const channel = channels.children?.find((child) => child.id === "rollback-review");
      expect(channel?.properties?.participants).toEqual([]);
      const appliedRollback = await consumer.query(`/proposals/${rollbackProposalId}`, 1);
      expect(appliedRollback.properties?.status).toBe("applied");
    } finally {
      provider.stop();
    }
  });

  test("activates linked skill proposals through the skills provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const meta = new MetaRuntimeProvider({
      globalRoot: join(root, "global"),
      workspaceRoot: join(root, "workspace"),
    });
    const skills = new SkillsProvider({ skillsDir: join(root, "skills") });
    const delegation = delegationStub();
    const metaRegistration = registeredMetaProvider(meta);
    const hub = new ConsumerHub(
      [metaRegistration, registeredSkillsProvider(skills), delegation.provider],
      TEST_CONFIG,
    );

    try {
      await hub.connect();
      const stop = metaRegistration.attachRuntime?.(hub, TEST_CONFIG);
      const metaConsumer = new SlopConsumer(new InProcessTransport(meta.server));
      const skillsConsumer = new SlopConsumer(new InProcessTransport(skills.server));
      await connect(metaConsumer);
      await connect(skillsConsumer);
      const skillProposal = await skillsConsumer.invoke("/session", "propose_skill", {
        scope: "session",
        name: "review-runtime",
        version: "1.0.0",
        body: "# Review Runtime\n\nReview topology changes.\n",
      });
      const skillProposalId = (skillProposal.data as { id: string }).id;

      const metaProposal = await metaConsumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Activate review skill",
        ops: [
          {
            type: "activateSkillVersion",
            skillVersion: {
              id: "review-runtime@1.0.0",
              skillId: "review-runtime",
              version: "1.0.0",
              scope: "session",
              active: false,
              proposalId: skillProposalId,
              activationStatus: "pending",
            },
          },
        ],
      });
      const metaProposalId = (metaProposal.data as { id: string }).id;
      const applied = await metaConsumer.invoke(
        `/proposals/${metaProposalId}`,
        "apply_proposal",
        {},
      );
      expect(applied.status).toBe("error");
      expect(applied.error?.code).toBe("approval_required");
      const approvals = await metaConsumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect((await metaConsumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe(
        "ok",
      );

      const skillVersions = await metaConsumer.query("/skill-versions", 2);
      expect(skillVersions.children?.[0]?.properties?.activationStatus).toBe("active");
      const proposals = await skillsConsumer.query("/proposals", 2);
      expect(proposals.children?.[0]?.properties?.status).toBe("active");

      const routeProposal = await metaConsumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Route with active runtime skill",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: {
              id: "reviewer",
              name: "Reviewer",
              instructions: "Review routed work.",
            },
          },
          {
            type: "setCapabilityMask",
            mask: {
              id: "review-read",
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
              capabilityMaskIds: ["review-read"],
              skillVersionIds: ["review-runtime@1.0.0"],
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
      const routeProposalId = (routeProposal.data as { id: string }).id;
      expect(
        (await metaConsumer.invoke(`/proposals/${routeProposalId}`, "apply_proposal", {})).status,
      ).toBe("error");
      const routeApprovals = await metaConsumer.query("/approvals", 2);
      const routeApprovalId = routeApprovals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof routeApprovalId).toBe("string");
      expect(
        (await metaConsumer.invoke(`/approvals/${routeApprovalId}`, "approve", {})).status,
      ).toBe("ok");

      const dispatched = await metaConsumer.invoke("/session", "dispatch_route", {
        source: "root",
        message: "please review this topology",
      });
      expect(dispatched.status).toBe("ok");
      expect(delegation.spawns).toHaveLength(1);
      expect(String(delegation.spawns[0]?.goal)).toContain("# Review Runtime");
      expect(String(delegation.spawns[0]?.goal)).toContain(
        "Active runtime skills are frozen into this routed child run.",
      );
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("refuses to activate persistent linked skill proposals through meta-runtime apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const meta = new MetaRuntimeProvider({
      globalRoot: join(root, "global"),
      workspaceRoot: join(root, "workspace"),
    });
    const skills = new SkillsProvider({
      skillsDir: join(root, "skills"),
      workspaceSkillsDir: join(root, "workspace-skills"),
    });
    const metaRegistration = registeredMetaProvider(meta);
    const hub = new ConsumerHub([metaRegistration, registeredSkillsProvider(skills)], TEST_CONFIG);

    try {
      await hub.connect();
      const stop = metaRegistration.attachRuntime?.(hub, TEST_CONFIG);
      const metaConsumer = new SlopConsumer(new InProcessTransport(meta.server));
      const skillsConsumer = new SlopConsumer(new InProcessTransport(skills.server));
      await connect(metaConsumer);
      await connect(skillsConsumer);

      const skillProposal = await skillsConsumer.invoke("/session", "propose_skill", {
        scope: "workspace",
        name: "persistent-review-runtime",
        version: "1.0.0",
        body: "# Persistent Review Runtime\n\nReview topology changes.\n",
      });
      const skillProposalId = (skillProposal.data as { id: string }).id;

      const metaProposal = await metaConsumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Activate persistent review skill",
        ops: [
          {
            type: "activateSkillVersion",
            skillVersion: {
              id: "persistent-review-runtime@1.0.0",
              skillId: "persistent-review-runtime",
              version: "1.0.0",
              scope: "workspace",
              active: false,
              proposalId: skillProposalId,
              activationStatus: "pending",
            },
          },
        ],
      });
      const metaProposalId = (metaProposal.data as { id: string }).id;
      const blocked = await metaConsumer.invoke(
        `/proposals/${metaProposalId}`,
        "apply_proposal",
        {},
      );
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");

      const approvals = await metaConsumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      const approved = await metaConsumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approved.status).toBe("error");
      expect(approved.error?.message).toContain(
        "Activate it through the skills provider before applying this meta-runtime proposal",
      );

      const skillVersions = await metaConsumer.query("/skill-versions", 2);
      expect(skillVersions.properties?.count).toBe(0);
      const proposals = await skillsConsumer.query("/proposals", 2);
      expect(proposals.children?.[0]?.properties?.status).toBe("proposed");
      const skillApprovals = await skillsConsumer.query("/approvals", 2);
      expect(skillApprovals.properties?.count).toBe(0);
      const metaProposalNode = await metaConsumer.query(`/proposals/${metaProposalId}`, 1);
      expect(metaProposalNode.properties?.status).toBe("proposed");
      stop?.stop();
    } finally {
      hub.shutdown();
    }
  });

  test("does not apply linked skill topology when activation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const metaProposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Activate missing skill",
        ops: [
          {
            type: "activateSkillVersion",
            skillVersion: {
              id: "missing@1.0.0",
              skillId: "missing",
              version: "1.0.0",
              scope: "session",
              active: false,
              proposalId: "skill-proposal-missing",
              activationStatus: "pending",
            },
          },
        ],
      });
      const metaProposalId = (metaProposal.data as { id: string }).id;
      const blocked = await consumer.invoke(`/proposals/${metaProposalId}`, "apply_proposal", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      const approved = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approved.status).toBe("error");
      expect(approved.error?.message).toContain("No hub attached for skill activation");

      const skillVersions = await consumer.query("/skill-versions", 2);
      expect(skillVersions.properties?.count).toBe(0);
      const proposal = await consumer.query(`/proposals/${metaProposalId}`, 1);
      expect(proposal.properties?.status).toBe("proposed");
    } finally {
      provider.stop();
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
      const persisted = (await readPersistedMetaStateFile(workspaceRoot)) as {
        profiles: Array<{ id: string }>;
      };
      expect(persisted.profiles.map((profile) => profile.id)).toContain("imported");
    } finally {
      provider.stop();
    }
  });

  test("rejects malformed imported meta-runtime state before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const imported = await consumer.invoke("/session", "import_state", {
        scope: "session",
        state: {
          profiles: [{ name: "No Id" }],
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("state.profiles[0].id");

      const bundled = await consumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            profiles: [{ name: "No Id" }],
          },
          skills: [],
          notes: { secrets: "excluded" },
        },
      });
      expect(bundled.status).toBe("error");
      expect(bundled.error?.message).toContain("state.profiles[0].id");

      const forgedProposal = {
        id: "proposal-forged-global",
        scope: "global",
        summary: "Forged global write",
        status: "proposed",
        requiresApproval: false,
        createdAt: "2026-05-06T00:00:00.000Z",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "forged", name: "Forged" },
          },
        ],
      };
      const forgedImported = await consumer.invoke("/session", "import_state", {
        scope: "session",
        state: {
          proposals: [forgedProposal],
        },
      });
      expect(forgedImported.status).toBe("error");
      expect(forgedImported.error?.message).toContain("requiresApproval");

      const forgedBundle = await consumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            proposals: [forgedProposal],
          },
          skills: [],
          notes: { secrets: "excluded" },
        },
      });
      expect(forgedBundle.status).toBe("error");
      expect(forgedBundle.error?.message).toContain("requiresApproval");

      const profiles = await consumer.query("/profiles", 2);
      expect((profiles.children ?? []).map((child) => child.id)).not.toContain("undefined");
      expect(profiles.properties?.count).toBe(0);
      const proposals = await consumer.query("/proposals", 2);
      expect(proposals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("imported persistent-scope proposals still require approval on apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const imported = await consumer.invoke("/session", "import_state", {
        scope: "session",
        state: {
          proposals: [
            {
              id: "proposal-global-import",
              scope: "global",
              summary: "Imported global profile",
              status: "proposed",
              requiresApproval: true,
              createdAt: "2026-05-06T00:00:00.000Z",
              ops: [
                {
                  type: "upsertAgentProfile",
                  profile: { id: "global-imported", name: "Global Imported" },
                },
              ],
            },
          ],
        },
      });
      expect(imported.status).toBe("ok");

      const proposal = await consumer.query("/proposals/proposal-global-import", 1);
      expect(proposal.properties?.requiresApproval).toBe(true);
      const applied = await consumer.invoke(
        "/proposals/proposal-global-import",
        "apply_proposal",
        {},
      );
      expect(applied.status).toBe("error");
      expect(applied.error?.code).toBe("approval_required");
      const beforeApproval = await consumer.query("/profiles", 2);
      expect((beforeApproval.children ?? []).map((child) => child.id)).not.toContain(
        "global-imported",
      );

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect((await consumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe("ok");
      const afterApproval = await consumer.query("/profiles", 2);
      expect((afterApproval.children ?? []).map((child) => child.id)).toContain("global-imported");
    } finally {
      provider.stop();
    }
  });

  test("exports and imports portable runtime bundles with active skill contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const sourceMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "source-global"),
      workspaceRoot: join(root, "source-workspace"),
    });
    const sourceSkills = new SkillsProvider({ skillsDir: join(root, "source-skills") });
    const sourceMetaRegistration = registeredMetaProvider(sourceMeta);
    const sourceHub = new ConsumerHub(
      [sourceMetaRegistration, registeredSkillsProvider(sourceSkills)],
      TEST_CONFIG,
    );

    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await sourceHub.connect();
      const sourceStop = sourceMetaRegistration.attachRuntime?.(sourceHub, TEST_CONFIG);
      const sourceMetaConsumer = new SlopConsumer(new InProcessTransport(sourceMeta.server));
      const sourceSkillsConsumer = new SlopConsumer(new InProcessTransport(sourceSkills.server));
      await connect(sourceMetaConsumer);
      await connect(sourceSkillsConsumer);

      expect(
        (
          await sourceSkillsConsumer.invoke("/session", "skill_manage", {
            operation: "create",
            scope: "session",
            name: "bundle-review",
            content: "# Bundle Review\n\nReview imported topology.\n",
          })
        ).status,
      ).toBe("ok");

      const proposal = await sourceMetaConsumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Bundle identity",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Reviewer", instructions: "Review bundles." },
          },
          {
            type: "activateSkillVersion",
            skillVersion: {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          },
        ],
      });
      const proposalId = (proposal.data as { id: string }).id;
      expect(
        (await sourceMetaConsumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {})).status,
      ).toBe("error");
      const approvals = await sourceMetaConsumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect(
        (await sourceMetaConsumer.invoke(`/approvals/${approvalId}`, "approve", {})).status,
      ).toBe("ok");

      const exported = await sourceMetaConsumer.invoke("/session", "export_bundle", {});
      expect(exported.status).toBe("ok");
      const bundle = exported.data as {
        kind: string;
        state: { profiles?: Array<{ id: string }> };
        skills: Array<{ name: string; content: string; content_sha256?: string }>;
        notes: { secrets: string };
      };
      expect(bundle.kind).toBe("sloppy.meta-runtime.bundle");
      expect(bundle.notes.secrets).toBe("excluded");
      expect(bundle.state.profiles?.map((profile) => profile.id)).toContain("reviewer");
      expect(bundle.skills[0]?.name).toBe("bundle-review");
      expect(bundle.skills[0]?.content).toContain("# Bundle Review");
      expect(bundle.skills[0]?.content_sha256).toMatch(/^[a-f0-9]{64}$/);

      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
      });
      expect(imported.status).toBe("ok");
      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect(importedProfiles.children?.map((child) => child.id)).toContain("reviewer");
      const importedSkillVersions = await targetMetaConsumer.query("/skill-versions", 2);
      expect(importedSkillVersions.children?.map((child) => child.id)).toContain(
        "bundle-review@1.0.0",
      );
      const importedSkill = await targetSkillsConsumer.invoke("/session", "view_skill", {
        name: "bundle-review",
      });
      expect(importedSkill.status).toBe("ok");
      expect((importedSkill.data as { content: string }).content).toContain(
        "Review imported topology.",
      );
      sourceStop?.stop();
      targetStop?.stop();
    } finally {
      sourceHub.shutdown();
      targetHub.shutdown();
    }
  });

  test("import_bundle dry_run reports skill import plan without committing topology", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      const bundle = {
        kind: "sloppy.meta-runtime.bundle",
        schema_version: 1,
        exported_at: "2026-05-06T00:00:00.000Z",
        scope: "merged",
        state: {
          profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
          skillVersions: [
            {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          ],
        },
        skills: [
          {
            name: "bundle-review",
            content: "# Bundle Review\n\nReview imported topology.\n",
          },
        ],
        notes: { secrets: "excluded" },
      };

      const preview = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
        dry_run: true,
      });
      expect(preview.status).toBe("ok");
      expect(preview.data).toMatchObject({
        scope: "session",
        mode: "merge",
        imported: false,
        dry_run: true,
        skills: {
          created: ["bundle-review"],
          skipped: [],
          failed: [],
        },
        required_skills: {
          count: 1,
          missing: [],
        },
      });

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      const importedSkill = await targetSkillsConsumer.invoke("/session", "view_skill", {
        name: "bundle-review",
      });
      expect(importedSkill.status).toBe("error");
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle does not commit topology when bundled skill import fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      await connect(targetMetaConsumer);

      const bundle = {
        kind: "sloppy.meta-runtime.bundle",
        schema_version: 1,
        exported_at: "2026-05-06T00:00:00.000Z",
        scope: "merged",
        state: {
          profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
          skillVersions: [
            {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          ],
        },
        skills: [
          {
            name: "bundle-review",
            content: "# Bundle Review\n\nReview imported topology.\n",
          },
        ],
        notes: { secrets: "excluded" },
      };

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
        skill_scope: "workspace",
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("topology was not imported");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      const importedSkillVersions = await targetMetaConsumer.query("/skill-versions", 2);
      expect((importedSkillVersions.children ?? []).map((child) => child.id)).not.toContain(
        "bundle-review@1.0.0",
      );
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle rejects mismatched bundled skill hashes before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      await connect(targetMetaConsumer);

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
            skillVersions: [
              {
                id: "bundle-review@1.0.0",
                skillId: "bundle-review",
                version: "1.0.0",
                scope: "session",
                active: true,
                activationStatus: "active",
              },
            ],
          },
          skills: [
            {
              name: "bundle-review",
              content: "# Bundle Review\n\nTampered content.\n",
              content_sha256: "0".repeat(64),
            },
          ],
          notes: { secrets: "excluded" },
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("content_sha256");

      const importedFileHash = await targetMetaConsumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {},
          skills: [
            {
              name: "bundle-review",
              content: "# Bundle Review\n\nContent.\n",
              files: [{ path: "notes.md", content: "notes", sha256: "0".repeat(64) }],
            },
          ],
          notes: { secrets: "excluded" },
        },
      });
      expect(importedFileHash.status).toBe("error");
      expect(importedFileHash.error?.message).toContain("files[0].sha256");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle preflights existing skill collisions before topology mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      expect(
        (
          await targetSkillsConsumer.invoke("/session", "skill_manage", {
            operation: "create",
            scope: "session",
            name: "bundle-review",
            content: "# Bundle Review\n\nExisting target content.\n",
          })
        ).status,
      ).toBe("ok");

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        scope: "session",
        skip_existing_skills: false,
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
            skillVersions: [
              {
                id: "bundle-review@1.0.0",
                skillId: "bundle-review",
                version: "1.0.0",
                scope: "session",
                active: true,
                activationStatus: "active",
              },
            ],
          },
          skills: [
            {
              name: "bundle-review",
              content: "# Bundle Review\n\nExisting target content.\n",
            },
          ],
          notes: { secrets: "excluded" },
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("does not overwrite existing skills");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle rejects same-name skill collisions with different content", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      expect(
        (
          await targetSkillsConsumer.invoke("/session", "skill_manage", {
            operation: "create",
            scope: "session",
            name: "bundle-review",
            content: "# Bundle Review\n\nExisting target content.\n",
          })
        ).status,
      ).toBe("ok");

      const bundle = {
        kind: "sloppy.meta-runtime.bundle",
        schema_version: 1,
        exported_at: "2026-05-06T00:00:00.000Z",
        scope: "merged",
        state: {
          profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
          skillVersions: [
            {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          ],
        },
        skills: [
          {
            name: "bundle-review",
            content: "# Bundle Review\n\nBundled source content.\n",
          },
        ],
        notes: { secrets: "excluded" },
      };

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("Existing skill content differs");
      expect(imported.error?.message).toContain("topology was not imported");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      const importedSkillVersions = await targetMetaConsumer.query("/skill-versions", 2);
      expect((importedSkillVersions.children ?? []).map((child) => child.id)).not.toContain(
        "bundle-review@1.0.0",
      );
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
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
        skills: { skillsDir: "~/.sloppy/skills" },
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

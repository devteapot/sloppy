import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { action, createSlopServer } from "@slop-ai/server";

import { ConsumerHub } from "../src/core/consumer";
import { MetaRuntimeProvider } from "../src/plugins/first-party/meta-runtime/provider";
import { InProcessTransport } from "../src/providers/in-process";
import type { RegisteredProvider } from "../src/providers/registry";
import { createTestConfig } from "./helpers/config";

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
    kind: "first-party",
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
      kind: "first-party",
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
      kind: "first-party",
      transport: new InProcessTransport(server),
      transportLabel: "in-process:test",
      stop: () => server.stop(),
    },
    sent,
    envelopes,
  };
}

const TEST_CONFIG = createTestConfig({
  agent: { maxIterations: 1 },
});

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

describe("MetaRuntimeProvider — routing", () => {
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
});

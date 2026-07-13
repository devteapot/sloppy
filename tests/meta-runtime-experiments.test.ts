import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { action, createSlopServer } from "@slop-ai/server";

import { ConsumerHub } from "../src/core/consumer";
import type { DelegationService } from "../src/plugins/first-party/delegation/service";
import type { MessagingService } from "../src/plugins/first-party/messaging/service";
import { MetaRuntimeProvider } from "../src/plugins/first-party/meta-runtime/provider";
import {
  DELEGATION_SERVICE,
  MESSAGING_SERVICE,
  SKILLS_SERVICE,
} from "../src/plugins/first-party/service-keys";
import { SkillsProvider } from "../src/plugins/first-party/skills/provider";
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
  };
}

function delegationStub(): {
  provider: RegisteredProvider;
  service: DelegationService;
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
    service: {
      spawnAgent: (request) => {
        spawns.push(request);
        return {
          id: "agent-spawned",
          status: "pending",
          created_at: new Date().toISOString(),
          execution_mode: "native",
        };
      },
    },
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
  service: MessagingService;
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
    service: {
      sendMessage: (channelId, message, envelope) => {
        sent.push(message);
        envelopes.push(envelope);
        return { id: "message-1", channel_id: channelId, sent_at: new Date().toISOString() };
      },
    },
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

function registeredSkillsProvider(provider: SkillsProvider): RegisteredProvider {
  return {
    id: "skills",
    name: "Skills",
    kind: "first-party",
    transport: new InProcessTransport(provider.server),
    transportLabel: "in-process:test",
    stop: () => provider.stop(),
    approvals: provider.approvals,
  };
}

const TEST_CONFIG = createTestConfig({
  agent: { maxIterations: 1 },
});

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

describe("MetaRuntimeProvider — experiments and skills", () => {
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
    meta.bindRuntimeService(MESSAGING_SERVICE, messaging.service);
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
    meta.bindRuntimeService(SKILLS_SERVICE, skills);
    meta.bindRuntimeService(DELEGATION_SERVICE, delegation.service);
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
    meta.bindRuntimeService(SKILLS_SERVICE, skills);
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
      expect(approved.error?.message).toContain("Skills runtime service is not enabled");

      const skillVersions = await consumer.query("/skill-versions", 2);
      expect(skillVersions.properties?.count).toBe(0);
      const proposal = await consumer.query(`/proposals/${metaProposalId}`, 1);
      expect(proposal.properties?.status).toBe("proposed");
    } finally {
      provider.stop();
    }
  });
});

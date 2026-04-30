import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import {
  type DelegationAgentSpawn,
  DelegationProvider,
  type DelegationRunnerFactory,
} from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { OrchestrationProvider } from "../src/providers/builtin/orchestration";
import { SpecProvider } from "../src/providers/builtin/spec";
import { AutonomousGoalCoordinator } from "../src/runtime/orchestration/autonomous-coordinator";

const tempPaths: string[] = [];

const TEST_CONFIG: SloppyConfig = {
  llm: { provider: "openai", model: "gpt-5.4", profiles: [], maxTokens: 4096 },
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
      delegation: true,
      orchestration: true,
      spec: true,
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
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: { maxAgents: 4 },
    orchestration: { progressTailMaxChars: 2048, finalAuditCommandTimeoutMs: 30000 },
    vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
  },
};

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("autonomous goal pipeline (Phase 2)", () => {
  test("autonomous goal spawns spec-agent; spec acceptance spawns planner", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-autonomous-"));
    tempPaths.push(root);
    const hub = new ConsumerHub([], TEST_CONFIG);
    await hub.connect();

    const observedSpawns: DelegationAgentSpawn[] = [];

    const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "auto" });
    const spec = new SpecProvider({ workspaceRoot: root });

    const runnerFactory: DelegationRunnerFactory = (spawn, callbacks) => ({
      async start() {
        observedSpawns.push(spawn);
        callbacks.onUpdate({ status: "running" });

        try {
          if (spawn.roleId === "spec-agent") {
            // Mock spec-agent: create a spec for the goal extracted from name.
            const goalId = spawn.name.replace(/^spec-agent:/, "");
            const created = await hub.invoke("spec", "/specs", "create_spec", {
              title: "Autonomous spec",
              body: "# Spec\nDeliver feature.",
              goal_id: goalId,
            });
            if (created.status !== "ok") {
              throw new Error(`create_spec failed: ${JSON.stringify(created.error)}`);
            }
            const specId = (created.data as { id: string }).id;
            const specVersion = (created.data as { version: number }).version;
            // Open spec_accept gate (HITL — coordinator does not auto-accept).
            await hub.invoke("orchestration", "/gates", "open_gate", {
              gate_type: "spec_accept",
              subject_ref: `spec:${specId}:v${specVersion}`,
              summary: "Accept autonomous spec.",
            });
            callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
          } else if (spawn.roleId === "planner") {
            const specMatch = /# Spec: ([^\s]+) \(v(\d+)\)/.exec(spawn.goal);
            if (!specMatch) throw new Error(`planner prompt missing spec header: ${spawn.goal}`);
            const createdPlan = await hub.invoke(
              "orchestration",
              "/orchestration",
              "create_plan_revision",
              {
                query: "Implement autonomous feature",
                goal_id: spawn.idempotencyKey?.split(":")[1],
                spec_id: specMatch[1],
                spec_version: Number(specMatch[2]),
                planned_commit: "HEAD",
                slices: [
                  {
                    name: "Implement slice",
                    goal: "Make the requested feature work.",
                    kind: "implementation",
                    spec_refs: [`spec:${specMatch[1]}`],
                    acceptance_criteria: ["Feature works"],
                  },
                ],
              },
            );
            if (createdPlan.status !== "ok") {
              throw new Error(`create_plan_revision failed: ${JSON.stringify(createdPlan.error)}`);
            }
            callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
          } else {
            callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
          }
        } catch (err) {
          callbacks.onUpdate({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            completed_at: new Date().toISOString(),
          });
        }
      },
      async cancel() {
        callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
      },
    });
    const delegation = new DelegationProvider({ maxAgents: 4, runnerFactory });

    await hub.addProvider({
      id: "orchestration",
      name: "Orchestration",
      kind: "builtin",
      transport: new InProcessTransport(orchestration.server),
      transportLabel: "in-process",
      stop: () => orchestration.stop(),
    });
    await hub.addProvider({
      id: "spec",
      name: "Specs",
      kind: "builtin",
      transport: new InProcessTransport(spec.server),
      transportLabel: "in-process",
      stop: () => spec.stop(),
    });
    await hub.addProvider({
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(delegation.server),
      transportLabel: "in-process",
      stop: () => delegation.stop(),
    });

    const coordinator = new AutonomousGoalCoordinator({ hub });
    await coordinator.start();

    const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    try {
      // Create an autonomous goal — coordinator should spawn a spec-agent.
      const created = await consumer.invoke("/goals", "create_goal", {
        title: "Ship feature",
        intent: "Deliver feature autonomously.",
        autonomous: true,
      });
      expect(created.status).toBe("ok");

      await waitFor(
        () => observedSpawns.some((spawn) => spawn.roleId === "spec-agent"),
        "spec-agent to be spawned for autonomous goal",
      );

      // Wait for the mock spec-agent to open the spec_accept gate.
      await waitFor(async () => {
        const gates = await consumer.query("/gates", 2);
        return (
          gates.children?.some(
            (gate) =>
              gate.properties?.gate_type === "spec_accept" && gate.properties?.status === "open",
          ) ?? false
        );
      }, "spec_accept gate to be opened by mock spec-agent");

      // User accepts the spec gate; coordinator should spawn the planner.
      const gates = await consumer.query("/gates", 2);
      const specGate = gates.children?.find(
        (gate) =>
          gate.properties?.gate_type === "spec_accept" && gate.properties?.status === "open",
      );
      expect(specGate?.id).toBeString();
      await consumer.invoke(`/gates/${specGate?.id}`, "resolve_gate", { status: "accepted" });
      const specRef = specGate?.properties?.subject_ref;
      expect(specRef).toBeString();
      const specMatch = /^spec:(.+):v\d+$/.exec(String(specRef));
      expect(specMatch?.[1]).toBeString();
      const accepted = await hub.invoke("spec", `/specs/${specMatch?.[1]}`, "accept_spec", {
        gate_id: specGate?.id,
      });
      expect(accepted.status).toBe("ok");

      await waitFor(
        () => observedSpawns.some((spawn) => spawn.roleId === "planner"),
        "planner to be spawned after spec acceptance",
      );

      await waitFor(async () => {
        const gatesAfterPlanner = await consumer.query("/gates", 2);
        return (
          gatesAfterPlanner.children?.some(
            (gate) =>
              gate.properties?.gate_type === "plan_accept" && gate.properties?.status === "open",
          ) ?? false
        );
      }, "plan_accept gate opened by mock planner");

      const gatesAfterPlanner = await consumer.query("/gates", 2);
      const planGate = gatesAfterPlanner.children?.find(
        (gate) =>
          gate.properties?.gate_type === "plan_accept" && gate.properties?.status === "open",
      );
      expect(planGate?.id).toBeString();
      await consumer.invoke(`/gates/${planGate?.id}`, "resolve_gate", { status: "accepted" });

      await waitFor(
        () => observedSpawns.some((spawn) => spawn.roleId === "executor"),
        "executor to be spawned after plan acceptance",
      );

      const specSpawns = observedSpawns.filter((spawn) => spawn.roleId === "spec-agent");
      const plannerSpawns = observedSpawns.filter((spawn) => spawn.roleId === "planner");
      const executorSpawns = observedSpawns.filter((spawn) => spawn.roleId === "executor");
      expect(specSpawns.length).toBe(1);
      expect(plannerSpawns.length).toBe(1);
      expect(executorSpawns.length).toBe(1);
      expect(executorSpawns[0]?.idempotencyKey).toStartWith("orchestration:executor:");
    } finally {
      await coordinator.stop();
      orchestration.stop();
      spec.stop();
      hub.shutdown();
    }
  });

  test("event bursts do not duplicate autonomous spawns", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-autonomous-"));
    tempPaths.push(root);
    const hub = new ConsumerHub([], TEST_CONFIG);
    await hub.connect();

    const observedSpawns: DelegationAgentSpawn[] = [];
    const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "auto" });
    const spec = new SpecProvider({ workspaceRoot: root });

    const runnerFactory: DelegationRunnerFactory = (spawn, callbacks) => ({
      async start() {
        observedSpawns.push(spawn);
        callbacks.onUpdate({ status: "running" });
        await Bun.sleep(25);
        callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
      },
      async cancel() {
        callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
      },
    });
    const delegation = new DelegationProvider({ maxAgents: 4, runnerFactory });

    await hub.addProvider({
      id: "orchestration",
      name: "Orchestration",
      kind: "builtin",
      transport: new InProcessTransport(orchestration.server),
      transportLabel: "in-process",
      stop: () => orchestration.stop(),
    });
    await hub.addProvider({
      id: "spec",
      name: "Spec",
      kind: "builtin",
      transport: new InProcessTransport(spec.server),
      transportLabel: "in-process",
      stop: () => spec.stop(),
    });
    await hub.addProvider({
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(delegation.server),
      transportLabel: "in-process",
      stop: () => delegation.stop(),
    });

    const coordinator = new AutonomousGoalCoordinator({ hub });
    await coordinator.start();
    const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    try {
      const createdGoal = await consumer.invoke("/goals", "create_goal", {
        title: "Burst goal",
        intent: "Exercise coordinator event queue.",
        autonomous: true,
      });
      expect(createdGoal.status).toBe("ok");
      const goalId = (createdGoal.data as { id: string }).id;

      await Promise.all([
        consumer.invoke(`/goals/${goalId}`, "revise_goal", {
          intent: "burst 1",
          magnitude: "minor",
        }),
        consumer.invoke(`/goals/${goalId}`, "revise_goal", {
          intent: "burst 2",
          magnitude: "minor",
        }),
        consumer.invoke(`/goals/${goalId}`, "revise_goal", {
          intent: "burst 3",
          magnitude: "minor",
        }),
      ]);

      await waitFor(
        () => observedSpawns.some((spawn) => spawn.roleId === "spec-agent"),
        "spec-agent spawn after burst",
      );

      const createdSpec = await hub.invoke("spec", "/specs", "create_spec", {
        title: "Burst spec",
        body: "Accepted burst spec.",
        goal_id: goalId,
      });
      expect(createdSpec.status).toBe("ok");
      const specId = (createdSpec.data as { id: string }).id;
      const specVersion = (createdSpec.data as { version: number }).version;
      const gate = await consumer.invoke("/gates", "open_gate", {
        gate_type: "spec_accept",
        subject_ref: `spec:${specId}:v${specVersion}`,
        summary: "Accept burst spec.",
      });
      expect(gate.status).toBe("ok");
      const gateId = (gate.data as { id: string }).id;

      await Promise.all([
        consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" }),
        hub.invoke("spec", `/specs/${specId}`, "accept_spec", { gate_id: gateId }),
      ]);

      await waitFor(
        () => observedSpawns.some((spawn) => spawn.roleId === "planner"),
        "planner spawn after burst",
      );

      expect(observedSpawns.filter((spawn) => spawn.roleId === "spec-agent")).toHaveLength(1);
      expect(observedSpawns.filter((spawn) => spawn.roleId === "planner")).toHaveLength(1);
      expect(observedSpawns.map((spawn) => spawn.idempotencyKey)).toContain(
        `autonomous:${goalId}:spec-agent`,
      );
      expect(observedSpawns.map((spawn) => spawn.idempotencyKey)).toContain(
        `autonomous:${goalId}:planner:${specId}:v${specVersion + 1}`,
      );
    } finally {
      await coordinator.stop();
      orchestration.stop();
      spec.stop();
      hub.shutdown();
    }
  });

  test("coordinator records degraded health when critical refresh fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-autonomous-"));
    tempPaths.push(root);
    const hub = new ConsumerHub([], TEST_CONFIG);
    await hub.connect();

    const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "auto" });
    const delegation = new DelegationProvider({
      maxAgents: 4,
      runnerFactory: (_spawn, callbacks) => ({
        async start() {
          callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
        },
        async cancel() {
          callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
        },
      }),
    });

    await hub.addProvider({
      id: "orchestration",
      name: "Orchestration",
      kind: "builtin",
      transport: new InProcessTransport(orchestration.server),
      transportLabel: "in-process",
      stop: () => orchestration.stop(),
    });
    await hub.addProvider({
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(delegation.server),
      transportLabel: "in-process",
      stop: () => delegation.stop(),
    });

    const coordinator = new AutonomousGoalCoordinator({ hub, specProviderId: "missing-spec" });
    await coordinator.start();
    const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    try {
      await consumer.invoke("/goals", "create_goal", {
        title: "Health goal",
        intent: "Force missing spec refresh.",
        autonomous: true,
      });
      await consumer.invoke("/gates", "open_gate", {
        gate_type: "spec_accept",
        subject_ref: "spec:missing:v1",
        summary: "Accepted missing spec.",
      });
      const gates = await consumer.query("/gates", 2);
      const gate = gates.children?.find((child) => child.properties?.gate_type === "spec_accept");
      await consumer.invoke(`/gates/${gate?.id}`, "resolve_gate", { status: "accepted" });

      await waitFor(
        () => coordinator.getHealth().status === "degraded",
        "degraded coordinator health",
      );
      expect(coordinator.getHealth()).toMatchObject({
        status: "degraded",
        lastError: { providerId: "missing-spec", operation: "refreshSpecs" },
      });
    } finally {
      await coordinator.stop();
      orchestration.stop();
      hub.shutdown();
    }
  });

  test("non-autonomous goal does not spawn spec-agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-autonomous-"));
    tempPaths.push(root);
    const hub = new ConsumerHub([], TEST_CONFIG);
    await hub.connect();

    const observedSpawns: DelegationAgentSpawn[] = [];

    const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "auto" });
    const spec = new SpecProvider({ workspaceRoot: root });

    const runnerFactory: DelegationRunnerFactory = (spawn, callbacks) => ({
      async start() {
        observedSpawns.push(spawn);
        callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
      },
      async cancel() {
        callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
      },
    });
    const delegation = new DelegationProvider({ maxAgents: 4, runnerFactory });

    await hub.addProvider({
      id: "orchestration",
      name: "Orchestration",
      kind: "builtin",
      transport: new InProcessTransport(orchestration.server),
      transportLabel: "in-process",
      stop: () => orchestration.stop(),
    });
    await hub.addProvider({
      id: "spec",
      name: "Specs",
      kind: "builtin",
      transport: new InProcessTransport(spec.server),
      transportLabel: "in-process",
      stop: () => spec.stop(),
    });
    await hub.addProvider({
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(delegation.server),
      transportLabel: "in-process",
      stop: () => delegation.stop(),
    });

    const coordinator = new AutonomousGoalCoordinator({ hub });
    await coordinator.start();

    const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    try {
      const created = await consumer.invoke("/goals", "create_goal", {
        title: "Ship feature manually",
        intent: "Manual goal.",
      });
      expect(created.status).toBe("ok");

      // Give the coordinator a moment to (not) react.
      await Bun.sleep(100);
      expect(observedSpawns.length).toBe(0);
    } finally {
      await coordinator.stop();
      orchestration.stop();
      spec.stop();
      hub.shutdown();
    }
  });
});

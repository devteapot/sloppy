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
            const created = await hub.invoke("specs", "/specs", "create_spec", {
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
      id: "specs",
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

      await waitFor(
        () => observedSpawns.some((spawn) => spawn.roleId === "planner"),
        "planner to be spawned after spec acceptance",
      );

      const specSpawns = observedSpawns.filter((spawn) => spawn.roleId === "spec-agent");
      const plannerSpawns = observedSpawns.filter((spawn) => spawn.roleId === "planner");
      expect(specSpawns.length).toBe(1);
      expect(plannerSpawns.length).toBe(1);
    } finally {
      await coordinator.stop();
      orchestration.stop();
      spec.stop();
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
      id: "specs",
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

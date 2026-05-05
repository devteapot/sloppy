import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { RoleRegistry } from "../src/core/role";
import {
  type DelegationAgentSpawn,
  DelegationProvider,
  type DelegationRunnerFactory,
} from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { OrchestrationProvider } from "../src/providers/builtin/orchestration";
import { SpecProvider } from "../src/providers/builtin/spec";
import { OrchestrationScheduler } from "../src/runtime/orchestration";
import { attachOrchestrationRuntime } from "../src/runtime/orchestration/attach";

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
  for (let i = 0; i < 120; i += 1) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function spawnRole(spawn: DelegationAgentSpawn): string | undefined {
  return spawn.roleId ?? spawn.name.split(":")[0];
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "sloppy-autonomous-runtime-"));
  tempPaths.push(root);

  const config: SloppyConfig = {
    ...TEST_CONFIG,
    providers: {
      ...TEST_CONFIG.providers,
      filesystem: { ...TEST_CONFIG.providers.filesystem, root },
    },
  };
  const hub = new ConsumerHub([], config);
  await hub.connect();

  const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "autonomous" });
  const spec = new SpecProvider({ workspaceRoot: root });
  const observedSpawns: DelegationAgentSpawn[] = [];

  const runnerFactory: DelegationRunnerFactory = (spawn, callbacks) => ({
    async start() {
      observedSpawns.push(spawn);
      callbacks.onUpdate({ status: "running" });

      try {
        if (spawnRole(spawn) === "spec-agent") {
          const goalId = spawn.name.replace(/^spec-agent:/, "");
          const created = await hub.invoke("spec", "/specs", "create_spec", {
            title: `Spec for ${goalId}`,
            body: "Autonomous smoke spec body.",
            goal_id: goalId,
          });
          if (created.status !== "ok")
            throw new Error(`create_spec failed: ${created.error?.message}`);
          const specId =
            (created.data as { id?: string; spec_id?: string }).id ??
            (created.data as { spec_id?: string }).spec_id;
          if (!specId)
            throw new Error(`create_spec returned no spec id: ${JSON.stringify(created)}`);
          await hub.invoke("spec", `/specs/${specId}`, "add_requirement", {
            text: "Smoke proof is dispatchable.",
            priority: "must",
            criterion_kind: "text",
          });
          const gate = await hub.invoke("orchestration", "/gates", "open_gate", {
            gate_type: "spec_accept",
            resolver: "user",
            subject_ref: `spec:${specId}:v2`,
            summary: "Accept autonomous smoke spec.",
          });
          if (gate.status !== "ok")
            throw new Error(`open spec gate failed: ${gate.error?.message}`);
          const gateId =
            (gate.data as { id?: string; gate_id?: string }).id ??
            (gate.data as { gate_id?: string }).gate_id;
          if (!gateId)
            throw new Error(`open spec gate returned no gate id: ${JSON.stringify(gate)}`);
          const resolved = await hub.invoke("orchestration", `/gates/${gateId}`, "resolve_gate", {
            status: "accepted",
          });
          if (resolved.status !== "ok")
            throw new Error(`resolve spec gate failed: ${resolved.error?.message}`);
          const accepted = await hub.invoke("spec", `/specs/${specId}`, "accept_spec", {
            gate_id: gateId,
          });
          if (accepted.status !== "ok")
            throw new Error(`accept spec failed: ${accepted.error?.message}`);
        }

        if (spawnRole(spawn) === "planner") {
          const goalId = spawn.name.replace(/^planner:/, "");
          const specMatch = /# Spec: (\S+) \(v(\d+)\)/.exec(spawn.goal);
          if (!specMatch) throw new Error(`planner spawn goal missing spec ref: ${spawn.goal}`);
          const specId = specMatch[1];
          const specVersion = Number(specMatch[2]);
          const revision = await hub.invoke(
            "orchestration",
            "/orchestration",
            "create_plan_revision",
            {
              query: "Autonomous smoke plan",
              goal_id: goalId,
              spec_id: specId,
              spec_version: specVersion,
              planned_commit: "HEAD",
              slice_gate_resolver: "policy",
              slices: [
                {
                  name: "smoke-dispatch",
                  goal: "Prove the scheduler dispatches the autonomous executor.",
                  spec_refs: ["spec:autonomous-smoke-spec:v1"],
                  acceptance_criteria: ["Executor was dispatched"],
                  structural_assumptions: ["In-process smoke harness"],
                },
              ],
            },
          );
          if (revision.status !== "ok") {
            throw new Error(`create_plan_revision failed: ${revision.error?.message}`);
          }
          const planGateId = (revision.data as { gate_id: string }).gate_id;
          await hub.invoke("orchestration", `/gates/${planGateId}`, "resolve_gate", {
            status: "accepted",
          });
        }

        if (spawnRole(spawn) === "executor" && spawn.externalTaskId) {
          await hub.invoke("orchestration", `/tasks/${spawn.externalTaskId}`, "start", {});
          await hub.invoke(
            "orchestration",
            `/tasks/${spawn.externalTaskId}`,
            "record_verification",
            {
              kind: "smoke",
              status: "not_required",
              summary: "Autonomous executor smoke uses synthetic delegated completion.",
              criteria: ["all"],
            },
          );
          await hub.invoke(
            "orchestration",
            `/tasks/${spawn.externalTaskId}`,
            "start_verification",
            {},
          );
          const sliceGate = await hub.invoke("orchestration", "/gates", "open_gate", {
            gate_type: "slice_gate",
            resolver: "policy",
            subject_ref: `slice:${spawn.externalTaskId}`,
            summary: "Accept autonomous smoke slice.",
          });
          const sliceGateId =
            (sliceGate.data as { id?: string; gate_id?: string }).id ??
            (sliceGate.data as { gate_id?: string }).gate_id;
          if (!sliceGateId)
            throw new Error(`open slice gate returned no gate id: ${JSON.stringify(sliceGate)}`);
          await hub.invoke("orchestration", `/gates/${sliceGateId}`, "resolve_gate", {
            status: "accepted",
          });
          await hub.invoke("orchestration", `/tasks/${spawn.externalTaskId}`, "complete", {
            result: "Autonomous executor smoke task completed.",
          });
          await hub.invoke("orchestration", "/audit", "run_final_audit", {});
        }

        callbacks.onUpdate({ status: "completed", completed_at: new Date().toISOString() });
      } catch (error) {
        callbacks.onUpdate({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          completed_at: new Date().toISOString(),
        });
        throw error;
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

  const roleRegistry = new RoleRegistry();
  const attached = attachOrchestrationRuntime(hub, config, {
    hub,
    config,
    publishEvent: () => {},
    roleRegistry,
  });
  const scheduler = new OrchestrationScheduler({ hub, maxAgents: 4 });
  await scheduler.start();

  const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
  await consumer.connect();
  await consumer.subscribe("/", 3);

  return { consumer, hub, orchestration, spec, delegation, attached, scheduler, observedSpawns };
}

describe("autonomous runtime smoke", () => {
  test("goal creation drives spec-agent, planner, and executor dispatch", async () => {
    const { consumer, hub, orchestration, spec, delegation, attached, scheduler, observedSpawns } =
      await harness();
    try {
      const goal = await consumer.invoke("/goals", "create_goal", {
        title: "Autonomous smoke",
        intent: "Prove autonomous coordinator dispatches the first runtime chain.",
        autonomous: true,
      });
      expect(goal.status).toBe("ok");

      try {
        await waitFor(
          () => observedSpawns.some((spawn) => spawnRole(spawn) === "executor"),
          "executor dispatch",
        );
      } catch (error) {
        const agents = await hub.queryState({
          providerId: "delegation",
          path: "/agents",
          depth: 2,
        });
        const gates = await hub.queryState({
          providerId: "orchestration",
          path: "/gates",
          depth: 2,
        });
        const specs = await hub.queryState({ providerId: "spec", path: "/specs", depth: 2 });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; spawns=${JSON.stringify(
            observedSpawns.map((spawn) => ({
              name: spawn.name,
              roleId: spawn.roleId,
              role: spawnRole(spawn),
            })),
          )}; agents=${JSON.stringify(agents.children?.map((child) => child.properties))}; gates=${JSON.stringify(gates)}; specs=${JSON.stringify(specs)}`,
        );
      }

      expect(observedSpawns.map((spawn) => spawnRole(spawn))).toEqual([
        "spec-agent",
        "planner",
        "executor",
      ]);
      expect(observedSpawns[0].name).toStartWith("spec-agent:");
      expect(observedSpawns[1].name).toStartWith("planner:");
      expect(observedSpawns[2].externalTaskId).toBeTruthy();
      const goalId = (goal.data as { id: string }).id;
      try {
        await waitFor(async () => {
          const node = await consumer.query(`/goals/${goalId}`, 1);
          const lifecycle = node.properties?.autonomous_lifecycle as
            | { stage?: string; refs?: Record<string, string> }
            | undefined;
          return lifecycle?.stage === "goal.completed";
        }, "goal.completed lifecycle stage");
      } catch (error) {
        const goalNode = await consumer.query(`/goals/${goalId}`, 1);
        const tasks = await hub.queryState({
          providerId: "orchestration",
          path: "/tasks",
          depth: 2,
        });
        const plan = await hub.queryState({
          providerId: "orchestration",
          path: "/orchestration",
          depth: 1,
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; lifecycle=${JSON.stringify(
            goalNode.properties?.autonomous_lifecycle,
          )}; tasks=${JSON.stringify(tasks.children?.map((child) => child.properties))}; plan=${JSON.stringify(
            plan.properties,
          )}`,
        );
      }
      await waitFor(async () => {
        const plan = await consumer.query("/orchestration", 1);
        return plan.properties?.plan_status === "completed";
      }, "autonomous plan completion");
    } finally {
      await scheduler.stop();
      attached.stop();
      orchestration.stop();
      spec.stop();
      delegation.stop();
      hub.shutdown();
    }
  });
});

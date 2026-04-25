import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import {
  DelegationProvider,
  type DelegationAgentSpawn,
  type DelegationRunnerFactory,
} from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { OrchestrationProvider } from "../src/providers/builtin/orchestration";
import { OrchestrationScheduler } from "../src/runtime/orchestration";

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
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: { maxAgents: 2 },
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
  for (let i = 0; i < 80; i += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type ExecutorBehavior = "submit_evidence" | "escalate";

async function harness(behavior: ExecutorBehavior = "submit_evidence") {
  const root = await mkdtemp(join(tmpdir(), "sloppy-exec-autonomy-"));
  tempPaths.push(root);
  const hub = new ConsumerHub([], TEST_CONFIG);
  await hub.connect();

  const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "exec" });

  const observedSpawns: DelegationAgentSpawn[] = [];

  const runnerFactory: DelegationRunnerFactory = (spawn, callbacks) => ({
    async start() {
      observedSpawns.push(spawn);
      const taskId = spawn.externalTaskId;
      callbacks.onUpdate({ status: "running" });
      if (!taskId) {
        callbacks.onUpdate({
          status: "completed",
          completed_at: new Date().toISOString(),
        });
        return;
      }
      // Simulate the executor's tool-use sequence: start, then either submit
      // evidence covering all criteria or escalate the slice.
      try {
        await hub.invoke("orchestration", `/tasks/${taskId}`, "start", {});
        const taskNode = await hub.queryState({
          providerId: "orchestration",
          path: `/tasks/${taskId}`,
          depth: 1,
        });
        const criteria = (taskNode.properties?.acceptance_criteria as
          | Array<{ id: string }>
          | undefined) ?? [];

        if (behavior === "submit_evidence") {
          const evResult = await hub.invoke("orchestration", `/tasks/${taskId}`, "submit_evidence_claim", {
            checks: [
              {
                id: "check-1",
                type: "test",
                command: "bun test",
                exit_code: 0,
                output: "pass",
                verification: "replayable",
              },
            ],
            criterion_satisfaction: criteria.map((criterion) => ({
              criterion_id: criterion.id,
              evidence_refs: ["check-1"],
              kind: "replayable",
            })),
            risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
          });
          if (evResult.status !== "ok") {
            throw new Error(`evidence failed: ${JSON.stringify(evResult.error)}`);
          }
          const completeResult = await hub.invoke("orchestration", `/tasks/${taskId}`, "complete", {
            result: "Slice complete.",
          });
          if (completeResult.status !== "ok") {
            throw new Error(`complete failed: ${JSON.stringify(completeResult.error)}`);
          }
          callbacks.onUpdate({
            status: "completed",
            completed_at: new Date().toISOString(),
          });
        } else {
          await hub.invoke("orchestration", `/tasks/${taskId}`, "escalate", {
            failure_class: "spec_unclear",
            description: "Slice cannot be completed as planned.",
          });
          callbacks.onUpdate({
            status: "failed",
            error: "escalated",
            completed_at: new Date().toISOString(),
          });
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
  const delegation = new DelegationProvider({ maxAgents: 2, runnerFactory });

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

  const scheduler = new OrchestrationScheduler({ hub, maxAgents: 2 });
  await scheduler.start();

  const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
  await consumer.connect();
  await consumer.subscribe("/", 3);

  return { consumer, hub, orchestration, scheduler, observedSpawns };
}

describe("autonomous executor (Phase 1)", () => {
  test("scheduler dispatches with role=executor; mock executor submits evidence and slice gate auto-accepts", async () => {
    const { consumer, hub, orchestration, scheduler, observedSpawns } = await harness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement feature",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "feature",
            goal: "Implement the feature.",
            acceptance_criteria: ["Feature behaves as specified"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      await waitFor(async () => {
        const tasks = await consumer.query("/tasks", 2);
        const taskId = tasks.children?.[0]?.id;
        if (!taskId) return false;
        const task = await consumer.query(`/tasks/${taskId}`, 1);
        return task.properties?.status === "completed";
      }, "executor to complete the slice");

      expect(observedSpawns.length).toBeGreaterThan(0);
      expect(observedSpawns[0].roleId).toBe("executor");

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id ?? "";
      const task = await consumer.query(`/tasks/${taskId}`, 1);
      expect(task.properties?.status).toBe("completed");
      expect(task.properties?.slice_gate_accepted).toBe(true);

      // Slice gate auto-resolved by policy after evidence covered the criterion.
      const gates = await consumer.query("/gates", 2);
      const sliceGate = gates.children?.find(
        (gate) =>
          gate.properties?.gate_type === "slice_gate" &&
          gate.properties?.subject_ref === `slice:${taskId}`,
      );
      expect(sliceGate?.properties?.status).toBe("accepted");
      expect(sliceGate?.properties?.resolved_by).toBe("policy");
    } finally {
      await scheduler.stop();
      orchestration.stop();
      hub.shutdown();
    }
  });

  test("scheduler propagates per-slice executor_binding to the spawn", async () => {
    const { consumer, hub, orchestration, scheduler, observedSpawns } = await harness();
    try {
      const binding = { kind: "llm" as const, profileId: "custom-profile" };
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement feature",
        slices: [
          {
            name: "feature",
            goal: "Implement the feature.",
            acceptance_criteria: ["Feature behaves as specified"],
            slice_gate_resolver: "policy",
            executor_binding: binding,
          },
        ],
      });
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      await waitFor(() => observedSpawns.length > 0, "scheduler to dispatch spawn");

      expect(observedSpawns[0].executor).toEqual(binding);
      expect(observedSpawns[0].roleId).toBe("executor");
    } finally {
      await scheduler.stop();
      orchestration.stop();
      hub.shutdown();
    }
  });
});

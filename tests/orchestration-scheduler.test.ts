import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import {
  DelegationProvider,
  type DelegationRunnerFactory,
} from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { OrchestrationProvider } from "../src/providers/builtin/orchestration";
import {
  OrchestrationScheduler,
  type OrchestrationSchedulerEvent,
} from "../src/runtime/orchestration";

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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "sloppy-scheduler-"));
  tempPaths.push(root);
  const hub = new ConsumerHub([], TEST_CONFIG);
  await hub.connect();

  const orchestration = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sched" });
  const spawnedTaskIds: string[] = [];
  const runnerFactory: DelegationRunnerFactory = (spawn, callbacks) => ({
    async start() {
      const taskId = spawn.externalTaskId;
      if (taskId) {
        spawnedTaskIds.push(taskId);
        await hub.invoke("orchestration", `/tasks/${taskId}`, "start", {});
      }
      callbacks.onUpdate({ status: "running" });
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

  const events: OrchestrationSchedulerEvent[] = [];
  const scheduler = new OrchestrationScheduler({
    hub,
    maxAgents: 2,
    onEvent: (event) => events.push(event),
  });
  await scheduler.start();

  const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
  await consumer.connect();
  await consumer.subscribe("/", 3);

  return { consumer, delegation, events, hub, orchestration, scheduler, spawnedTaskIds };
}

describe("OrchestrationScheduler", () => {
  test("fans out ready tasks up to plan capacity", async () => {
    const { consumer, hub, orchestration, scheduler, spawnedTaskIds } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "build independent tasks",
        strategy: "parallel",
        max_agents: 2,
      });
      const createdResult = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          { name: "alpha", client_ref: "alpha", goal: "Do independent task alpha." },
          { name: "beta", client_ref: "beta", goal: "Do independent task beta." },
          { name: "gamma", client_ref: "gamma", goal: "Do independent task gamma." },
        ],
      });
      expect(createdResult.status).toBe("ok");
      const created = (createdResult.data as { created: Array<{ id: string }> }).created;
      const createdIds = new Set(created.map((task) => task.id));

      await waitFor(() => spawnedTaskIds.length === 2, "two ready tasks to be spawned");
      expect(new Set(spawnedTaskIds).size).toBe(2);
      for (const taskId of spawnedTaskIds) {
        expect(createdIds.has(taskId)).toBe(true);
        const task = await consumer.query(`/tasks/${taskId}`, 1);
        expect(task.properties?.status).toBe("running");
      }
    } finally {
      consumer.disconnect();
      scheduler.stop();
      hub.shutdown();
      orchestration.stop();
    }
  });

  test("plan capacity can reduce scheduler fan-out below provider capacity", async () => {
    const { consumer, hub, orchestration, scheduler, spawnedTaskIds } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "build one at a time",
        strategy: "parallel",
        max_agents: 1,
      });
      const createdResult = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          { name: "alpha", client_ref: "alpha", goal: "Do independent task alpha." },
          { name: "beta", client_ref: "beta", goal: "Do independent task beta." },
        ],
      });
      expect(createdResult.status).toBe("ok");

      await waitFor(() => spawnedTaskIds.length === 1, "one ready task to be spawned");
      await Bun.sleep(80);
      expect(spawnedTaskIds.length).toBe(1);
    } finally {
      consumer.disconnect();
      scheduler.stop();
      hub.shutdown();
      orchestration.stop();
    }
  });

  test("claims ready tasks and starts dependent work after completion patches", async () => {
    const { consumer, events, hub, orchestration, scheduler, spawnedTaskIds } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "build dependent tasks",
        max_agents: 2,
      });
      const createdResult = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          {
            name: "first",
            client_ref: "first",
            goal: "Do the first task.",
          },
          {
            name: "second",
            client_ref: "second",
            goal: "Do the second task after the first.",
            depends_on: ["first"],
          },
        ],
      });
      expect(createdResult.status).toBe("ok");
      const created = (createdResult.data as { created: Array<{ id: string }> }).created;
      const firstId = created[0]?.id;
      const secondId = created[1]?.id;
      if (!firstId || !secondId) {
        throw new Error("Expected two created tasks.");
      }

      await waitFor(() => spawnedTaskIds.includes(firstId), "first task to be spawned");
      expect(spawnedTaskIds).toEqual([firstId]);
      const firstRunning = await consumer.query(`/tasks/${firstId}`, 1);
      expect(firstRunning.properties?.status).toBe("running");

      const verification = await consumer.invoke(`/tasks/${firstId}`, "record_verification", {
        status: "not_required",
        criteria: ["all"],
        summary: "No external verification needed in scheduler test.",
      });
      expect(verification.status).toBe("ok");
      const complete = await consumer.invoke(`/tasks/${firstId}`, "complete", {
        result: "first done",
      });
      expect(complete.status).toBe("ok");

      await waitFor(() => spawnedTaskIds.includes(secondId), "dependent task to be spawned");
      expect(spawnedTaskIds).toEqual([firstId, secondId]);
      const secondRunning = await consumer.query(`/tasks/${secondId}`, 1);
      expect(secondRunning.properties?.status).toBe("running");

      expect(events.map((event) => event.kind)).toContain("task_unblocked");
      expect(events.map((event) => event.kind)).toContain("task_scheduled");
      expect(events.map((event) => event.kind)).toContain("task_started");
    } finally {
      consumer.disconnect();
      scheduler.stop();
      hub.shutdown();
      orchestration.stop();
    }
  });
});

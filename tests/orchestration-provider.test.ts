import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { OrchestrationProvider } from "../src/providers/builtin/orchestration";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "sloppy-orch-"));
  tempPaths.push(root);
  const provider = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-test" });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await consumer.connect();
  await consumer.subscribe("/", 3);
  return { root, provider, consumer };
}

describe("OrchestrationProvider", () => {
  test("creates a plan and persists it under .sloppy/orchestration/", async () => {
    const { root, provider, consumer } = await harness();

    try {
      const result = await consumer.invoke("/orchestration", "create_plan", {
        query: "research competitors",
        strategy: "parallel",
        max_agents: 3,
      });
      expect(result.status).toBe("ok");

      const tree = await consumer.query("/orchestration", 2);
      expect(tree.properties).toMatchObject({
        plan_status: "active",
        plan_query: "research competitors",
        plan_strategy: "parallel",
        plan_max_agents: 3,
      });

      const planFile = join(root, ".sloppy", "orchestration", "plan.json");
      expect(existsSync(planFile)).toBe(true);
      const persisted = JSON.parse(readFileSync(planFile, "utf8"));
      expect(persisted.query).toBe("research competitors");
      expect(persisted.status).toBe("active");
    } finally {
      provider.stop();
    }
  });

  test("rejects a second active plan", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "first" });
      const second = await consumer.invoke("/orchestration", "create_plan", { query: "second" });
      expect(second.status).toBe("error");
      expect(second.error?.message).toContain("active plan already exists");
    } finally {
      provider.stop();
    }
  });

  test("walks a task through start, progress, complete", async () => {
    const { root, provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build feature" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "analyze",
        goal: "analyze the requirements",
      });
      const { id: taskId, version: v0 } = spawn.data as { id: string; version: number };

      const start = await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: v0,
      });
      expect(start.status).toBe("ok");
      const v1 = (start.data as { version: number }).version;
      expect(v1).toBeGreaterThan(v0);

      const progress = await consumer.invoke(`/tasks/${taskId}`, "append_progress", {
        message: "read the spec",
      });
      expect(progress.status).toBe("ok");

      const complete = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "requirements analyzed: feature needs X and Y",
      });
      expect(complete.status).toBe("ok");

      const tasks = await consumer.query("/tasks", 2);
      expect(tasks.children?.[0]?.properties).toMatchObject({
        id: taskId,
        status: "completed",
      });

      const getResult = await consumer.invoke(`/tasks/${taskId}`, "get_result", {});
      expect((getResult.data as { result: string }).result).toBe(
        "requirements analyzed: feature needs X and Y",
      );

      const resultFile = join(root, ".sloppy", "orchestration", "tasks", taskId, "result.md");
      expect(readFileSync(resultFile, "utf8")).toBe("requirements analyzed: feature needs X and Y");
      const progressFile = join(root, ".sloppy", "orchestration", "tasks", taskId, "progress.md");
      expect(readFileSync(progressFile, "utf8")).toContain("read the spec");
    } finally {
      provider.stop();
    }
  });

  test("creates and responds to a handoff between two tasks", async () => {
    const { root, provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const a = await consumer.invoke("/orchestration", "create_task", {
        name: "producer",
        goal: "produce data",
      });
      const b = await consumer.invoke("/orchestration", "create_task", {
        name: "consumer",
        goal: "consume data",
      });
      const fromId = (a.data as { id: string }).id;
      const toId = (b.data as { id: string }).id;

      const created = await consumer.invoke("/orchestration", "create_handoff", {
        from_task: fromId,
        to_task: toId,
        request: "need the parsed output",
      });
      expect(created.status).toBe("ok");
      const handoff = created.data as {
        id: string;
        status: string;
        version: number;
        from_task: string;
        to_task: string;
      };
      expect(handoff.status).toBe("pending");
      expect(handoff.from_task).toBe(fromId);
      expect(handoff.to_task).toBe(toId);

      const tree = await consumer.query("/handoffs", 2);
      expect(tree.properties).toMatchObject({ count: 1, pending: 1 });
      expect(tree.children?.[0]?.affordances?.map((a) => a.action)).toEqual(["respond", "cancel"]);

      const responded = await consumer.invoke(`/handoffs/${handoff.id}`, "respond", {
        response: "here is the data: [...]",
        expected_version: handoff.version,
      });
      expect(responded.status).toBe("ok");
      expect((responded.data as { status: string }).status).toBe("responded");

      const afterFile = JSON.parse(
        readFileSync(
          join(root, ".sloppy", "orchestration", "handoffs", `${handoff.id}.json`),
          "utf8",
        ),
      );
      expect(afterFile.status).toBe("responded");
      expect(afterFile.response).toBe("here is the data: [...]");

      // Respond affordance disappears once handoff is no longer pending
      const after = await consumer.query(`/handoffs/${handoff.id}`, 1);
      expect(after.affordances ?? []).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("rejects handoff creation for unknown tasks", async () => {
    const { provider, consumer } = await harness();

    try {
      const result = await consumer.invoke("/orchestration", "create_handoff", {
        from_task: "task-doesnotexist",
        to_task: "task-alsomissing",
        request: "x",
      });
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Unknown from_task");
    } finally {
      provider.stop();
    }
  });

  test("start affordance is hidden until dependencies complete", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "q" });
      const a = await consumer.invoke("/orchestration", "create_task", { name: "a", goal: "a" });
      const aId = (a.data as { id: string; version: number }).id;
      const aV0 = (a.data as { id: string; version: number }).version;

      const b = await consumer.invoke("/orchestration", "create_task", {
        name: "b",
        goal: "b",
        depends_on: [aId],
      });
      const bId = (b.data as { id: string }).id;

      // b cannot start yet — dep a is still pending
      const blocked = await consumer.query(`/tasks/${bId}`, 1);
      expect(blocked.affordances?.map((x) => x.action)).not.toContain("start");
      expect(blocked.properties?.unmet_dependencies).toEqual([aId]);

      // Affordance is hidden so the router returns no handler.
      const direct = await consumer.invoke(`/tasks/${bId}`, "start", {});
      expect(direct.status).toBe("error");
      expect(direct.error?.message).toContain("No handler");

      // Complete a; b becomes startable
      await consumer.invoke(`/tasks/${aId}`, "start", { expected_version: aV0 });
      const aMid = await consumer.query(`/tasks/${aId}`, 1);
      const aV1 = aMid.properties?.version as number;
      await consumer.invoke(`/tasks/${aId}`, "complete", {
        result: "done",
        expected_version: aV1,
      });

      const unblocked = await consumer.query(`/tasks/${bId}`, 1);
      expect(unblocked.affordances?.map((x) => x.action)).toContain("start");
      expect(unblocked.properties?.unmet_dependencies).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("terminal task status removes mutating affordances", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "x" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "t",
        goal: "g",
      });
      const { id: taskId, version: v0 } = spawn.data as { id: string; version: number };
      const start = await consumer.invoke(`/tasks/${taskId}`, "start", { expected_version: v0 });
      const v1 = (start.data as { version: number }).version;
      await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: v1,
      });

      const task = await consumer.query(`/tasks/${taskId}`, 1);
      expect(task.properties?.status).toBe("completed");
      expect(task.affordances?.map((a) => a.action).sort()).toEqual(["get_result"]);

      const cancelAttempt = await consumer.invoke(`/tasks/${taskId}`, "cancel", {});
      expect(cancelAttempt.status).toBe("error");
      expect(cancelAttempt.error?.message).toContain("No handler");
    } finally {
      provider.stop();
    }
  });

  test("rehydrates task versions from disk after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-orch-rehydrate-"));
    tempPaths.push(root);

    const provider1 = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-r" });
    const consumer1 = new SlopConsumer(new InProcessTransport(provider1.server));
    await consumer1.connect();
    await consumer1.subscribe("/", 3);

    await consumer1.invoke("/orchestration", "create_plan", { query: "x" });
    const spawn = await consumer1.invoke("/orchestration", "create_task", { name: "t", goal: "g" });
    const { id: taskId, version: v0 } = spawn.data as { id: string; version: number };
    const start = await consumer1.invoke(`/tasks/${taskId}`, "start", { expected_version: v0 });
    const v1 = (start.data as { version: number }).version;
    consumer1.disconnect();
    provider1.stop();

    // Simulate restart: new provider reading the same directory.
    const provider2 = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-r" });
    const consumer2 = new SlopConsumer(new InProcessTransport(provider2.server));
    await consumer2.connect();
    await consumer2.subscribe("/", 3);

    try {
      // v0 should no longer be accepted — durability preserves CAS.
      const stale = await consumer2.invoke(`/tasks/${taskId}`, "complete", {
        result: "should fail",
        expected_version: v0,
      });
      const staleData = stale.data as { error?: string; currentVersion?: number };
      expect(staleData.error).toBe("version_conflict");
      expect(staleData.currentVersion).toBe(v1);

      // Fresh version still works.
      const fresh = await consumer2.invoke(`/tasks/${taskId}`, "complete", {
        result: "ok",
        expected_version: v1,
      });
      expect(fresh.status).toBe("ok");
    } finally {
      consumer2.disconnect();
      provider2.stop();
    }
  });

  test("rejects task updates with stale expected_version (CAS)", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "q" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "t",
        goal: "g",
      });
      const { id: taskId, version: v0 } = spawn.data as { id: string; version: number };

      const first = await consumer.invoke(`/tasks/${taskId}`, "start", { expected_version: v0 });
      expect(first.status).toBe("ok");
      const v1 = (first.data as { version: number }).version;

      const stale = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "STALE_RESULT",
        expected_version: v0,
      });
      expect(stale.status).toBe("ok");
      const staleData = stale.data as { error?: string; currentVersion?: number };
      expect(staleData.error).toBe("version_conflict");
      expect(staleData.currentVersion).toBe(v1);

      // result.md must NOT be written on a conflicted complete.
      const staleResult = await consumer.invoke(`/tasks/${taskId}`, "get_result", {});
      expect((staleResult.data as { result: string | null }).result).toBeNull();

      const fresh = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: v1,
      });
      expect(fresh.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });
});

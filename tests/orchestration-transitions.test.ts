import { afterEach, describe, expect, test } from "bun:test";
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
  const root = await mkdtemp(join(tmpdir(), "sloppy-orch-trans-"));
  tempPaths.push(root);
  const provider = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-test" });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await consumer.connect();
  await consumer.subscribe("/", 3);
  return { provider, consumer };
}

async function createTask(consumer: SlopConsumer, name: string): Promise<string> {
  const result = await consumer.invoke("/orchestration", "create_task", {
    name,
    goal: `goal for ${name}`,
  });
  expect(result.status).toBe("ok");
  return (result.data as { id: string }).id;
}

async function readTask(consumer: SlopConsumer, taskId: string) {
  return consumer.query(`/tasks/${taskId}`, 1);
}

describe("orchestration task state machine — invalid transitions", () => {
  test("rejects complete from pending (must verify first)", async () => {
    const { provider, consumer } = await harness();
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const taskId = await createTask(consumer, "impl");
      const task = await readTask(consumer, taskId);
      expect(task.properties?.status).toBe("pending");

      // Affordance filtering hides `complete` while pending. The descriptor
      // surface is the user-facing guardrail.
      const completeAffordance = (task.affordances ?? []).find(
        (affordance) => affordance.action === "complete",
      );
      expect(completeAffordance).toBeUndefined();
    } finally {
      provider.stop();
    }
  });

  test("rejects complete from verifying when no acceptance criteria are covered", async () => {
    const { provider, consumer } = await harness();
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const created = await consumer.invoke("/orchestration", "create_task", {
        name: "impl",
        goal: "implement the feature",
        acceptance_criteria: ["Feature ships behind a flag"],
      });
      expect(created.status).toBe("ok");
      const taskId = (created.data as { id: string }).id;

      const before = await readTask(consumer, taskId);
      const started = await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: before.properties?.version,
      });
      expect(started.status).toBe("ok");

      const afterStart = await readTask(consumer, taskId);
      const attached = await consumer.invoke(`/tasks/${taskId}`, "attach_result", {
        result: "done",
        expected_version: afterStart.properties?.version,
      });
      expect(attached.status).toBe("ok");

      const afterAttach = await readTask(consumer, taskId);
      expect(afterAttach.properties?.status).toBe("verifying");

      const completed = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: afterAttach.properties?.version,
      });
      expect(completed.status).toBe("error");
      expect(completed.error?.code).toBe("verification_required");
    } finally {
      provider.stop();
    }
  });

  test("rejects start when current status is not pending or scheduled", async () => {
    const { provider, consumer } = await harness();
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const taskId = await createTask(consumer, "impl");

      const before = await readTask(consumer, taskId);
      const started = await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: before.properties?.version,
      });
      expect(started.status).toBe("ok");

      // Now running. A second `start` should be filtered out at the descriptor
      // level (no `start` affordance on running tasks).
      const afterStart = await readTask(consumer, taskId);
      expect(afterStart.properties?.status).toBe("running");
      const startAffordance = (afterStart.affordances ?? []).find(
        (affordance) => affordance.action === "start",
      );
      expect(startAffordance).toBeUndefined();
    } finally {
      provider.stop();
    }
  });

  test("CAS: stale schedule attempt does not double-claim the task", async () => {
    const { provider, consumer } = await harness();
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const taskId = await createTask(consumer, "impl");

      const before = await readTask(consumer, taskId);
      const staleVersion = before.properties?.version as number;

      const firstClaim = await consumer.invoke(`/tasks/${taskId}`, "schedule", {
        expected_version: staleVersion,
      });
      expect(firstClaim.status).toBe("ok");
      expect(firstClaim.data).toMatchObject({ status: "scheduled" });

      // Replaying the same `expected_version` must not re-fire the transition.
      // Once scheduled, the `schedule` affordance is removed; the consumer
      // surfaces this as a missing-handler error rather than a CAS conflict,
      // because the descriptor no longer offers the action.
      const replay = await consumer.invoke(`/tasks/${taskId}`, "schedule", {
        expected_version: staleVersion,
      });
      expect(replay.status).toBe("error");

      const finalState = await readTask(consumer, taskId);
      expect(finalState.properties?.status).toBe("scheduled");
      // Version was bumped exactly once.
      expect(finalState.properties?.version).toBe(staleVersion + 1);
    } finally {
      provider.stop();
    }
  });

  test("retry_of marks the source task as superseded", async () => {
    const { provider, consumer } = await harness();
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const sourceId = await createTask(consumer, "impl");

      // Drive the source task to failed so it is eligible for retry.
      const sourceBefore = await readTask(consumer, sourceId);
      const started = await consumer.invoke(`/tasks/${sourceId}`, "start", {
        expected_version: sourceBefore.properties?.version,
      });
      expect(started.status).toBe("ok");

      const afterStart = await readTask(consumer, sourceId);
      const failed = await consumer.invoke(`/tasks/${sourceId}`, "fail", {
        error: "boom",
        expected_version: afterStart.properties?.version,
      });
      expect(failed.status).toBe("ok");

      const retry = await consumer.invoke("/orchestration", "create_task", {
        name: "impl-retry",
        goal: "retry impl",
        retry_of: sourceId,
      });
      expect(retry.status).toBe("ok");
      const retryId = (retry.data as { id: string }).id;

      const sourceAfter = await readTask(consumer, sourceId);
      expect(sourceAfter.properties?.status).toBe("superseded");
      expect(sourceAfter.properties?.superseded_by).toBe(retryId);
    } finally {
      provider.stop();
    }
  });
});

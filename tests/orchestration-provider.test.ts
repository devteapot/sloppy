import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

async function recordNotRequiredVerification(
  consumer: SlopConsumer,
  taskId: string,
): Promise<number> {
  const result = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
    status: "not_required",
    summary: "No external verification required for this test task.",
  });
  expect(result.status).toBe("ok");
  const task = await consumer.query(`/tasks/${taskId}`, 1);
  expect(task.properties?.status).toBe("verifying");
  return task.properties?.version as number;
}

async function startVerifyAndComplete(
  consumer: SlopConsumer,
  taskId: string,
  result = "done",
): Promise<void> {
  const before = await consumer.query(`/tasks/${taskId}`, 1);
  const started = await consumer.invoke(`/tasks/${taskId}`, "start", {
    expected_version: before.properties?.version,
  });
  expect(started.status).toBe("ok");

  const version = await recordNotRequiredVerification(consumer, taskId);
  const completed = await consumer.invoke(`/tasks/${taskId}`, "complete", {
    result,
    expected_version: version,
  });
  expect(completed.status).toBe("ok");
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

  test("normalizes dependency refs from task names and aliases to task ids", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const first = await consumer.invoke("/orchestration", "create_task", {
        name: "setup",
        goal: "set up the project",
      });
      expect(first.status).toBe("ok");
      const firstId = (first.data as { id: string }).id;

      const second = await consumer.invoke("/orchestration", "create_task", {
        name: "implement",
        goal: "implement after setup",
        depends_on: ["setup"],
      });
      expect(second.status).toBe("ok");
      const secondId = (second.data as { id: string }).id;
      const secondTask = await consumer.query(`/tasks/${secondId}`, 1);
      expect(secondTask.properties?.depends_on).toEqual([firstId]);

      const third = await consumer.invoke("/orchestration", "create_task", {
        name: "docs",
        goal: "document after implementation",
        depends_on: ["task-2"],
      });
      expect(third.status).toBe("ok");
      const thirdId = (third.data as { id: string }).id;
      const thirdTask = await consumer.query(`/tasks/${thirdId}`, 1);
      expect(thirdTask.properties?.depends_on).toEqual([secondId]);
    } finally {
      provider.stop();
    }
  });

  test("batch-creates tasks with local refs and forward dependencies", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const result = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          {
            name: "scaffold",
            client_ref: "scaffold",
            goal: "Create project files.",
            acceptance_criteria: ["Project files exist"],
          },
          {
            name: "data",
            client_ref: "data",
            goal: "Create data model.",
            depends_on: ["scaffold"],
            acceptance_criteria: ["Data model exports seed tasks"],
          },
          {
            name: "ui",
            client_ref: "ui",
            goal: "Create UI from data model.",
            depends_on: ["data"],
            acceptance_criteria: ["UI imports the data model"],
          },
        ],
      });
      expect(result.status).toBe("ok");
      const created = (result.data as { created: Array<{ id: string; depends_on: string[] }> })
        .created;
      expect(created).toHaveLength(3);
      expect(created[1]?.depends_on).toEqual([created[0]?.id]);
      // Provider-level create_tasks resolves only the explicit batch refs;
      // it no longer infers extra edges (e.g. scaffold -> ui).
      expect(created[2]?.depends_on).toEqual([created[1]?.id]);
    } finally {
      provider.stop();
    }
  });

  test("rejects cyclic batch dependencies before writing tasks", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const result = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          {
            name: "scaffold",
            client_ref: "scaffold",
            goal: "Create the Vite React project scaffold.",
            depends_on: ["data-model"],
          },
          {
            name: "data-model",
            client_ref: "data-model",
            goal: "Create the task board data model.",
            depends_on: ["scaffold"],
          },
        ],
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("invalid_dependencies");
      expect(result.error?.message).toContain("Dependency cycle detected");

      const tasks = await consumer.query("/tasks", 1);
      expect(tasks.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
    }
  });

  test("batch-create accepts parseable JSON strings from models", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const result = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: `Here is the task graph:\n${JSON.stringify([
          {
            name: "scaffold",
            client_ref: "scaffold",
            goal: "Create project files.",
          },
          {
            name: "ui",
            client_ref: "ui",
            goal: "Create UI.",
            depends_on: ["scaffold"],
          },
        ])}\nThanks.`,
      });

      expect(result.status).toBe("ok");
      const created = (result.data as { created: Array<{ id: string; depends_on: string[] }> })
        .created;
      expect(created).toHaveLength(2);
      expect(created[1]?.depends_on).toEqual([created[0]?.id]);
    } finally {
      provider.stop();
    }
  });

  test("schedule claims a ready task before delegated execution starts", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build" });
      const result = await consumer.invoke("/orchestration", "create_task", {
        name: "implement",
        goal: "Implement the feature.",
      });
      expect(result.status).toBe("ok");
      const taskId = (result.data as { id: string }).id;

      const taskBefore = await consumer.query(`/tasks/${taskId}`, 1);
      expect(taskBefore.properties?.status).toBe("pending");
      expect(
        (taskBefore.affordances ?? []).some((affordance) => affordance.action === "schedule"),
      ).toBe(true);

      const scheduled = await consumer.invoke(`/tasks/${taskId}`, "schedule", {
        expected_version: taskBefore.properties?.version,
      });
      expect(scheduled.status).toBe("ok");
      expect(scheduled.data).toMatchObject({ status: "scheduled" });

      const taskAfter = await consumer.query(`/tasks/${taskId}`, 1);
      expect(taskAfter.properties?.status).toBe("scheduled");
      expect(taskAfter.properties?.scheduled_at).toBeString();
      expect(
        (taskAfter.affordances ?? []).some((affordance) => affordance.action === "start"),
      ).toBe(true);

      const stale = await consumer.invoke(`/tasks/${taskId}`, "schedule", {
        expected_version: taskBefore.properties?.version,
      });
      expect(stale.status).toBe("error");
      expect(stale.error?.message).toContain("No handler for schedule");

      const started = await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: taskAfter.properties?.version,
      });
      expect(started.status).toBe("ok");
      expect(started.data).toMatchObject({ status: "running" });
    } finally {
      provider.stop();
    }
  });

  test("provider does not infer coding-domain dependencies when depends_on is omitted", async () => {
    // Coding-domain dependency inference (scaffold -> ui, docs after producers,
    // verification last) lives in the orchestrator role's planning-policy, not
    // the generic provider. Calling create_tasks directly without explicit
    // depends_on must therefore yield zero inferred edges.
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query:
          "Create a Vite React + Tailwind sprint board with data model, UI, build verification, and README.",
        strategy: "sequential",
      });
      const result = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          {
            name: "Create README with setup and run instructions",
            client_ref: "docs",
            goal: "Create README.md with setup instructions and accurate implemented features.",
          },
          {
            name: "Build UI components: board, columns, task cards, form, stats bar",
            client_ref: "ui",
            goal: "Implement React UI components for the task board.",
          },
          {
            name: "Scaffold Vite React + Tailwind project",
            client_ref: "scaffold",
            goal: "Create a Vite React TypeScript project structure with Tailwind CSS configured.",
          },
          {
            name: "Verify build passes",
            client_ref: "verification",
            goal: "Run npm install followed by npm run build in the sprint-board project directory.",
          },
          {
            name: "Task board data model and seed data",
            client_ref: "data-model",
            goal: "Create the task board data model, seed data, and store/context.",
          },
        ],
      });
      expect(result.status).toBe("ok");
      const created = (
        result.data as {
          created: Array<{ client_ref?: string; depends_on: string[] }>;
        }
      ).created;
      for (const task of created) {
        expect(task.depends_on).toEqual([]);
      }
    } finally {
      provider.stop();
    }
  });

  test("does not infer coding dependencies for unrelated non-code task batches", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Research competitors and draft notes.",
        strategy: "parallel",
      });
      const result = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          {
            name: "research competitors",
            client_ref: "research",
            goal: "Collect competitor notes.",
          },
          {
            name: "draft docs summary",
            client_ref: "summary",
            goal: "Write a docs-style summary of the findings.",
          },
        ],
      });
      expect(result.status).toBe("ok");
      const created = (
        result.data as {
          created: Array<{ client_ref?: string; depends_on: string[] }>;
        }
      ).created;
      expect(created.find((task) => task.client_ref === "summary")?.depends_on).toEqual([]);
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

      const blockedComplete = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "should not complete without verification",
      });
      expect(blockedComplete.status).toBe("error");
      expect(blockedComplete.error?.code).toBe("not_found");

      const verifying = await consumer.invoke(`/tasks/${taskId}`, "start_verification", {});
      expect(verifying.status).toBe("ok");
      const unverifiedComplete = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "should not complete without verification evidence",
      });
      expect(unverifiedComplete.status).toBe("error");
      expect(unverifiedComplete.error?.code).toBe("verification_required");

      await recordNotRequiredVerification(consumer, taskId);
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

  test("records generic verification evidence on running tasks", async () => {
    const { root, provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "verify work" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "build",
        goal: "build the app",
      });
      const { id: taskId } = spawn.data as { id: string };
      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      mkdirSync(join(root, "sprint-board"), { recursive: true });
      writeFileSync(join(root, "sprint-board", "package.json"), "{}", "utf8");

      const verification = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        kind: "build",
        status: "passed",
        summary: "vite build succeeded",
        command: "npm run build",
        evidence: "✓ built in 160ms",
        evidence_refs: ["sprint-board/package.json", "terminal:npm run build"],
      });
      expect(verification.status).toBe("ok");

      const task = await consumer.query(`/tasks/${taskId}`, 2);
      expect(task.properties?.status).toBe("verifying");
      expect(task.properties?.verified).toBe(true);
      expect(task.properties?.latest_verification).toMatchObject({
        kind: "build",
        status: "passed",
        summary: "vite build succeeded",
        command: "npm run build",
        evidence_refs: ["sprint-board/package.json", "terminal:npm run build"],
      });

      const all = await consumer.invoke(`/tasks/${taskId}`, "get_verifications", {});
      expect((all.data as { verifications: unknown[] }).verifications).toHaveLength(1);

      const persisted = JSON.parse(
        readFileSync(
          join(root, ".sloppy", "orchestration", "tasks", taskId, "verifications.json"),
          "utf8",
        ),
      );
      expect(persisted[0]).toMatchObject({
        kind: "build",
        status: "passed",
        command: "npm run build",
        evidence_refs: ["sprint-board/package.json", "terminal:npm run build"],
      });
    } finally {
      provider.stop();
    }
  });

  test("rejects passed acceptance verification with missing file evidence refs", async () => {
    const { root, provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "verify evidence refs" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "docs",
        goal: "document files",
        acceptance_criteria: ["README matches implementation"],
      });
      const { id: taskId } = spawn.data as { id: string };
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const missingEvidence = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        kind: "review",
        status: "passed",
        summary: "checked README",
        criteria: ["ac-1"],
      });
      expect(missingEvidence.status).toBe("error");
      expect(missingEvidence.error?.code).toBe("evidence_required");

      const invalidEvidence = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        kind: "review",
        status: "passed",
        summary: "checked README",
        criteria: ["ac-1"],
        evidence_refs: ["sprint-board/README.md"],
      });
      expect(invalidEvidence.status).toBe("error");
      expect(invalidEvidence.error?.code).toBe("invalid_evidence_refs");

      mkdirSync(join(root, "sprint-board"), { recursive: true });
      writeFileSync(join(root, "sprint-board", "README.md"), "# ok\n", "utf8");
      const validEvidence = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        kind: "review",
        status: "passed",
        summary: "checked README",
        criteria: ["ac-1"],
        evidence_refs: ["sprint-board/README.md"],
      });
      expect(validEvidence.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("completion requires verification coverage for acceptance criteria", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "verify criteria" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "ui",
        goal: "build ui",
        acceptance_criteria: ["imports shared data model", "renders four board columns"],
      });
      const { id: taskId } = spawn.data as { id: string };
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const task = await consumer.query(`/tasks/${taskId}`, 1);
      expect(task.properties?.acceptance_criteria).toEqual([
        { id: "ac-1", text: "imports shared data model" },
        { id: "ac-2", text: "renders four board columns" },
      ]);

      await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        kind: "review",
        status: "passed",
        summary: "confirmed shared data model import",
        criteria: ["ac-1"],
        evidence_refs: ["review:shared-data-model"],
      });

      const blocked = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "not enough evidence",
      });
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("verification_required");
      expect(blocked.error?.message).toContain("ac-2");

      const finalVerification = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        kind: "review",
        status: "passed",
        summary: "confirmed four columns",
        criteria: ["ac-2"],
        evidence_refs: ["review:four-columns"],
      });
      expect(finalVerification.status).toBe("ok");
      expect((finalVerification.data as { missing_criteria: string[] }).missing_criteria).toEqual(
        [],
      );

      const complete = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "criteria satisfied",
      });
      expect(complete.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("attach_result pushes child output and moves a running task to verifying", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "push result" });
      const spawn = await consumer.invoke("/orchestration", "create_task", {
        name: "child-task",
        goal: "produce a result",
      });
      const { id: taskId } = spawn.data as { id: string };
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const attached = await consumer.invoke(`/tasks/${taskId}`, "attach_result", {
        result: "child finished with useful details",
      });
      expect(attached.status).toBe("ok");

      const task = await consumer.query(`/tasks/${taskId}`, 1);
      expect(task.properties).toMatchObject({
        status: "verifying",
        result_preview: "child finished with useful details",
      });
      expect(task.affordances?.map((affordance) => affordance.action)).not.toContain("get_result");
    } finally {
      provider.stop();
    }
  });

  test("retry_of supersedes a failed task and preserves dependency satisfaction through replacement", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "retry failed work" });
      const original = await consumer.invoke("/orchestration", "create_task", {
        name: "ui",
        goal: "first attempt",
      });
      const { id: originalId } = original.data as { id: string };
      await consumer.invoke(`/tasks/${originalId}`, "start", {});
      await consumer.invoke(`/tasks/${originalId}`, "fail", { error: "max iterations" });

      const retry = await consumer.invoke("/orchestration", "create_task", {
        name: "ui-retry",
        goal: "second attempt",
        retry_of: originalId,
      });
      expect(retry.status).toBe("ok");
      const { id: retryId } = retry.data as { id: string };

      const originalAfter = await consumer.query(`/tasks/${originalId}`, 1);
      expect(originalAfter.properties).toMatchObject({
        status: "superseded",
        superseded_by: retryId,
      });

      await consumer.invoke(`/tasks/${retryId}`, "start", {});
      await recordNotRequiredVerification(consumer, retryId);
      await consumer.invoke(`/tasks/${retryId}`, "complete", { result: "retry passed" });

      const downstream = await consumer.invoke("/orchestration", "create_task", {
        name: "downstream",
        goal: "depends on original logical work",
        depends_on: [originalId],
      });
      expect(downstream.status).toBe("ok");
      const downstreamId = (downstream.data as { id: string }).id;
      const downstreamTask = await consumer.query(`/tasks/${downstreamId}`, 1);
      expect(downstreamTask.properties?.unmet_dependencies).toEqual([]);
      expect(downstreamTask.affordances?.map((affordance) => affordance.action)).toContain("start");
    } finally {
      provider.stop();
    }
  });

  test("complete_plan rejects unfinished non-superseded tasks", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "guard completion" });
      await consumer.invoke("/orchestration", "create_task", {
        name: "still-pending",
        goal: "not done",
      });

      const complete = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(complete.status).toBe("error");
      expect(complete.error?.code).toBe("plan_incomplete");
    } finally {
      provider.stop();
    }
  });

  test("cancelled plans cancel unfinished tasks and new plans do not inherit them", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "first" });
      const first = await consumer.invoke("/orchestration", "create_task", {
        name: "blocked",
        goal: "This task should be cancelled with the plan.",
      });
      expect(first.status).toBe("ok");
      const firstId = (first.data as { id: string }).id;

      const cancelled = await consumer.invoke("/orchestration", "complete_plan", {
        status: "cancelled",
      });
      expect(cancelled.status).toBe("ok");

      const oldTask = await consumer.query(`/tasks/${firstId}`, 1);
      expect(oldTask.properties?.status).toBe("cancelled");

      const secondPlan = await consumer.invoke("/orchestration", "create_plan", {
        query: "second",
      });
      expect(secondPlan.status).toBe("ok");

      const tasks = await consumer.query("/tasks", 1);
      expect(tasks.children ?? []).toHaveLength(0);
      const root = await consumer.query("/orchestration", 1);
      expect(root.properties?.task_counts).toMatchObject({ total: 0 });
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

  test("persists typed handoff metadata and structured response refs", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "typed handoff" });
      const a = await consumer.invoke("/orchestration", "create_task", {
        name: "reviewer",
        goal: "review spec",
      });
      const b = await consumer.invoke("/orchestration", "create_task", {
        name: "implementer",
        goal: "implement spec",
      });
      const fromId = (a.data as { id: string }).id;
      const toId = (b.data as { id: string }).id;

      const created = await consumer.invoke("/orchestration", "create_handoff", {
        from_task: fromId,
        to_task: toId,
        kind: "decision_request",
        priority: "high",
        request: "Which column order is authoritative?",
        spec_refs: ["req-columns"],
        evidence_refs: [`/tasks/${fromId}`],
        blocks_task: true,
      });
      expect(created.status).toBe("ok");
      const handoff = created.data as { id: string; version: number };

      const tree = await consumer.query(`/handoffs/${handoff.id}`, 1);
      expect(tree.properties).toMatchObject({
        kind: "decision_request",
        priority: "high",
        spec_refs: ["req-columns"],
        evidence_refs: [`/tasks/${fromId}`],
        blocks_task: true,
      });

      const responded = await consumer.invoke(`/handoffs/${handoff.id}`, "respond", {
        response: "Use Backlog, In Progress, Review, Done.",
        decision_refs: ["decision-columns"],
        evidence_refs: [`/tasks/${toId}`],
        unblock: true,
        expected_version: handoff.version,
      });
      expect(responded.status).toBe("ok");

      const after = await consumer.query(`/handoffs/${handoff.id}`, 1);
      expect(after.properties).toMatchObject({
        status: "responded",
        decision_refs: ["decision-columns"],
        response_evidence_refs: [`/tasks/${toId}`],
        unblock: true,
      });
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
      await recordNotRequiredVerification(consumer, aId);
      await consumer.invoke(`/tasks/${aId}`, "complete", {
        result: "done",
        expected_version: (await consumer.query(`/tasks/${aId}`, 1)).properties?.version as number,
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
      expect((start.data as { version: number }).version).toBeGreaterThan(v0);
      const v2 = await recordNotRequiredVerification(consumer, taskId);
      await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: v2,
      });

      const task = await consumer.query(`/tasks/${taskId}`, 1);
      expect(task.properties?.status).toBe("completed");
      expect(task.affordances?.map((a) => a.action).sort()).toEqual([
        "get_result",
        "get_verifications",
        "record_verification",
      ]);

      const cancelAttempt = await consumer.invoke(`/tasks/${taskId}`, "cancel", {});
      expect(cancelAttempt.status).toBe("error");
      expect(cancelAttempt.error?.message).toContain("No handler");
    } finally {
      provider.stop();
    }
  });

  test("append_progress does not bump version (CAS survives restart)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-orch-prog-"));
    tempPaths.push(root);

    const p1 = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-p" });
    const c1 = new SlopConsumer(new InProcessTransport(p1.server));
    await c1.connect();
    await c1.subscribe("/", 3);
    await c1.invoke("/orchestration", "create_plan", { query: "x" });
    const spawn = await c1.invoke("/orchestration", "create_task", { name: "t", goal: "g" });
    const { id: taskId, version: v0 } = spawn.data as { id: string; version: number };
    const start = await c1.invoke(`/tasks/${taskId}`, "start", { expected_version: v0 });
    const v1 = (start.data as { version: number }).version;

    await c1.invoke(`/tasks/${taskId}`, "append_progress", { message: "step 1" });
    await c1.invoke(`/tasks/${taskId}`, "append_progress", { message: "step 2" });

    c1.disconnect();
    p1.stop();

    // Restart provider; version should still be v1 (append didn't bump it).
    const p2 = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-p" });
    const c2 = new SlopConsumer(new InProcessTransport(p2.server));
    await c2.connect();
    await c2.subscribe("/", 3);

    try {
      const task = await c2.query(`/tasks/${taskId}`, 1);
      expect(task.properties?.version).toBe(v1);

      const v2 = await recordNotRequiredVerification(c2, taskId);

      // complete with the current verifying version succeeds; v0 still rejected
      const stale = await c2.invoke(`/tasks/${taskId}`, "complete", {
        result: "stale",
        expected_version: v0,
      });
      expect((stale.data as { error?: string }).error).toBe("version_conflict");

      const fresh = await c2.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: v2,
      });
      expect(fresh.status).toBe("ok");
    } finally {
      c2.disconnect();
      p2.stop();
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
    expect(v1).toBeGreaterThan(v0);
    consumer1.disconnect();
    provider1.stop();

    // Simulate restart: new provider reading the same directory.
    const provider2 = new OrchestrationProvider({ workspaceRoot: root, sessionId: "sess-r" });
    const consumer2 = new SlopConsumer(new InProcessTransport(provider2.server));
    await consumer2.connect();
    await consumer2.subscribe("/", 3);

    try {
      const v2 = await recordNotRequiredVerification(consumer2, taskId);

      // v0 should no longer be accepted — durability preserves CAS.
      const stale = await consumer2.invoke(`/tasks/${taskId}`, "complete", {
        result: "should fail",
        expected_version: v0,
      });
      const staleData = stale.data as { error?: string; currentVersion?: number };
      expect(staleData.error).toBe("version_conflict");
      expect(staleData.currentVersion).toBe(v2);

      // Fresh version still works.
      const fresh = await consumer2.invoke(`/tasks/${taskId}`, "complete", {
        result: "ok",
        expected_version: v2,
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
      expect(v1).toBeGreaterThan(v0);
      const v2 = await recordNotRequiredVerification(consumer, taskId);

      const stale = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "STALE_RESULT",
        expected_version: v0,
      });
      expect(stale.status).toBe("ok");
      const staleData = stale.data as { error?: string; currentVersion?: number };
      expect(staleData.error).toBe("version_conflict");
      expect(staleData.currentVersion).toBe(v2);

      // result.md must NOT be written on a conflicted complete.
      const afterStale = await consumer.query(`/tasks/${taskId}`, 1);
      expect(afterStale.properties?.result_preview).toBeUndefined();

      const fresh = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: v2,
      });
      expect(fresh.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("links tasks to spec refs and blocks plan completion on open blocking findings", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "build from spec" });
      const created = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          {
            name: "implement",
            client_ref: "impl",
            kind: "implementation",
            goal: "Implement requirement req-1.",
            spec_refs: ["req-1"],
          },
          {
            name: "audit",
            client_ref: "audit",
            kind: "audit",
            goal: "Audit implementation against req-1.",
            depends_on: ["impl"],
            audit_of: "impl",
            spec_refs: ["req-1"],
          },
        ],
      });
      expect(created.status).toBe("ok");
      const tasks = (created.data as { created: Array<{ id: string }> }).created;
      const implId = tasks[0]?.id;
      const auditId = tasks[1]?.id;
      expect(typeof implId).toBe("string");
      expect(typeof auditId).toBe("string");

      const auditTask = await consumer.query(`/tasks/${auditId}`, 1);
      expect(auditTask.properties?.kind).toBe("audit");
      expect(auditTask.properties?.audit_of).toBe(implId);
      expect(auditTask.properties?.spec_refs).toEqual(["req-1"]);

      await startVerifyAndComplete(consumer, implId);
      await startVerifyAndComplete(consumer, auditId);

      const finding = await consumer.invoke("/findings", "record_finding", {
        audit_task_id: auditId,
        target_task_id: implId,
        severity: "blocking",
        spec_refs: ["req-1"],
        summary: "Implementation does not satisfy req-1.",
        evidence_refs: [`/tasks/${implId}`],
        recommendation: "repair",
      });
      expect(finding.status).toBe("ok");
      const findingId = (finding.data as { id: string }).id;

      const blocked = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("blocking_findings_open");
      expect(blocked.error?.message).toContain(findingId);

      const accepted = await consumer.invoke(`/findings/${findingId}`, "accept_finding", {
        reason: "Accepted as a documented deviation.",
      });
      expect(accepted.status).toBe("ok");

      const completed = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(completed.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("creates repair tasks from audit findings", async () => {
    const { provider, consumer } = await harness();

    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "repair from audit" });
      const created = await consumer.invoke("/orchestration", "create_tasks", {
        tasks: [
          { name: "implement", client_ref: "impl", goal: "Implement requirement." },
          {
            name: "audit",
            client_ref: "audit",
            kind: "audit",
            goal: "Audit implementation.",
            depends_on: ["impl"],
            audit_of: "impl",
          },
        ],
      });
      const tasks = (created.data as { created: Array<{ id: string }> }).created;
      const implId = tasks[0]?.id;
      const auditId = tasks[1]?.id;
      expect(typeof implId).toBe("string");
      expect(typeof auditId).toBe("string");

      const finding = await consumer.invoke("/findings", "record_finding", {
        audit_task_id: auditId,
        target_task_id: implId,
        severity: "blocking",
        summary: "Repair needed.",
        recommendation: "repair",
      });
      const findingId = (finding.data as { id: string }).id;

      const repair = await consumer.invoke(`/findings/${findingId}`, "create_repair_task", {
        name: "repair finding",
      });
      expect(repair.status).toBe("ok");
      const repairTaskId = (repair.data as { repair_task_id: string }).repair_task_id;

      const repairTask = await consumer.query(`/tasks/${repairTaskId}`, 1);
      expect(repairTask.properties?.kind).toBe("repair");
      expect(repairTask.properties?.finding_refs).toEqual([findingId]);

      const updatedFinding = await consumer.query(`/findings/${findingId}`, 1);
      expect(updatedFinding.properties?.repair_task_id).toBe(repairTaskId);
    } finally {
      provider.stop();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { CronProvider, type CronCommandRunner } from "../src/providers/builtin/cron";
import { InProcessTransport } from "../src/providers/builtin/in-process";

// Default test runner: spawns the command directly. Equivalent to what
// TerminalProvider's `execute` action would return when invoked through the
// hub with no policy rules installed. Tests that exercise the policy boundary
// install their own runner.
const passthroughRunner: CronCommandRunner = {
  async invoke(_providerId, _path, _action, params) {
    const command = (params as { command: string }).command;
    const proc = Bun.spawn({
      cmd: [Bun.env.SHELL ?? "/bin/sh", "-lc", command],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      status: "ok",
      data: {
        stdout,
        stderr,
        exitCode,
        status: exitCode === 0 ? "ok" : "error",
      },
    };
  },
  cancelApproval() {
    // no policy in this runner, so nothing to cancel
  },
};

function createCronHarness(
  options: ConstructorParameters<typeof CronProvider>[0] = {},
  runner: CronCommandRunner | null = passthroughRunner,
) {
  const provider = new CronProvider({
    maxJobs: 10,
    ...options,
  });
  if (runner) {
    provider.setRunner(runner);
  }
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 4);
}

async function waitFor<T>(
  check: () => Promise<T | null>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("CronProvider", () => {
  test("exposes session, jobs, and approvals state shape", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties).toEqual({
        total_jobs: 0,
        active_jobs: 0,
        completed_jobs: 0,
        errored_jobs: 0,
      });
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "add_job",
        "list_jobs",
        "clear_expired",
      ]);

      const jobs = await consumer.query("/jobs", 2);
      expect(jobs.type).toBe("collection");
      expect(jobs.properties?.count).toBe(0);
      expect(jobs.children ?? []).toEqual([]);

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.type).toBe("collection");
      expect(approvals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("adds a job and lists full job details", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      const addResult = await consumer.invoke("/session", "add_job", {
        name: "hourly-echo",
        schedule: "0 * * * *",
        command: "printf cron-ok",
      });
      expect(addResult.status).toBe("ok");
      const added = addResult.data as { id: string; next_run?: string; status: string };
      expect(typeof added.id).toBe("string");
      expect(added.status).toBe("idle");
      expect(typeof added.next_run).toBe("string");

      const jobs = await consumer.query("/jobs", 2);
      expect(jobs.children).toHaveLength(1);
      expect(jobs.children?.[0]?.properties).toMatchObject({
        id: added.id,
        name: "hourly-echo",
        schedule: "0 * * * *",
        command: "printf cron-ok",
        status: "idle",
        last_run: null,
        last_output_preview: null,
        error_preview: null,
      });

      const listResult = await consumer.invoke("/session", "list_jobs", {});
      expect(listResult.status).toBe("ok");
      expect(listResult.data).toMatchObject([
        {
          id: added.id,
          name: "hourly-echo",
          command: "printf cron-ok",
          status: "idle",
        },
      ]);
    } finally {
      provider.stop();
    }
  });

  test("rejects invalid cron expressions", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      const addResult = await consumer.invoke("/session", "add_job", {
        name: "bad-schedule",
        schedule: "* * *",
        command: "printf nope",
      });
      expect(addResult.status).toBe("error");
      expect(addResult.error?.message).toContain("Invalid cron expression");

      const jobs = await consumer.query("/jobs", 2);
      expect(jobs.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("runs a job immediately and exposes completed output", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_job", {
        name: "run-success",
        schedule: "0 * * * *",
        command: "printf cron-success",
      });
      const jobs = await consumer.query("/jobs", 2);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      const runResult = await consumer.invoke(`/jobs/${jobId}`, "run_now", {});
      expect(runResult.status).toBe("ok");
      expect(runResult.data).toEqual({
        id: jobId,
        message: 'Job "run-success" started.',
      });

      const completed = await waitFor(async () => {
        const current = await consumer.query(`/jobs/${jobId}`, 2);
        return current.properties?.status === "completed" ? current : null;
      });
      expect(completed.properties?.last_output_preview).toBe("cron-success");
      expect(completed.properties?.error_preview).toBeNull();

      const session = await consumer.query("/session", 2);
      expect(session.properties?.completed_jobs).toBe(1);
      expect(session.properties?.errored_jobs).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("records errored job output and clears expired jobs", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_job", {
        name: "run-complete",
        schedule: "0 * * * *",
        command: "printf complete",
      });
      await consumer.invoke("/session", "add_job", {
        name: "run-error",
        schedule: "0 * * * *",
        command: "printf failure >&2; exit 7",
      });

      const jobs = await consumer.query("/jobs", 2);
      const completeId = jobs.children?.find((job) => job.properties?.name === "run-complete")?.id;
      const errorId = jobs.children?.find((job) => job.properties?.name === "run-error")?.id;
      expect(typeof completeId).toBe("string");
      expect(typeof errorId).toBe("string");

      await consumer.invoke(`/jobs/${completeId}`, "run_now", {});
      await consumer.invoke(`/jobs/${errorId}`, "run_now", {});

      const errored = await waitFor(async () => {
        const current = await consumer.query(`/jobs/${errorId}`, 2);
        return current.properties?.status === "errored" ? current : null;
      });
      expect(errored.properties?.last_output_preview).toBe("failure");
      expect(errored.properties?.error_preview).toBe("failure");

      await waitFor(async () => {
        const current = await consumer.query(`/jobs/${completeId}`, 2);
        return current.properties?.status === "completed" ? current : null;
      });

      const clearResult = await consumer.invoke("/session", "clear_expired", {});
      expect(clearResult.status).toBe("ok");
      expect(clearResult.data).toEqual({ removed: 2 });

      const updatedJobs = await consumer.query("/jobs", 2);
      expect(updatedJobs.properties?.count).toBe(0);
      expect(updatedJobs.children ?? []).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("toggles a job disabled and enabled", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_job", {
        name: "toggle-me",
        schedule: "0 * * * *",
        command: "printf toggle",
      });
      const jobs = await consumer.query("/jobs", 2);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      const disableResult = await consumer.invoke(`/jobs/${jobId}`, "toggle", {});
      expect(disableResult.status).toBe("ok");
      expect(disableResult.data).toEqual({ id: jobId, disabled: true });

      const disabled = await consumer.query(`/jobs/${jobId}`, 2);
      expect(disabled.properties?.status).toBe("disabled");
      expect(
        disabled.affordances?.find((affordance) => affordance.action === "toggle")?.label,
      ).toBe("Enable");

      const enableResult = await consumer.invoke(`/jobs/${jobId}`, "toggle", {});
      expect(enableResult.status).toBe("ok");
      expect(enableResult.data).toEqual({ id: jobId, disabled: false });

      const enabled = await consumer.query(`/jobs/${jobId}`, 2);
      expect(enabled.properties?.status).toBe("idle");
      expect(typeof enabled.properties?.next_run).toBe("string");
      expect(enabled.affordances?.find((affordance) => affordance.action === "toggle")?.label).toBe(
        "Disable",
      );
    } finally {
      provider.stop();
    }
  });

  test("marks deletion as dangerous for approval-aware consumers and deletes jobs", async () => {
    const { provider, consumer } = createCronHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_job", {
        name: "delete-me",
        schedule: "0 * * * *",
        command: "printf delete",
      });
      const jobs = await consumer.query("/jobs", 2);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      const deleteAffordance = jobs.children?.[0]?.affordances?.find(
        (affordance) => affordance.action === "delete",
      );
      expect(deleteAffordance?.dangerous).toBe(true);

      const deleteResult = await consumer.invoke(`/jobs/${jobId}`, "delete", {});
      expect(deleteResult.status).toBe("ok");
      expect(deleteResult.data).toEqual({ id: jobId, deleted: true });

      const updatedJobs = await consumer.query("/jobs", 2);
      expect(updatedJobs.properties?.count).toBe(0);
      expect(updatedJobs.children ?? []).toEqual([]);

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("marks a job errored and cancels the queued approval when policy blocks", async () => {
    const cancelledApprovals: Array<{ id: string; reason?: string }> = [];
    const policyBlockingRunner: CronCommandRunner = {
      async invoke() {
        return {
          status: "error",
          data: { approvalId: "appr-1", providerId: "terminal" },
          error: {
            code: "approval_required",
            // Mirror the hub's wire format from src/core/consumer.ts so the
            // suffix-stripping logic is actually exercised.
            message:
              "matches destructive shell command pattern. Resolve via /approvals/appr-1 on provider terminal.",
          },
        };
      },
      cancelApproval(id, reason) {
        cancelledApprovals.push({ id, reason });
      },
    };
    const { provider, consumer } = createCronHarness({}, policyBlockingRunner);

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_job", {
        name: "destructive",
        schedule: "0 * * * *",
        command: "rm -rf /tmp/sloppy-test",
      });
      const jobs = await consumer.query("/jobs", 2);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      await consumer.invoke(`/jobs/${jobId}`, "run_now", {});

      const errored = await waitFor(async () => {
        const current = await consumer.query(`/jobs/${jobId}`, 2);
        return current.properties?.status === "errored" ? current : null;
      });
      expect(errored.properties?.error_preview).toContain("Blocked by policy");
      // The hub's "Resolve via /approvals/<id>" suffix points at an approval
      // we just cancelled, so cron strips it from the recorded job error.
      expect(errored.properties?.error_preview).not.toContain("Resolve via");
      expect(errored.properties?.error_preview).not.toContain("/approvals/");
      expect(cancelledApprovals).toHaveLength(1);
      expect(cancelledApprovals[0]?.id).toBe("appr-1");
      expect(cancelledApprovals[0]?.reason).toContain("destructive");
    } finally {
      provider.stop();
    }
  });

  test("policy-blocked cron jobs do not accumulate rejected approvals in the hub queue", async () => {
    // Repeat the same blocked job several times and assert the queue stays
    // empty. The previous behaviour left a 'rejected' record per run, so a
    // minutely-firing blocked job would grow the queue without bound.
    let cancelCount = 0;
    let nextApprovalId = 0;
    const queue = new Set<string>();
    const blockingRunner: CronCommandRunner = {
      async invoke() {
        const approvalId = `appr-${++nextApprovalId}`;
        queue.add(approvalId);
        return {
          status: "error",
          data: { approvalId, providerId: "terminal" },
          error: { code: "approval_required", message: "blocked" },
        };
      },
      cancelApproval(id) {
        if (!queue.delete(id)) {
          throw new Error(`Unknown approval: ${id}`);
        }
        cancelCount++;
      },
    };
    const { provider, consumer } = createCronHarness({}, blockingRunner);

    try {
      await connect(consumer);
      await consumer.invoke("/session", "add_job", {
        name: "blocked",
        schedule: "0 * * * *",
        command: "rm -rf /tmp/sloppy-test",
      });
      const jobs = await consumer.query("/jobs", 2);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      for (let i = 0; i < 3; i++) {
        await consumer.invoke(`/jobs/${jobId}`, "run_now", {});
        await waitFor(async () => {
          const current = await consumer.query(`/jobs/${jobId}`, 2);
          return current.properties?.status === "errored" ? current : null;
        });
      }

      expect(cancelCount).toBe(3);
      expect(queue.size).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("refuses to spawn shells when no runner is wired", async () => {
    const { provider, consumer } = createCronHarness({}, null);

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_job", {
        name: "unwired",
        schedule: "0 * * * *",
        command: "printf hi",
      });
      const jobs = await consumer.query("/jobs", 2);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      await consumer.invoke(`/jobs/${jobId}`, "run_now", {});

      const errored = await waitFor(async () => {
        const current = await consumer.query(`/jobs/${jobId}`, 2);
        return current.properties?.status === "errored" ? current : null;
      });
      expect(errored.properties?.error_preview).toContain("not wired to a command runner");
    } finally {
      provider.stop();
    }
  });

  test("enforces the configured maximum job count", async () => {
    const { provider, consumer } = createCronHarness({ maxJobs: 1 });

    try {
      await connect(consumer);

      const firstResult = await consumer.invoke("/session", "add_job", {
        name: "first",
        schedule: "0 * * * *",
        command: "printf first",
      });
      expect(firstResult.status).toBe("ok");

      const secondResult = await consumer.invoke("/session", "add_job", {
        name: "second",
        schedule: "0 * * * *",
        command: "printf second",
      });
      expect(secondResult.status).toBe("error");
      expect(secondResult.error?.message).toContain("Maximum number of jobs reached");

      const jobs = await consumer.query("/jobs", 2);
      expect(jobs.children).toHaveLength(1);
      expect(jobs.children?.[0]?.properties?.name).toBe("first");
    } finally {
      provider.stop();
    }
  });
});

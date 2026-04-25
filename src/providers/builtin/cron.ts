import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { ProviderApprovalManager } from "../approvals";

export interface CronCommandRunner {
  invoke(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<{
    status: string;
    data?: unknown;
    error?: { code?: string; message?: string };
  }>;
  /**
   * Cancel an approval that was implicitly enqueued for a command this
   * provider routed through `invoke`. Removes the record entirely (rather
   * than marking it 'rejected') because cron's cancellations are synthetic
   * — a minutely-firing blocked job would otherwise grow the queue
   * without bound. Human rejections continue to leave an audit record.
   */
  cancelApproval(approvalId: string, reason?: string): void;
}

type CronStatus = "idle" | "running" | "completed" | "errored" | "disabled";

type CronJob = {
  id: string;
  name: string;
  schedule: string;
  command: string;
  status: CronStatus;
  next_run?: string;
  last_run?: string;
  last_output?: string;
  error?: string;
  disabled?: boolean;
  created_at: string;
};

function parseCronNext(schedule: string): string | undefined {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return undefined;
  }

  const [minute, hour, dom, month, dow] = parts;

  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Scan forward up to 366 days to find the next matching time
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      matchCronField(month, candidate.getMonth() + 1, 1, 12) &&
      matchCronField(dom, candidate.getDate(), 1, 31) &&
      matchCronField(dow, candidate.getDay(), 0, 6) &&
      matchCronField(hour, candidate.getHours(), 0, 23) &&
      matchCronField(minute, candidate.getMinutes(), 0, 59)
    ) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return undefined;
}

function matchCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") {
    return true;
  }

  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && (value - min) % step === 0;
  }

  if (field.includes(",")) {
    return field.split(",").some((part) => matchCronField(part.trim(), value, min, max));
  }

  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return value >= lo && value <= hi;
  }

  return parseInt(field, 10) === value;
}

function truncatePreview(text: string, maxChars = 200): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 14)}\n...[truncated]`;
}

export class CronProvider {
  readonly server: SlopServer;
  private maxJobs: number;
  readonly approvals: ProviderApprovalManager;
  private jobs = new Map<string, CronJob>();
  private ticker: ReturnType<typeof setInterval>;
  private runner: CronCommandRunner | null = null;

  constructor(options: { maxJobs?: number } = {}) {
    this.maxJobs = options.maxJobs ?? 50;

    this.server = createSlopServer({
      id: "cron",
      name: "Cron",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("jobs", () => this.buildJobsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());

    this.ticker = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    clearInterval(this.ticker);
    this.server.stop();
  }

  /**
   * Wire the provider to a command runner (typically a `ConsumerHub`) so jobs
   * execute through the hub's policy boundary. Until set, jobs cannot run —
   * any tick or `run_now` will mark the job as errored. This makes cron a
   * strict consumer of the same `terminalSafetyRule` / `dangerousActionRule`
   * stack that protects interactive shell use.
   */
  setRunner(runner: CronCommandRunner | null): void {
    this.runner = runner;
  }

  private tick(): void {
    const now = new Date();
    let mutated = false;

    for (const job of this.jobs.values()) {
      if (job.disabled || job.status === "running") {
        continue;
      }

      if (job.next_run && new Date(job.next_run) <= now) {
        void this.executeJob(job.id);
        mutated = true;
      }
    }

    if (mutated) {
      this.server.refresh();
    }
  }

  private async executeJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }

    job.status = "running";
    job.last_run = new Date().toISOString();
    this.server.refresh();

    if (!this.runner) {
      job.status = "errored";
      job.error =
        "Cron is not wired to a command runner; refusing to spawn shells outside the hub policy boundary.";
      job.last_output = undefined;
      job.next_run = parseCronNext(job.schedule);
      this.server.refresh();
      return;
    }

    try {
      const result = await this.runner.invoke("terminal", "/session", "execute", {
        command: job.command,
        background: false,
      });

      if (result.status !== "ok") {
        job.status = "errored";
        if (result.error?.code === "approval_required") {
          // Cron should not silently queue dangerous commands for human
          // approval — that would let scheduled jobs accumulate pending
          // dangerous work indefinitely AND leave a hub-level approval that
          // a human could later approve, executing the destructive command
          // outside any cron job lifecycle. Cancel the queued approval.
          const approvalId = (result.data as { approvalId?: string } | undefined)?.approvalId;
          if (approvalId) {
            try {
              this.runner.cancelApproval(
                approvalId,
                `Cron job "${job.name}" blocked by policy.`,
              );
            } catch {
              // best-effort cancellation; the approval may already be resolved
            }
          }
          // The hub's approval_required message ends with
          // "Resolve via /approvals/<id> on provider <name>." We just
          // cancelled that approval, so strip the dead pointer to avoid
          // sending users to a path that no longer exists.
          const rawMessage = result.error.message ?? "approval required";
          const policyReason = rawMessage
            .replace(/\s*Resolve via \/approvals\/[^\s]+ on provider [^.]+\.\s*$/, "")
            .trim();
          job.error = truncatePreview(`Blocked by policy: ${policyReason || "approval required"}`);
        } else {
          job.error = truncatePreview(
            result.error?.message ?? `Execution failed (code ${result.error?.code ?? "unknown"})`,
          );
        }
        job.last_output = undefined;
      } else {
        const data = (result.data ?? {}) as {
          stdout?: string;
          stderr?: string;
          exitCode?: number | null;
          status?: string;
        };
        const stdout = data.stdout ?? "";
        const stderr = data.stderr ?? "";
        const exitCode = data.exitCode ?? null;
        job.last_output = stdout || stderr;

        if (data.status === "ok" && (exitCode === 0 || exitCode === null)) {
          job.status = "completed";
          job.error = undefined;
        } else {
          job.status = "errored";
          job.error = truncatePreview(stderr || `Exited with code ${exitCode}`);
        }
      }
    } catch (error) {
      job.status = "errored";
      job.error = error instanceof Error ? error.message : String(error);
    }

    job.next_run = parseCronNext(job.schedule);
    this.server.refresh();
  }

  private addJob(name: string, schedule: string, command: string): CronJob {
    if (this.jobs.size >= this.maxJobs) {
      throw new Error(`Maximum number of jobs reached (${this.maxJobs}).`);
    }

    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: "${schedule}". Expected 5 fields.`);
    }

    const id = crypto.randomUUID();
    const job: CronJob = {
      id,
      name,
      schedule,
      command,
      status: "idle",
      next_run: parseCronNext(schedule),
      created_at: new Date().toISOString(),
    };

    this.jobs.set(id, job);
    this.server.refresh();
    return job;
  }

  private runNow(id: string): { id: string; message: string } {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown job: ${id}`);
    }

    if (job.status === "running") {
      throw new Error(`Job "${job.name}" is already running.`);
    }

    void this.executeJob(id);
    return { id, message: `Job "${job.name}" started.` };
  }

  private toggleJob(id: string): { id: string; disabled: boolean } {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown job: ${id}`);
    }

    job.disabled = !job.disabled;
    job.status = job.disabled ? "disabled" : "idle";

    if (!job.disabled) {
      job.next_run = parseCronNext(job.schedule);
    }

    this.server.refresh();
    return { id, disabled: !!job.disabled };
  }

  private deleteJob(id: string): { id: string; deleted: boolean } {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown job: ${id}`);
    }

    this.jobs.delete(id);
    this.server.refresh();
    return { id, deleted: true };
  }

  private listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  private clearExpired(): { removed: number } {
    let removed = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "completed" || job.status === "errored") {
        this.jobs.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.server.refresh();
    }

    return { removed };
  }

  private buildSessionDescriptor() {
    const all = [...this.jobs.values()];
    const active = all.filter((j) => j.status === "running" || j.status === "idle").length;
    const completed = all.filter((j) => j.status === "completed").length;
    const errored = all.filter((j) => j.status === "errored").length;

    return {
      type: "context",
      props: {
        total_jobs: all.length,
        active_jobs: active,
        completed_jobs: completed,
        errored_jobs: errored,
      },
      summary: "Cron job scheduler session.",
      actions: {
        add_job: action(
          {
            name: "string",
            schedule: {
              type: "string",
              description: "5-field cron expression (e.g. '0 * * * *' for hourly).",
            },
            command: "string",
          },
          ({ name, schedule, command }) => this.addJob(name, schedule, command),
          {
            label: "Add Job",
            description: "Create a new scheduled cron job.",
            estimate: "instant",
          },
        ),
        list_jobs: action({}, () => this.listJobs(), {
          label: "List Jobs",
          description: "Return all cron jobs with full details.",
          idempotent: true,
          estimate: "instant",
        }),
        clear_expired: action({}, () => this.clearExpired(), {
          label: "Clear Expired",
          description: "Remove all completed and errored jobs.",
          estimate: "instant",
        }),
      },
      meta: {
        focus: true,
        salience: errored > 0 ? 1 : 0.7,
      },
    };
  }

  private buildJobsDescriptor() {
    const items: ItemDescriptor[] = [...this.jobs.values()].map((job) => ({
      id: job.id,
      props: {
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        command: job.command,
        status: job.status,
        next_run: job.next_run ?? null,
        last_run: job.last_run ?? null,
        last_output_preview: job.last_output ? truncatePreview(job.last_output) : null,
        error_preview: job.error ? truncatePreview(job.error) : null,
      },
      actions: {
        run_now: action(async () => this.runNow(job.id), {
          label: "Run Now",
          description: "Execute this job immediately, outside its schedule.",
          estimate: "instant",
        }),
        toggle: action(async () => this.toggleJob(job.id), {
          label: job.disabled ? "Enable" : "Disable",
          description: "Enable or disable this job without deleting it.",
          estimate: "instant",
        }),
        delete: action(async () => this.deleteJob(job.id), {
          label: "Delete Job",
          description: "Permanently remove this cron job.",
          dangerous: true,
          estimate: "instant",
        }),
      },
      meta: {
        salience: job.status === "errored" ? 1 : job.status === "running" ? 0.9 : 0.6,
        urgency: job.status === "errored" ? "high" : job.status === "running" ? "medium" : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "All scheduled cron jobs.",
      items,
    };
  }
}

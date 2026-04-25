import { debug } from "../../../core/debug";
import { terminalTaskStatus } from "./classifiers";
import type { TaskLifecycle } from "./lifecycle";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type { Plan } from "./types";

export interface PlanLifecycleDeps {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  sessionId: string;
  refresh: () => void;
}

export class PlanLifecycle {
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly sessionId: string;
  private readonly refresh: () => void;

  constructor(deps: PlanLifecycleDeps) {
    this.repo = deps.repo;
    this.lifecycle = deps.lifecycle;
    this.sessionId = deps.sessionId;
    this.refresh = deps.refresh;
  }

  createPlan(params: {
    query: string;
    strategy?: string;
    max_agents?: number;
  }): Plan & { version: number } {
    const existing = this.repo.loadPlan();
    if (existing && existing.status === "active") {
      throw new Error(`An active plan already exists for session ${existing.session_id}.`);
    }

    const plan: Plan = {
      id: `plan-${crypto.randomUUID().slice(0, 8)}`,
      session_id: this.sessionId,
      query: params.query,
      strategy: params.strategy ?? "sequential",
      max_agents: params.max_agents ?? 5,
      created_at: new Date().toISOString(),
      status: "active",
    };
    const version = this.repo.bumpPlanVersion();
    this.repo.writePlan({ ...plan, version });
    debug("orchestration", "create_plan", { session: this.sessionId, version });
    this.refresh();
    return { ...plan, version };
  }

  completePlan(params: { status: "completed" | "cancelled"; expected_version?: number }): {
    status: Plan["status"];
    version: number;
  } {
    const plan = this.repo.loadPlan();
    if (!plan) throw new Error("No plan exists.");
    const current = this.repo.planVersion();
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "complete_plan_conflict", {
        expected: params.expected_version,
        current,
      });
      return { status: plan.status, version: current };
    }
    if (params.status === "completed") {
      const incomplete = this.incompleteTasksForPlanCompletion();
      if (incomplete.length > 0) {
        throw codedError(
          "plan_incomplete",
          `Cannot complete plan while non-superseded tasks are unfinished: ${incomplete.join(", ")}.`,
        );
      }
      const openBlockingFindings = this.openBlockingFindingsForPlan(plan);
      if (openBlockingFindings.length > 0) {
        throw codedError(
          "blocking_findings_open",
          `Cannot complete plan while blocking audit findings are open: ${openBlockingFindings.join(", ")}.`,
        );
      }
    }
    const cancelledTasks =
      params.status === "cancelled" ? this.cancelUnfinishedTasksForPlan(plan) : 0;
    const cancelledHandoffs =
      params.status === "cancelled" ? this.cancelPendingHandoffsForPlan(plan) : 0;
    const version = this.repo.bumpPlanVersion();
    const next: Plan = { ...plan, status: params.status, version };
    this.repo.writePlan(next as Plan & { version: number });
    debug("orchestration", "complete_plan", {
      status: params.status,
      version,
      cancelledTasks,
      cancelledHandoffs,
    });
    this.refresh();
    return { status: next.status, version };
  }

  private incompleteTasksForPlanCompletion(): string[] {
    const plan = this.repo.loadPlan();
    return this.repo.listTaskIdsForPlan(plan).filter((taskId) => {
      const state = this.repo.loadTaskState(taskId);
      if (!state) return true;
      return (
        state.status !== "completed" &&
        state.status !== "cancelled" &&
        state.status !== "superseded"
      );
    });
  }

  private openBlockingFindingsForPlan(plan = this.repo.loadPlan()): string[] {
    return this.repo
      .listFindingsForPlan(plan)
      .filter((finding) => finding.status === "open" && finding.severity === "blocking")
      .map((finding) => finding.id);
  }

  private cancelUnfinishedTasksForPlan(plan: Plan): number {
    let cancelled = 0;
    for (const taskId of this.repo.listTaskIdsForPlan(plan)) {
      const state = this.repo.loadTaskState(taskId);
      if (!state || terminalTaskStatus(state.status)) continue;
      const result = this.lifecycle.updateTaskState(
        taskId,
        {
          status: "cancelled",
          message: "Cancelled because the orchestration plan was cancelled.",
          completed_at: new Date().toISOString(),
        },
        undefined,
      );
      if (!("error" in result)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private cancelPendingHandoffsForPlan(plan: Plan): number {
    let cancelled = 0;
    for (const handoff of this.repo.listHandoffsForPlan(plan)) {
      if (handoff.status !== "pending") continue;
      const version = this.repo.bumpHandoffVersion(handoff.id);
      this.repo.writeHandoff({
        ...handoff,
        status: "cancelled",
        responded_at: new Date().toISOString(),
        version,
      });
      cancelled += 1;
    }
    return cancelled;
  }
}

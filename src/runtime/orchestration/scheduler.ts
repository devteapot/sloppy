import type { SlopNode } from "@slop-ai/consumer/browser";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";

type SchedulerTaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

type SchedulerTask = {
  id: string;
  name: string;
  goal: string;
  status: SchedulerTaskStatus;
  unmetDependencies: string[];
  version?: number;
  executorBinding?: Record<string, unknown>;
};

type SchedulerAgent = {
  id: string;
  status: string;
  orchestrationTaskId?: string;
};

type SchedulerPlan = {
  active: boolean;
  maxAgents?: number;
  goalId?: string;
  version?: number;
  gateMode?: string;
  finalAuditId?: string;
};

export type OrchestrationSchedulerEvent =
  | {
      kind: "task_unblocked";
      taskId: string;
      taskName?: string;
      version?: number;
      summary: string;
    }
  | {
      kind: "task_scheduled";
      taskId: string;
      taskName?: string;
      version?: number;
      summary: string;
    }
  | {
      kind: "task_started";
      taskId: string;
      taskName?: string;
      agentId?: string;
      summary: string;
    }
  | {
      kind: "scheduler_idle";
      reason: string;
      summary: string;
    }
  | {
      kind: "scheduler_blocked";
      reason: string;
      taskId?: string;
      taskName?: string;
      detail?: string;
      summary: string;
    };

const ACTIVE_AGENT_STATUSES = new Set(["pending", "running"]);
const TERMINAL_TASK_STATUSES = new Set<SchedulerTaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
const SCHEDULABLE_TASK_STATUSES = new Set(["pending", "scheduled"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberProp(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayProp(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeTaskStatus(value: unknown): SchedulerTaskStatus | null {
  switch (value) {
    case "pending":
    case "scheduled":
    case "running":
    case "verifying":
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
      return value;
    default:
      return null;
  }
}

function taskSignature(task: SchedulerTask): string {
  return `${task.id}:${task.status}:${task.version ?? "unknown"}`;
}

function parseTasks(tree: SlopNode | null): SchedulerTask[] {
  return (tree?.children ?? []).flatMap((node) => {
    const props = asRecord(node.properties);
    const id = stringProp(props, "id") ?? node.id;
    const status = normalizeTaskStatus(props.status);
    const goal = stringProp(props, "goal");
    if (!id || !status || !goal) {
      return [];
    }

    const executorBinding =
      typeof props.executor_binding === "object" && props.executor_binding !== null
        ? (props.executor_binding as Record<string, unknown>)
        : undefined;
    return [
      {
        id,
        name: stringProp(props, "name") ?? id,
        goal,
        status,
        unmetDependencies: stringArrayProp(props, "unmet_dependencies"),
        version: numberProp(props, "version"),
        executorBinding,
      },
    ];
  });
}

function parseAgents(tree: SlopNode | null): SchedulerAgent[] {
  return (tree?.children ?? []).map((node) => {
    const props = asRecord(node.properties);
    return {
      id: stringProp(props, "id") ?? node.id,
      status: stringProp(props, "status") ?? "unknown",
      orchestrationTaskId: stringProp(props, "orchestration_task_id"),
    };
  });
}

function parsePlan(tree: SlopNode | null): SchedulerPlan {
  const props = asRecord(tree?.properties);
  return {
    active: props.plan_status === "active",
    maxAgents: numberProp(props, "plan_max_agents"),
    goalId: stringProp(props, "plan_goal_id"),
    version: numberProp(props, "plan_version"),
    gateMode: stringProp(props, "gate_mode"),
    finalAuditId: stringProp(props, "final_audit_id"),
  };
}

export class OrchestrationScheduler {
  private stops: Array<() => void> = [];
  private planTree: SlopNode | null = null;
  private tasksTree: SlopNode | null = null;
  private agentsTree: SlopNode | null = null;
  private stopped = false;
  private evaluationQueued = false;
  private evaluating = false;
  private pendingEvaluation = false;
  private delayedEvaluation: ReturnType<typeof setTimeout> | null = null;
  private inFlightTasks = new Set<string>();
  private unblockedSignatures = new Set<string>();
  private blockedTaskSignatures = new Set<string>();
  private lifecycleSignatures = new Set<string>();
  private lastIdleSignature: string | null = null;
  private lastBlockedSignature: string | null = null;

  constructor(
    private options: {
      hub: ProviderRuntimeHub;
      maxAgents: number;
      orchestrationProviderId?: string;
      delegationProviderId?: string;
      onEvent?: (event: OrchestrationSchedulerEvent) => void;
    },
  ) {}

  async start(): Promise<void> {
    const orchestrationProviderId = this.options.orchestrationProviderId ?? "orchestration";
    const delegationProviderId = this.options.delegationProviderId ?? "delegation";

    try {
      this.stops.push(
        await this.options.hub.watchPath(orchestrationProviderId, "/orchestration", (tree) => {
          this.planTree = tree;
          this.requestEvaluation();
        }),
      );
      this.stops.push(
        await this.options.hub.watchPath(orchestrationProviderId, "/tasks", (tree) => {
          this.tasksTree = tree;
          this.requestEvaluation();
        }),
      );
      this.stops.push(
        await this.options.hub.watchPath(delegationProviderId, "/agents", (tree) => {
          this.agentsTree = tree;
          this.requestEvaluation();
        }),
      );
    } catch (error) {
      this.stop();
      const detail = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: "scheduler_blocked",
        reason: "provider_unavailable",
        detail,
        summary: `Orchestration scheduler disabled: ${detail}`,
      });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const stop of this.stops.splice(0)) {
      try {
        stop();
      } catch {
        // best-effort subscription cleanup
      }
    }
    this.inFlightTasks.clear();
    if (this.delayedEvaluation) {
      clearTimeout(this.delayedEvaluation);
      this.delayedEvaluation = null;
    }
  }

  private requestEvaluation(): void {
    if (this.stopped) {
      return;
    }

    this.pendingEvaluation = true;
    if (this.evaluationQueued) {
      return;
    }

    this.evaluationQueued = true;
    queueMicrotask(() => {
      this.evaluationQueued = false;
      void this.drainEvaluations();
    });
  }

  private requestDelayedEvaluation(delayMs = 25): void {
    if (this.stopped || this.delayedEvaluation) return;
    this.delayedEvaluation = setTimeout(() => {
      this.delayedEvaluation = null;
      this.requestEvaluation();
    }, delayMs);
  }

  private async drainEvaluations(): Promise<void> {
    if (this.evaluating || this.stopped) {
      return;
    }

    this.evaluating = true;
    try {
      while (this.pendingEvaluation && !this.stopped) {
        this.pendingEvaluation = false;
        await this.evaluateOnce();
      }
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluateOnce(): Promise<void> {
    await this.refreshWatchedState();
    const plan = parsePlan(this.planTree);
    if (!plan.active) {
      this.emitIdle("no_active_plan", "Scheduler idle: no active orchestration plan.");
      return;
    }

    const tasks = parseTasks(this.tasksTree);
    this.syncAutonomousLifecycle(plan, tasks);
    const agents = parseAgents(this.agentsTree);
    const taskStatusById = new Map(tasks.map((task) => [task.id, task.status]));
    const activeAgents = agents.filter((agent) => {
      if (!ACTIVE_AGENT_STATUSES.has(agent.status)) {
        return false;
      }
      if (!agent.orchestrationTaskId) {
        return true;
      }
      const attachedTaskStatus = taskStatusById.get(agent.orchestrationTaskId);
      return !attachedTaskStatus || !TERMINAL_TASK_STATUSES.has(attachedTaskStatus);
    });
    const activeTaskIds = new Set(
      activeAgents
        .map((agent) => agent.orchestrationTaskId)
        .filter((taskId): taskId is string => typeof taskId === "string"),
    );
    const maxAgents = Math.max(
      1,
      Math.min(this.options.maxAgents, plan.maxAgents ?? this.options.maxAgents),
    );
    const availableSlots = maxAgents - activeAgents.length - this.inFlightTasks.size;

    const candidates = tasks.filter((task) => {
      if (!SCHEDULABLE_TASK_STATUSES.has(task.status)) {
        return false;
      }
      if (task.unmetDependencies.length > 0) {
        return false;
      }
      if (activeTaskIds.has(task.id) || this.inFlightTasks.has(task.id)) {
        return false;
      }
      if (this.blockedTaskSignatures.has(taskSignature(task))) {
        return false;
      }
      return true;
    });

    for (const task of candidates) {
      if (task.status !== "pending") {
        continue;
      }
      const signature = taskSignature(task);
      if (this.unblockedSignatures.has(signature)) {
        continue;
      }
      this.unblockedSignatures.add(signature);
      this.emit({
        kind: "task_unblocked",
        taskId: task.id,
        taskName: task.name,
        version: task.version,
        summary: `${task.name} is runnable.`,
      });
    }

    if (candidates.length === 0) {
      const activeCount = activeAgents.length + this.inFlightTasks.size;
      if (activeCount > 0) {
        this.requestDelayedEvaluation();
      }
      this.emitIdle(
        `no_runnable:${activeCount}:${tasks.length}`,
        activeCount > 0
          ? `Scheduler idle: ${activeCount} delegated task(s) already active.`
          : "Scheduler idle: no runnable pending tasks.",
      );
      return;
    }

    if (availableSlots <= 0) {
      this.emitBlocked(`capacity:${activeAgents.length}:${maxAgents}`, {
        kind: "scheduler_blocked",
        reason: "capacity",
        summary: `Scheduler blocked: ${activeAgents.length}/${maxAgents} delegated agents active.`,
      });
      return;
    }

    await Promise.all(
      candidates.slice(0, availableSlots).map((task) => this.scheduleAndSpawn(task, plan)),
    );
  }

  private async refreshWatchedState(): Promise<void> {
    const orchestrationProviderId = this.options.orchestrationProviderId ?? "orchestration";
    const delegationProviderId = this.options.delegationProviderId ?? "delegation";
    try {
      const [planTree, tasksTree, agentsTree] = await Promise.all([
        this.options.hub.queryState({
          providerId: orchestrationProviderId,
          path: "/orchestration",
          depth: 1,
        }),
        this.options.hub.queryState({
          providerId: orchestrationProviderId,
          path: "/tasks",
          depth: 2,
        }),
        this.options.hub.queryState({
          providerId: delegationProviderId,
          path: "/agents",
          depth: 2,
        }),
      ]);
      this.planTree = planTree;
      this.tasksTree = tasksTree;
      this.agentsTree = agentsTree;
    } catch (error) {
      this.emit({
        kind: "scheduler_blocked",
        reason: "provider_unavailable",
        detail: error instanceof Error ? error.message : String(error),
        summary: "Scheduler could not refresh orchestration state.",
      });
    }
  }

  private async scheduleAndSpawn(task: SchedulerTask, plan: SchedulerPlan): Promise<void> {
    const orchestrationProviderId = this.options.orchestrationProviderId ?? "orchestration";
    const delegationProviderId = this.options.delegationProviderId ?? "delegation";
    this.inFlightTasks.add(task.id);
    try {
      let version = task.version;
      if (task.status === "pending") {
        const scheduleResult = await this.options.hub.invoke(
          orchestrationProviderId,
          `/tasks/${task.id}`,
          "schedule",
          {
            expected_version: version,
          },
          // Scheduler invocations must NOT inherit the orchestrator role —
          // `orchestratorRoleRule` denies `delegation.spawn_agent`, which is
          // exactly the path the scheduler exists to take on the orchestrator's
          // behalf. Tag with `actor: "scheduler"` for telemetry; leave
          // `roleId` unset so role-scoped rules see no role.
          { actor: "scheduler" },
        );
        const scheduleData = asRecord(scheduleResult.data);
        if (scheduleResult.status === "error") {
          this.blockTask(task, "schedule_failed", scheduleResult.error?.message);
          return;
        }
        if (scheduleData.error === "version_conflict") {
          this.emit({
            kind: "scheduler_blocked",
            reason: "version_conflict",
            taskId: task.id,
            taskName: task.name,
            detail: `Current version: ${String(scheduleData.currentVersion ?? "unknown")}`,
            summary: `${task.name} changed before the scheduler could claim it.`,
          });
          return;
        }
        version = numberProp(scheduleData, "version") ?? version;
        this.emit({
          kind: "task_scheduled",
          taskId: task.id,
          taskName: task.name,
          version,
          summary: `${task.name} was scheduled for delegation.`,
        });
      }

      const spawnParams: Record<string, unknown> = {
        name: task.name,
        goal: task.goal,
        task_id: task.id,
        role: "executor",
        idempotency_key: `orchestration:executor:${task.id}`,
      };
      if (task.executorBinding) {
        spawnParams.executor = task.executorBinding;
      }
      const spawnResult = await this.options.hub.invoke(
        delegationProviderId,
        "/session",
        "spawn_agent",
        spawnParams,
        { actor: "scheduler" },
      );
      if (spawnResult.status === "error") {
        this.blockTask(
          { ...task, status: "scheduled", version },
          "spawn_failed",
          spawnResult.error?.message,
        );
        return;
      }

      const spawnData = asRecord(spawnResult.data);
      this.emit({
        kind: "task_started",
        taskId: task.id,
        taskName: task.name,
        agentId: stringProp(spawnData, "id"),
        summary: `${task.name} was handed to a delegated agent.`,
      });
      this.persistAutonomousLifecycle(plan.goalId, "executor.spawned", { taskId: task.id });
    } catch (error) {
      this.blockTask(task, "invoke_failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.inFlightTasks.delete(task.id);
    }
  }

  private syncAutonomousLifecycle(plan: SchedulerPlan, tasks: SchedulerTask[]): void {
    if (!plan.goalId || tasks.length === 0) return;

    for (const task of tasks) {
      switch (task.status) {
        case "running":
          this.persistAutonomousLifecycle(plan.goalId, "executor.running", { taskId: task.id });
          break;
        case "verifying":
          this.persistAutonomousLifecycle(plan.goalId, "executor.verifying", { taskId: task.id });
          break;
        case "completed":
          this.persistAutonomousLifecycle(plan.goalId, "executor.completed", { taskId: task.id });
          break;
        case "failed":
          this.persistAutonomousLifecycle(plan.goalId, "goal.failed", { taskId: task.id });
          break;
        case "cancelled":
          this.persistAutonomousLifecycle(plan.goalId, "goal.escalated", { taskId: task.id });
          break;
      }
    }

    const terminalTasks = tasks.filter((task) =>
      ["completed", "failed", "cancelled", "superseded"].includes(task.status),
    );
    if (terminalTasks.length !== tasks.length) return;

    const blockingTask = tasks.find(
      (task) => task.status === "failed" || task.status === "cancelled",
    );
    if (blockingTask) {
      this.persistAutonomousLifecycle(
        plan.goalId,
        blockingTask.status === "failed" ? "goal.failed" : "goal.escalated",
        { taskId: blockingTask.id },
      );
      return;
    }

    if (this.requiresFinalAudit(plan)) {
      this.runFinalAudit(plan);
      return;
    }

    this.persistAutonomousLifecycle(plan.goalId, "goal.completed", {
      taskIds: tasks.map((task) => task.id).join(","),
    });
    this.completeAutonomousPlan(plan);
  }

  private requiresFinalAudit(plan: SchedulerPlan): boolean {
    return plan.gateMode === "hitl" && !plan.finalAuditId;
  }

  private runFinalAudit(plan: SchedulerPlan): void {
    if (!plan.goalId) return;
    const signature = `run_final_audit:${plan.goalId}:${plan.version ?? "unknown"}`;
    if (this.lifecycleSignatures.has(signature)) return;
    this.lifecycleSignatures.add(signature);
    const orchestrationProviderId = this.options.orchestrationProviderId ?? "orchestration";
    void this.options.hub
      .invoke(orchestrationProviderId, "/audit", "run_final_audit", {}, { actor: "scheduler" })
      .then((result) => {
        if (result.status === "error") {
          debug("scheduler", "run_final_audit_failed", {
            goalId: plan.goalId,
            error: result.error?.message,
          });
          return;
        }
        this.requestEvaluation();
      })
      .catch((error: unknown) => {
        debug("scheduler", "run_final_audit_failed", {
          goalId: plan.goalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private completeAutonomousPlan(plan: SchedulerPlan): void {
    if (!plan.goalId) return;
    const signature = `complete_plan:${plan.goalId}:${plan.version ?? "unknown"}`;
    if (this.lifecycleSignatures.has(signature)) return;
    this.lifecycleSignatures.add(signature);
    const orchestrationProviderId = this.options.orchestrationProviderId ?? "orchestration";
    void this.options.hub
      .invoke(
        orchestrationProviderId,
        "/orchestration",
        "complete_plan",
        { status: "completed", expected_version: plan.version },
        { actor: "scheduler" },
      )
      .then((result) => {
        if (result.status === "error") {
          debug("scheduler", "complete_plan_failed", {
            goalId: plan.goalId,
            error: result.error?.message,
          });
        }
      })
      .catch((error: unknown) => {
        debug("scheduler", "complete_plan_failed", {
          goalId: plan.goalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private persistAutonomousLifecycle(
    goalId: string | undefined,
    stage: string,
    refs: Record<string, string>,
  ): void {
    if (!goalId) return;
    const signature = `${goalId}:${stage}:${JSON.stringify(refs)}`;
    if (this.lifecycleSignatures.has(signature)) return;
    this.lifecycleSignatures.add(signature);
    const orchestrationProviderId = this.options.orchestrationProviderId ?? "orchestration";
    void this.options.hub
      .invoke(
        orchestrationProviderId,
        `/goals/${goalId}`,
        "update_autonomous_lifecycle",
        { stage, refs },
        { actor: "scheduler" },
      )
      .then((result) => {
        if (result.status === "error") {
          debug("scheduler", "lifecycle_persist_failed", {
            goalId,
            stage,
            error: result.error?.message,
          });
        }
      })
      .catch((error: unknown) => {
        debug("scheduler", "lifecycle_persist_failed", {
          goalId,
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private blockTask(task: SchedulerTask, reason: string, detail?: string): void {
    this.blockedTaskSignatures.add(taskSignature(task));
    this.emit({
      kind: "scheduler_blocked",
      reason,
      taskId: task.id,
      taskName: task.name,
      detail,
      summary: detail
        ? `Scheduler blocked on ${task.name}: ${detail}`
        : `Scheduler blocked on ${task.name}.`,
    });
  }

  private emitIdle(signature: string, summary: string): void {
    if (this.lastIdleSignature === signature) {
      return;
    }
    this.lastIdleSignature = signature;
    this.emit({
      kind: "scheduler_idle",
      reason: signature.split(":")[0] ?? signature,
      summary,
    });
  }

  private emitBlocked(signature: string, event: OrchestrationSchedulerEvent): void {
    if (this.lastBlockedSignature === signature) {
      return;
    }
    this.lastBlockedSignature = signature;
    this.emit(event);
  }

  private emit(event: OrchestrationSchedulerEvent): void {
    debug("orchestration", "scheduler_event", event);
    this.options.onEvent?.(event);
  }
}

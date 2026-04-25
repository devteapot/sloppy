import type { SlopNode } from "@slop-ai/consumer/browser";

import type { ConsumerHub } from "../../core/consumer";
import { debug } from "../../core/debug";

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
};

type SchedulerAgent = {
  id: string;
  status: string;
  orchestrationTaskId?: string;
};

type SchedulerPlan = {
  active: boolean;
  maxAgents?: number;
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

    return [
      {
        id,
        name: stringProp(props, "name") ?? id,
        goal,
        status,
        unmetDependencies: stringArrayProp(props, "unmet_dependencies"),
        version: numberProp(props, "version"),
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
  private inFlightTasks = new Set<string>();
  private unblockedSignatures = new Set<string>();
  private blockedTaskSignatures = new Set<string>();
  private lastIdleSignature: string | null = null;
  private lastBlockedSignature: string | null = null;

  constructor(
    private options: {
      hub: ConsumerHub;
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
    const plan = parsePlan(this.planTree);
    if (!plan.active) {
      this.emitIdle("no_active_plan", "Scheduler idle: no active orchestration plan.");
      return;
    }

    const tasks = parseTasks(this.tasksTree);
    const agents = parseAgents(this.agentsTree);
    const activeAgents = agents.filter((agent) => ACTIVE_AGENT_STATUSES.has(agent.status));
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
      candidates.slice(0, availableSlots).map((task) => this.scheduleAndSpawn(task)),
    );
  }

  private async scheduleAndSpawn(task: SchedulerTask): Promise<void> {
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

      const spawnResult = await this.options.hub.invoke(
        delegationProviderId,
        "/session",
        "spawn_agent",
        {
          name: task.name,
          goal: task.goal,
          task_id: task.id,
        },
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
    } catch (error) {
      this.blockTask(task, "invoke_failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.inFlightTasks.delete(task.id);
    }
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

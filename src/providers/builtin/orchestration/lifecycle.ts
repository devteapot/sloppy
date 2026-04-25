import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { debug } from "../../../core/debug";
import { buildAcceptanceCriteria, uniqueStrings } from "./classifiers";
import type { DriftCoordinator } from "./drift";
import type { GatesCoordinator } from "./gates";
import { normalizeReference } from "./normalization";
import type { OrchestrationRepository } from "./repository";
import { appendText, codedError } from "./storage";
import type {
  AcceptanceCriterion,
  CreateTaskParams,
  Plan,
  TaskDefinition,
  TaskDraft,
  TaskKind,
  TaskState,
  TaskStatus,
} from "./types";

export type UpdateResult =
  | { version: number; state: TaskState }
  | { error: "version_conflict"; currentVersion: number };

export type StateTransitionResult =
  | { version: number; status: TaskStatus }
  | { error: string; currentVersion: number };

export interface LifecycleDeps {
  repo: OrchestrationRepository;
  gates?: GatesCoordinator;
  drift?: DriftCoordinator;
  refresh: () => void;
}

export class TaskLifecycle {
  private readonly repo: OrchestrationRepository;
  private readonly gates: GatesCoordinator | undefined;
  private readonly drift: DriftCoordinator | undefined;
  private readonly refresh: () => void;

  constructor(deps: LifecycleDeps) {
    this.repo = deps.repo;
    this.gates = deps.gates;
    this.drift = deps.drift;
    this.refresh = deps.refresh;
  }

  // --- task creation -----------------------------------------------------

  private aliasesForNewTask(params: CreateTaskParams, ordinal: number): string[] {
    return uniqueStrings(
      [`task-${ordinal}`, `task ${ordinal}`, params.client_ref ?? ""]
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  private validateRetryOf(
    taskId: string,
    plan: Plan,
  ): { definition: TaskDefinition; state: TaskState } {
    const definition = this.repo.loadTaskDefinition(taskId);
    const state = this.repo.loadTaskState(taskId);
    if (!definition || !state || !this.repo.taskBelongsToPlan(definition, plan)) {
      throw codedError("invalid_retry", `retry_of must reference an existing task id: ${taskId}.`);
    }
    if (
      state.status !== "failed" &&
      state.status !== "cancelled" &&
      state.status !== "superseded"
    ) {
      throw codedError(
        "invalid_retry",
        `retry_of must reference a failed, cancelled, or superseded task; ${taskId} is ${state.status}.`,
      );
    }
    return { definition, state };
  }

  createTask(params: CreateTaskParams): {
    id: string;
    version: number;
    kind?: TaskKind;
    spec_refs?: string[];
    audit_of?: string;
    finding_refs?: string[];
    acceptance_criteria: AcceptanceCriterion[];
    depends_on: string[];
    retry_of?: string;
  } {
    const plan = this.repo.requireActivePlan();
    const retrySource = params.retry_of ? this.validateRetryOf(params.retry_of, plan) : undefined;
    const attemptCount = retrySource ? this.nextRetryAttemptCount(params.retry_of as string) : 0;
    this.assertRetryBudget({
      plan,
      retryOf: params.retry_of,
      attemptCount,
      retrySource,
    });
    const auditOf = this.repo.resolveOptionalTaskReference(params.audit_of, "audit_of");
    for (const findingId of params.finding_refs ?? []) {
      if (!this.repo.loadFinding(findingId)) {
        throw codedError(
          "invalid_finding_ref",
          `finding_refs contains unknown finding: ${findingId}.`,
        );
      }
    }
    const dependsOn = this.repo.resolveTaskDependencyReferences(
      params.depends_on ?? retrySource?.definition.depends_on ?? [],
    );
    const id = `task-${crypto.randomUUID().slice(0, 8)}`;
    const labels = this.repo.dependencyLabelsForPlan(plan);
    labels.set(id, params.name);
    this.repo.assertAcyclicDependencies(
      this.repo.dependencyGraphForPlan(plan, new Map([[id, dependsOn]])),
      labels,
    );
    const ordinal = this.repo.listTaskIdsForPlan(plan).length + 1;
    const acceptanceCriteria = retrySource?.definition.acceptance_criteria?.length
      ? retrySource.definition.acceptance_criteria
      : buildAcceptanceCriteria(params.goal, params.acceptance_criteria);
    const sourceDef = retrySource?.definition;
    const definition: TaskDefinition = {
      id,
      ...(plan.id ? { plan_id: plan.id } : {}),
      slice_id: id,
      plan_version: params.plan_version ?? sourceDef?.plan_version,
      plan_revision_id: params.plan_revision_id ?? sourceDef?.plan_revision_id,
      spec_version: params.spec_version ?? sourceDef?.spec_version,
      name: params.name,
      goal: params.goal,
      kind: params.kind,
      depends_on: dependsOn,
      spec_refs: params.spec_refs ?? sourceDef?.spec_refs,
      audit_of: auditOf,
      finding_refs: params.finding_refs,
      acceptance_criteria: acceptanceCriteria,
      aliases: this.aliasesForNewTask(params, ordinal),
      client_ref: params.client_ref,
      retry_of: params.retry_of,
      planner_assumptions: params.planner_assumptions ?? sourceDef?.planner_assumptions,
      structural_assumptions: params.structural_assumptions ?? sourceDef?.structural_assumptions,
      attempt_count: attemptCount,
      requires_slice_gate: params.requires_slice_gate ?? sourceDef?.requires_slice_gate,
      slice_gate_resolver: params.slice_gate_resolver ?? sourceDef?.slice_gate_resolver,
      created_at: new Date().toISOString(),
    };
    const state: TaskState = {
      status: "pending",
      updated_at: definition.created_at,
      iteration: 0,
    };
    const version = this.repo.bumpTaskVersion(id);
    this.repo.writeTaskDefinition(id, definition);
    this.repo.writeTaskState(id, { ...state, version });
    debug("orchestration", "create_task", {
      id,
      name: params.name,
      depends_on: definition.depends_on,
      aliases: definition.aliases,
      client_ref: definition.client_ref,
      acceptance_criteria: definition.acceptance_criteria?.length ?? 0,
      retry_of: definition.retry_of,
      kind: definition.kind,
      spec_refs: definition.spec_refs,
      audit_of: definition.audit_of,
      finding_refs: definition.finding_refs,
      version,
    });
    if (params.retry_of) {
      this.updateTaskState(
        params.retry_of,
        { status: "superseded", superseded_by: id, completed_at: new Date().toISOString() },
        undefined,
      );
    }
    this.refresh();
    return {
      id,
      version,
      kind: params.kind,
      spec_refs: params.spec_refs,
      audit_of: auditOf,
      finding_refs: params.finding_refs,
      acceptance_criteria: acceptanceCriteria,
      depends_on: dependsOn,
      retry_of: params.retry_of,
    };
  }

  private nextRetryAttemptCount(taskId: string): number {
    return this.repo.retryAttemptCount(taskId) + 1;
  }

  private assertRetryBudget(params: {
    plan: Plan;
    retryOf?: string;
    attemptCount: number;
    retrySource?: { definition: TaskDefinition; state: TaskState };
  }): void {
    if (!params.retryOf || !params.retrySource) {
      return;
    }
    const limit = params.plan.budget?.retries_per_slice;
    if (limit === undefined || params.attemptCount <= limit) {
      return;
    }

    const rootTaskId = this.repo.retryRootTaskId(params.retryOf);
    const planRef = params.plan.id ?? "plan";
    const gate = this.gates?.openGate({
      scope: params.plan.goal_id ? `goal:${params.plan.goal_id}` : "session",
      gate_type: "budget_exceeded",
      subject_ref: `plan:${planRef}:slice:${rootTaskId}:budget:retries_per_slice`,
      summary: `Slice ${rootTaskId} exceeded its retry budget (${params.attemptCount} > ${limit}).`,
      evidence_refs: [`plan:${planRef}`, `slice:${rootTaskId}`, `slice:${params.retryOf}`],
    });
    throw codedError(
      "retry_budget_exceeded",
      `Retry budget exceeded for slice ${rootTaskId}: ${params.attemptCount} retries requested, limit is ${limit}.${gate ? ` Gate ${gate.id} opened.` : ""}`,
    );
  }

  createTasks(params: { tasks: CreateTaskParams[] }): {
    created: Array<{
      id: string;
      name: string;
      kind?: TaskKind;
      client_ref?: string;
      spec_refs?: string[];
      audit_of?: string;
      finding_refs?: string[];
      depends_on: string[];
      acceptance_criteria: AcceptanceCriterion[];
      version: number;
    }>;
  } {
    if (params.tasks.length === 0) {
      throw codedError("invalid_tasks", "create_tasks requires at least one valid task.");
    }

    const plan = this.repo.requireActivePlan();
    const now = new Date().toISOString();
    const existingCount = this.repo.listTaskIdsForPlan(plan).length;
    const drafts: TaskDraft[] = params.tasks.map((task, index) => {
      const id = `task-${crypto.randomUUID().slice(0, 8)}`;
      return {
        ...task,
        id,
        aliases: this.aliasesForNewTask(task, existingCount + index + 1),
      };
    });

    const batchReferences = new Map<string, string>();
    for (const draft of drafts) {
      for (const candidate of [
        draft.id,
        draft.name,
        draft.client_ref,
        ...(draft.aliases ?? []),
      ].filter((candidate): candidate is string => typeof candidate === "string")) {
        batchReferences.set(normalizeReference(candidate), draft.id);
      }
    }

    const resolvedDependencies = new Map<string, string[]>();
    for (const draft of drafts) {
      const dependsOn = this.repo.resolveTaskDependencyReferences(
        draft.depends_on ?? [],
        batchReferences,
      );
      if (dependsOn.includes(draft.id)) {
        throw codedError("invalid_dependencies", `Task ${draft.name} cannot depend on itself.`);
      }
      resolvedDependencies.set(draft.id, dependsOn);
    }

    const labels = this.repo.dependencyLabelsForPlan(plan);
    for (const draft of drafts) {
      labels.set(draft.id, draft.name);
    }
    this.repo.assertAcyclicDependencies(
      this.repo.dependencyGraphForPlan(plan, resolvedDependencies),
      labels,
    );

    const created: Array<{
      id: string;
      name: string;
      kind?: TaskKind;
      client_ref?: string;
      spec_refs?: string[];
      audit_of?: string;
      finding_refs?: string[];
      depends_on: string[];
      acceptance_criteria: AcceptanceCriterion[];
      version: number;
    }> = [];

    for (const draft of drafts) {
      const dependsOn = resolvedDependencies.get(draft.id) ?? [];
      const auditOf = this.repo.resolveOptionalTaskReference(
        draft.audit_of,
        "audit_of",
        batchReferences,
      );
      for (const findingId of draft.finding_refs ?? []) {
        if (!this.repo.loadFinding(findingId)) {
          throw codedError(
            "invalid_finding_ref",
            `finding_refs contains unknown finding: ${findingId}.`,
          );
        }
      }
      const acceptanceCriteria = buildAcceptanceCriteria(draft.goal, draft.acceptance_criteria);
      const definition: TaskDefinition = {
        id: draft.id,
        ...(plan.id ? { plan_id: plan.id } : {}),
        slice_id: draft.id,
        plan_version: draft.plan_version,
        plan_revision_id: draft.plan_revision_id,
        spec_version: draft.spec_version,
        name: draft.name,
        goal: draft.goal,
        kind: draft.kind,
        depends_on: dependsOn,
        spec_refs: draft.spec_refs,
        audit_of: auditOf,
        finding_refs: draft.finding_refs,
        acceptance_criteria: acceptanceCriteria,
        aliases: draft.aliases,
        client_ref: draft.client_ref,
        planner_assumptions: draft.planner_assumptions,
        structural_assumptions: draft.structural_assumptions,
        attempt_count: 0,
        requires_slice_gate: draft.requires_slice_gate,
        slice_gate_resolver: draft.slice_gate_resolver,
        created_at: now,
      };
      const state: TaskState = {
        status: "pending",
        updated_at: now,
        iteration: 0,
      };
      const version = this.repo.bumpTaskVersion(draft.id);
      this.repo.writeTaskDefinition(draft.id, definition);
      this.repo.writeTaskState(draft.id, { ...state, version });
      created.push({
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        client_ref: draft.client_ref,
        spec_refs: draft.spec_refs,
        audit_of: auditOf,
        finding_refs: draft.finding_refs,
        depends_on: dependsOn,
        acceptance_criteria: acceptanceCriteria,
        version,
      });
    }

    debug("orchestration", "create_tasks", {
      count: created.length,
      ids: created.map((task) => task.id),
    });
    this.refresh();
    return { created };
  }

  // --- task state transitions -------------------------------------------

  updateTaskState(
    taskId: string,
    update: Partial<TaskState>,
    expectedVersion: number | undefined,
  ): UpdateResult {
    const state = this.repo.loadTaskState(taskId);
    if (!state) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const current = this.repo.taskVersion(taskId);
    if (expectedVersion !== undefined && expectedVersion !== current) {
      debug("orchestration", "task_version_conflict", {
        taskId,
        expected: expectedVersion,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }

    const version = this.repo.bumpTaskVersion(taskId);
    const next: TaskState = {
      ...state,
      ...update,
      updated_at: new Date().toISOString(),
      iteration: state.iteration + 1,
      version,
    };
    this.repo.writeTaskState(taskId, next as TaskState & { version: number });
    debug("orchestration", "update_task", {
      taskId,
      prev_status: state.status,
      next_status: next.status,
      version,
    });
    this.refresh();
    return { version, state: next };
  }

  private assertPlanNotHalted(planId: string | undefined): void {
    if (!planId || !this.drift) return;
    if (this.drift.hasOpenPlanHaltGate(planId)) {
      throw codedError(
        "plan_halted",
        `Plan ${planId} is halted by an open drift_escalation gate. Resolve the gate before dispatching new tasks.`,
      );
    }
  }

  isDependencySatisfied(taskId: string): boolean {
    const state = this.repo.loadTaskState(taskId);
    if (!state) return false;
    if (state.status === "completed") return true;
    if (state.status !== "superseded" || !state.superseded_by) return false;
    return this.repo.loadTaskState(state.superseded_by)?.status === "completed";
  }

  unmetDependencies(taskId: string): string[] {
    const def = this.repo.loadTaskDefinition(taskId);
    if (!def?.depends_on?.length) return [];
    const unmet: string[] = [];
    for (const depId of def.depends_on) {
      if (!this.isDependencySatisfied(depId)) {
        unmet.push(depId);
      }
    }
    return unmet;
  }

  startTask(params: { task_id: string; expected_version?: number }): StateTransitionResult {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "pending" && state.status !== "scheduled") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} can only start from pending or scheduled (current status: ${state.status}).`,
      );
    }
    const plan = this.repo.requireActivePlan();
    this.repo.assertPlanSpecFresh(plan);
    this.assertPlanNotHalted(plan.id);
    const unmet = this.unmetDependencies(params.task_id);
    if (unmet.length > 0) {
      throw new Error(
        `Cannot start task ${params.task_id}: unmet dependencies [${unmet.join(", ")}].`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "running" },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  scheduleTask(params: { task_id: string; expected_version?: number }): StateTransitionResult {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "pending") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} can only be scheduled from pending (current status: ${state.status}).`,
      );
    }
    const plan = this.repo.requireActivePlan();
    this.repo.assertPlanSpecFresh(plan);
    this.assertPlanNotHalted(plan.id);
    const unmet = this.unmetDependencies(params.task_id);
    if (unmet.length > 0) {
      throw new Error(
        `Cannot schedule task ${params.task_id}: unmet dependencies [${unmet.join(", ")}].`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      {
        status: "scheduled",
        message: "Scheduled for delegation.",
        scheduled_at: new Date().toISOString(),
      },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  failTask(params: {
    task_id: string;
    error: string;
    context_health?: "ok" | "degraded";
    expected_version?: number;
  }): StateTransitionResult {
    const driftResult = this.drift?.recordTaskFailure({
      task_id: params.task_id,
      error: params.error,
      context_health: params.context_health,
    });
    const update: Partial<TaskState> = {
      status: "failed",
      error: params.error,
      completed_at: new Date().toISOString(),
    };
    if (driftResult) {
      update.last_failure_class = driftResult.failure_class;
      update.last_failure_decision = driftResult.decision;
      update.consecutive_failure_count = driftResult.consecutive_failures;
    }
    const result = this.updateTaskState(params.task_id, update, params.expected_version);
    if ("error" in result) return result;
    // Plan-level drift evaluation runs after the state write so coherence metrics see
    // the current failure (cluster sizes, failure_count, etc.).
    this.drift?.evaluatePlanDrift();
    return { version: result.version, status: result.state.status };
  }

  cancelTask(params: { task_id: string; expected_version?: number }): StateTransitionResult {
    const result = this.updateTaskState(
      params.task_id,
      { status: "cancelled", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  appendProgress(params: { task_id: string; message: string }): {
    version: number;
    bytes: number;
  } {
    if (!this.repo.loadTaskState(params.task_id)) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    const timestamp = new Date().toISOString();
    appendText(
      join(this.repo.taskDir(params.task_id), "progress.md"),
      `- [${timestamp}] ${params.message}`,
    );
    const version = this.repo.taskVersion(params.task_id);
    this.refresh();
    return { version, bytes: params.message.length };
  }

  completeTask(params: {
    task_id: string;
    result: string;
    expected_version?: number;
    hasCompletionVerification: (taskId: string) => boolean;
    missingAcceptanceCriteria: (taskId: string) => string[];
    hasAcceptedSliceGate: (taskId: string) => boolean;
  }): StateTransitionResult {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} must be verifying before completion (current status: ${state.status}).`,
      );
    }
    if (!params.hasCompletionVerification(params.task_id)) {
      const missingCriteria = params.missingAcceptanceCriteria(params.task_id);
      const detail =
        missingCriteria.length > 0
          ? ` Missing acceptance criteria: ${missingCriteria.join(", ")}.`
          : "";
      throw codedError(
        "verification_required",
        `Task ${params.task_id} needs passed or not_required verification coverage before completion.${detail}`,
      );
    }
    if (!params.hasAcceptedSliceGate(params.task_id)) {
      throw codedError(
        "slice_gate_required",
        `Task ${params.task_id} needs an accepted slice_gate before completion.`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "completed", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    if (params.result.length > 0) {
      const resultPath = this.repo.resultPath(params.task_id);
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, params.result, "utf8");
    }
    return { version: result.version, status: result.state.status };
  }
}

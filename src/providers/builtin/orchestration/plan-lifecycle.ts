import { debug } from "../../../core/debug";
import { isOrchestratorSafeTerminalCommand } from "../../../core/policy/rules";
import { buildBudgetStatus, normalizePlanBudget } from "./budget";
import { terminalTaskStatus } from "./classifiers";
import type { GatesCoordinator } from "./gates";
import type { TaskLifecycle } from "./lifecycle";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type {
  AuditStatus,
  BudgetStatus,
  BudgetUsageRecord,
  BudgetUsageSource,
  DigestTriggerReason,
  EvidenceCheck,
  EvidenceClaim,
  FinalAuditFailureReason,
  FinalAuditRecord,
  GateResolver,
  Plan,
  PlanBudget,
  PlanRevision,
  PlanSliceInput,
} from "./types";

export interface PlanLifecycleDeps {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  gates: GatesCoordinator;
  sessionId: string;
  defaultPlanBudget?: PlanBudget;
  onDigestTrigger?: (triggerReason: DigestTriggerReason) => void;
  refresh: () => void;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeBudgetUsageSource(value: unknown): BudgetUsageSource {
  switch (value) {
    case "manual":
    case "delegation":
    case "external":
      return value;
    default:
      return "llm";
  }
}

export class PlanLifecycle {
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly gates: GatesCoordinator;
  private readonly sessionId: string;
  private readonly defaultPlanBudget: PlanBudget | undefined;
  private readonly onDigestTrigger: ((triggerReason: DigestTriggerReason) => void) | undefined;
  private readonly refresh: () => void;

  constructor(deps: PlanLifecycleDeps) {
    this.repo = deps.repo;
    this.lifecycle = deps.lifecycle;
    this.gates = deps.gates;
    this.sessionId = deps.sessionId;
    this.defaultPlanBudget = normalizePlanBudget(deps.defaultPlanBudget);
    this.onDigestTrigger = deps.onDigestTrigger;
    this.refresh = deps.refresh;
  }

  createPlan(params: {
    query: string;
    strategy?: string;
    max_agents?: number;
    goal_id?: string;
    goal_version?: number;
    spec_id?: string;
    spec_version?: number;
    planned_commit?: string;
    budget?: PlanBudget;
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
      goal_id: params.goal_id,
      goal_version: params.goal_version,
      spec_id: params.spec_id,
      spec_version: params.spec_version,
      planned_commit: params.planned_commit,
      gate_mode: params.spec_id || params.goal_id ? "hitl" : "legacy",
      budget: normalizePlanBudget(params.budget ?? this.defaultPlanBudget),
    };
    this.repo.assertPlanSpecFresh(plan);
    const version = this.repo.bumpPlanVersion();
    this.repo.writePlan({ ...plan, version });
    debug("orchestration", "create_plan", { session: this.sessionId, version });
    this.refresh();
    return { ...plan, version };
  }

  createPlanRevision(params: {
    query: string;
    strategy?: string;
    max_agents?: number;
    goal_id?: string;
    goal_version?: number;
    spec_id?: string;
    spec_version?: number;
    planned_commit?: string;
    planner_assumptions?: string[];
    structural_assumptions?: string[];
    slice_gate_resolver?: GateResolver;
    budget?: PlanBudget;
    slices: PlanSliceInput[];
  }): PlanRevision & { gate_id: string; version: number } {
    if (params.slices.length === 0) {
      throw codedError(
        "invalid_plan_revision",
        "create_plan_revision requires at least one slice.",
      );
    }
    if (params.spec_id && params.spec_version === undefined) {
      throw codedError(
        "invalid_plan_revision",
        "spec_version is required when spec_id is supplied.",
      );
    }
    if (params.spec_id && params.spec_version !== undefined) {
      const metadata = this.repo.loadSpecMetadata(params.spec_id);
      if (metadata === null || metadata.version !== params.spec_version) {
        throw codedError(
          "stale_spec_version",
          `Plan revision references spec ${params.spec_id} version ${params.spec_version}, but current version is ${metadata?.version ?? "unknown"}.`,
        );
      }
      if (metadata.status !== "accepted") {
        throw codedError(
          "spec_not_accepted",
          `Plan revision references spec ${params.spec_id} version ${params.spec_version}, but its status is ${metadata.status}, not accepted.`,
        );
      }
    }

    const existing = this.repo.loadPlan();
    const planId = existing?.id ?? `plan-${crypto.randomUUID().slice(0, 8)}`;
    const revisionId = `plan-rev-${crypto.randomUUID().slice(0, 8)}`;
    const revisionNumber =
      this.repo.listPlanRevisions().filter((revision) => revision.plan_id === planId).length + 1;
    const revision: PlanRevision = {
      id: revisionId,
      plan_id: planId,
      status: "proposed",
      revision_number: revisionNumber,
      goal_id: params.goal_id,
      goal_version: params.goal_version,
      spec_id: params.spec_id,
      spec_version: params.spec_version,
      planned_commit: params.planned_commit,
      query: params.query,
      strategy: params.strategy ?? "sequential",
      max_agents: params.max_agents ?? 5,
      planner_assumptions: params.planner_assumptions ?? [],
      structural_assumptions: params.structural_assumptions ?? [],
      slices: params.slices,
      slice_gate_resolver: params.slice_gate_resolver,
      budget: normalizePlanBudget(params.budget ?? existing?.budget ?? this.defaultPlanBudget),
      created_at: new Date().toISOString(),
    };
    const version = this.repo.bumpPlanRevisionVersion(revision.id);
    this.repo.writePlanRevision({ ...revision, version });
    const gate = this.gates.openGate({
      gate_type: "plan_accept",
      subject_ref: `plan_revision:${revisionId}`,
      summary: `Accept plan revision ${revisionNumber} for "${params.query}".`,
    });
    const latest = this.repo.loadPlanRevision(revision.id) ?? revision;
    const nextVersion = this.repo.bumpPlanRevisionVersion(revision.id);
    this.repo.writePlanRevision({ ...latest, gate_id: gate.id, version: nextVersion });
    this.refresh();
    return { ...latest, gate_id: gate.id, version: nextVersion };
  }

  recordBudgetUsage(params: {
    task_id?: string;
    source?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    evidence_refs?: string[];
  }): { usage: BudgetUsageRecord; budget: BudgetStatus } {
    const plan = this.repo.requireActivePlan();
    if (!plan.id) {
      throw codedError("no_active_plan", "Budget usage requires a plan id.");
    }

    if (params.task_id) {
      const definition = this.repo.loadTaskDefinition(params.task_id);
      if (!this.repo.taskBelongsToPlan(definition, plan)) {
        throw codedError(
          "invalid_task",
          `Budget usage task_id must belong to active plan ${plan.id}.`,
        );
      }
    }

    const inputTokens = normalizeNonNegativeInteger(params.input_tokens);
    const outputTokens = normalizeNonNegativeInteger(params.output_tokens);
    const totalTokens = normalizeNonNegativeInteger(
      params.total_tokens ?? inputTokens + outputTokens,
    );
    const costUsd = normalizeNonNegativeNumber(params.cost_usd);
    if (totalTokens === 0 && costUsd === undefined) {
      throw codedError(
        "invalid_budget_usage",
        "record_budget_usage requires positive token usage or a non-negative cost_usd value.",
      );
    }

    const usage: BudgetUsageRecord = {
      id: `budget-usage-${crypto.randomUUID().slice(0, 8)}`,
      plan_id: plan.id,
      task_id: params.task_id,
      source: normalizeBudgetUsageSource(params.source),
      model: normalizeOptionalString(params.model),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost_usd: costUsd,
      evidence_refs: params.evidence_refs ?? [],
      created_at: new Date().toISOString(),
    };
    this.repo.writeBudgetUsage(usage);
    const budget = this.ensureBudgetGates(
      plan,
      buildBudgetStatus(plan, {
        ...this.repo.retryBudgetUsageForPlan(plan),
        ...this.repo.tokenCostBudgetUsageForPlan(plan),
      }),
    );
    this.refresh();
    return { usage, budget };
  }

  raiseBudgetCap(params: {
    wall_time_ms?: number;
    retries_per_slice?: number;
    token_limit?: number;
    cost_usd?: number;
    resolve_gates?: boolean;
    resolution?: string;
    expected_version?: number;
  }):
    | {
        plan_id: string;
        budget: BudgetStatus;
        resolved_gate_ids: string[];
        version: number;
      }
    | { error: "version_conflict"; currentVersion: number } {
    const plan = this.repo.requireActivePlan();
    if (!plan.id) {
      throw codedError("no_active_plan", "Budget cap updates require a plan id.");
    }
    const currentVersion = this.repo.planVersion();
    if (params.expected_version !== undefined && params.expected_version !== currentVersion) {
      return { error: "version_conflict", currentVersion };
    }

    const currentBudget = normalizePlanBudget(plan.budget) ?? {};
    const requestedBudget = normalizePlanBudget({
      wall_time_ms: params.wall_time_ms,
      retries_per_slice: params.retries_per_slice,
      token_limit: params.token_limit,
      cost_usd: params.cost_usd,
    });
    if (!requestedBudget) {
      throw codedError(
        "invalid_budget_cap",
        "raise_budget_cap requires at least one positive budget cap.",
      );
    }

    const nextBudget: PlanBudget = { ...currentBudget };
    for (const key of Object.keys(requestedBudget) as Array<keyof PlanBudget>) {
      const requestedValue = requestedBudget[key];
      if (requestedValue === undefined) {
        continue;
      }
      const currentValue = currentBudget[key];
      if (currentValue !== undefined && requestedValue <= currentValue) {
        throw codedError(
          "budget_cap_not_raised",
          `Budget cap ${key} must increase from ${currentValue} to a larger value.`,
        );
      }
      nextBudget[key] = requestedValue;
    }

    const version = this.repo.bumpPlanVersion();
    const nextPlan: Plan = {
      ...plan,
      budget: normalizePlanBudget(nextBudget),
      version,
    };
    this.repo.writePlan(nextPlan as Plan & { version: number });

    const resolvedGateIds =
      params.resolve_gates === false
        ? []
        : this.resolveCoveredBudgetGates({
            plan: nextPlan,
            raisedLimits: Object.keys(requestedBudget) as Array<keyof PlanBudget>,
            resolution: params.resolution,
          });
    const budget = buildBudgetStatus(nextPlan, {
      ...this.repo.retryBudgetUsageForPlan(nextPlan),
      ...this.repo.tokenCostBudgetUsageForPlan(nextPlan),
    });
    this.refresh();
    return {
      plan_id: plan.id,
      budget,
      resolved_gate_ids: resolvedGateIds,
      version,
    };
  }

  acceptPlanRevision(params: { revision_id: string; gate_id?: string }): {
    plan_id: string;
    revision_id: string;
    task_ids: string[];
    version: number;
  } {
    const revision = this.repo.loadPlanRevision(params.revision_id);
    if (!revision) {
      throw new Error(`Unknown plan revision: ${params.revision_id}`);
    }
    if (revision.status === "accepted") {
      return {
        plan_id: revision.plan_id,
        revision_id: revision.id,
        task_ids: this.repo.listTaskIdsForPlan(this.repo.loadPlan()),
        version: this.repo.planVersion(),
      };
    }
    if (revision.status !== "proposed") {
      throw codedError(
        "invalid_plan_revision",
        `Plan revision ${revision.id} is ${revision.status}, not proposed.`,
      );
    }
    const gate =
      params.gate_id !== undefined
        ? this.repo.loadGate(params.gate_id)
        : this.repo.latestAcceptedGate("plan_accept", `plan_revision:${revision.id}`);
    if (
      !gate ||
      gate.status !== "accepted" ||
      gate.subject_ref !== `plan_revision:${revision.id}`
    ) {
      throw codedError(
        "plan_accept_gate_required",
        `Plan revision ${revision.id} needs an accepted plan_accept gate before activation.`,
      );
    }

    const plan: Plan = {
      id: revision.plan_id,
      session_id: this.sessionId,
      query: revision.query,
      strategy: revision.strategy,
      max_agents: revision.max_agents,
      created_at: new Date().toISOString(),
      status: "active",
      goal_id: revision.goal_id,
      goal_version: revision.goal_version,
      spec_id: revision.spec_id,
      spec_version: revision.spec_version,
      planned_commit: revision.planned_commit,
      active_revision_id: revision.id,
      gate_mode: "hitl",
      budget: revision.budget,
    };
    this.repo.assertPlanSpecFresh(plan);
    const planVersion = this.repo.bumpPlanVersion();
    this.repo.writePlan({ ...plan, version: planVersion });

    for (const taskId of this.repo.listTaskIdsForPlan(this.repo.loadPlan())) {
      const state = this.repo.loadTaskState(taskId);
      if (!state) continue;
      if (
        state.status === "completed" ||
        state.status === "cancelled" ||
        state.status === "superseded"
      ) {
        continue;
      }
      this.lifecycle.updateTaskState(
        taskId,
        {
          status: "superseded",
          message: `Superseded by plan revision ${revision.id}.`,
          completed_at: new Date().toISOString(),
        },
        undefined,
      );
    }

    const created = this.lifecycle.createTasks({
      tasks: revision.slices.map((slice) => ({
        ...slice,
        plan_version: planVersion,
        plan_revision_id: revision.id,
        spec_version: revision.spec_version,
        requires_slice_gate: true,
        slice_gate_resolver: slice.slice_gate_resolver ?? revision.slice_gate_resolver,
      })),
    }).created;

    const revisionVersion = this.repo.bumpPlanRevisionVersion(revision.id);
    this.repo.writePlanRevision({
      ...revision,
      status: "accepted",
      accepted_at: new Date().toISOString(),
      resolved_at: gate.resolved_at,
      resolution: gate.resolution,
      version: revisionVersion,
    });
    debug("orchestration", "accept_plan_revision", {
      revisionId: revision.id,
      planId: revision.plan_id,
      planVersion,
      taskCount: created.length,
    });
    this.refresh();
    return {
      plan_id: revision.plan_id,
      revision_id: revision.id,
      task_ids: created.map((task) => task.id),
      version: planVersion,
    };
  }

  acceptPlanRevisionFromGate(gateId: string): void {
    const gate = this.repo.loadGate(gateId);
    if (!gate || gate.applied_at || gate.gate_type !== "plan_accept") {
      return;
    }
    const match = /^plan_revision:(.+)$/.exec(gate.subject_ref);
    if (!match?.[1]) {
      return;
    }
    this.acceptPlanRevision({ revision_id: match[1], gate_id: gate.id });
    this.gates.markApplied(gate.id);
  }

  private ensureBudgetGates(plan: Plan, status: BudgetStatus): BudgetStatus {
    if (!plan.id || !status.exceeded) {
      return status;
    }

    let next = status;
    if (status.exceeded_limits.includes("token_limit")) {
      const gate = this.ensureBudgetGate({
        plan,
        subjectRef: `plan:${plan.id}:budget:token_limit`,
        summary: `Plan "${plan.query}" exceeded its token budget.`,
      });
      next = {
        ...next,
        token_gate_id: gate.id,
        gate_id: next.gate_id ?? gate.id,
      };
    }
    if (status.exceeded_limits.includes("cost_usd")) {
      const gate = this.ensureBudgetGate({
        plan,
        subjectRef: `plan:${plan.id}:budget:cost_usd`,
        summary: `Plan "${plan.query}" exceeded its cost budget.`,
      });
      next = {
        ...next,
        cost_gate_id: gate.id,
        gate_id: next.gate_id ?? gate.id,
      };
    }
    return next;
  }

  private ensureBudgetGate(params: { plan: Plan; subjectRef: string; summary: string }) {
    return (
      this.repo.findOpenGate("budget_exceeded", params.subjectRef) ??
      this.gates.openGate({
        scope: params.plan.goal_id ? `goal:${params.plan.goal_id}` : "session",
        gate_type: "budget_exceeded",
        subject_ref: params.subjectRef,
        summary: params.summary,
        evidence_refs: [`plan:${params.plan.id}`],
      })
    );
  }

  private resolveCoveredBudgetGates(params: {
    plan: Plan;
    raisedLimits: Array<keyof PlanBudget>;
    resolution?: string;
  }): string[] {
    if (!params.plan.id) {
      return [];
    }

    const subjects = new Set<string>();
    const budget = normalizePlanBudget(params.plan.budget) ?? {};
    const now = Date.now();
    const createdAt = Date.parse(params.plan.created_at);
    const elapsedWallTimeMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;
    const retryUsage = this.repo.retryBudgetUsageForPlan(params.plan);
    const tokenCostUsage = this.repo.tokenCostBudgetUsageForPlan(params.plan);

    if (
      params.raisedLimits.includes("wall_time_ms") &&
      budget.wall_time_ms !== undefined &&
      elapsedWallTimeMs <= budget.wall_time_ms
    ) {
      subjects.add(`plan:${params.plan.id}:budget:wall_time`);
    }
    if (
      params.raisedLimits.includes("retries_per_slice") &&
      budget.retries_per_slice !== undefined &&
      (retryUsage.retryAttemptsUsed ?? 0) <= budget.retries_per_slice
    ) {
      for (const gate of this.repo.listGates()) {
        if (
          gate.gate_type === "budget_exceeded" &&
          gate.status === "open" &&
          gate.subject_ref.startsWith(`plan:${params.plan.id}:`) &&
          gate.subject_ref.endsWith(":budget:retries_per_slice")
        ) {
          subjects.add(gate.subject_ref);
        }
      }
    }
    if (
      params.raisedLimits.includes("token_limit") &&
      budget.token_limit !== undefined &&
      (tokenCostUsage.tokensUsed ?? 0) <= budget.token_limit
    ) {
      subjects.add(`plan:${params.plan.id}:budget:token_limit`);
    }
    if (
      params.raisedLimits.includes("cost_usd") &&
      budget.cost_usd !== undefined &&
      (tokenCostUsage.costUsdUsed ?? 0) <= budget.cost_usd
    ) {
      subjects.add(`plan:${params.plan.id}:budget:cost_usd`);
    }

    const resolvedGateIds: string[] = [];
    for (const gate of this.repo.listGates()) {
      if (
        gate.gate_type !== "budget_exceeded" ||
        gate.status !== "open" ||
        !subjects.has(gate.subject_ref)
      ) {
        continue;
      }
      const resolved = this.gates.resolveGate({
        gate_id: gate.id,
        status: "accepted",
        resolution: params.resolution ?? "Budget cap raised.",
      });
      if (!("error" in resolved)) {
        resolvedGateIds.push(resolved.id);
      }
    }
    return resolvedGateIds;
  }

  async runFinalAudit(): Promise<FinalAuditRecord> {
    const plan = this.repo.requireActivePlan();
    const auditId = `audit-${crypto.randomUUID().slice(0, 8)}`;
    const replayedChecks: FinalAuditRecord["replayed_checks"] = [];
    for (const claim of this.repo.listEvidenceClaimsForPlan(plan)) {
      for (const check of claim.checks) {
        if (check.verification !== "replayable") continue;
        replayedChecks.push(await this.replayAuditCheck(auditId, claim, check));
      }
    }
    const failures = replayedChecks
      .filter((check) => check.status === "failed")
      .map((check) => this.auditFailureSummary(check));
    const audit: FinalAuditRecord = {
      id: auditId,
      plan_id: plan.id ?? "plan",
      plan_version: this.repo.planVersion(),
      status: failures.length === 0 ? "passed" : "failed",
      replayed_checks: replayedChecks,
      failures,
      created_at: new Date().toISOString(),
    };
    this.repo.writeAudit(audit);
    const version = this.repo.bumpPlanVersion();
    this.repo.writePlan({ ...plan, final_audit_id: audit.id, version });
    this.onDigestTrigger?.("goal_status_change");
    this.refresh();
    return audit;
  }

  private async replayAuditCheck(
    auditId: string,
    claim: EvidenceClaim,
    check: EvidenceCheck,
  ): Promise<FinalAuditRecord["replayed_checks"][number]> {
    if (!isOrchestratorSafeTerminalCommand(check.command)) {
      const outputRef = this.repo.writeBlob(
        this.auditBlobId(auditId, claim.id, check.id),
        `Command not replayed by final audit: unsupported_command\ncommand: ${check.command}\n`,
      );
      return {
        evidence_claim_id: claim.id,
        check_id: check.id,
        command: check.command,
        exit_code: check.exit_code,
        recorded_exit_code: check.exit_code,
        actual_exit_code: null,
        output_ref: outputRef,
        failure_reason: "unsupported_command",
        status: "failed",
      };
    }

    const startedAt = Date.now();
    try {
      const process = Bun.spawn({
        cmd: [Bun.env.SHELL ?? "/bin/sh", "-lc", check.command],
        cwd: this.repo.workspaceRoot,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: Bun.env,
      });
      const timeoutMs = this.repo.finalAuditCommandTimeoutMs;
      const outputPromise = Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
        .then(([stdout, stderr, exitCode]) => ({
          kind: "completed" as const,
          stdout,
          stderr,
          exitCode,
        }))
        .catch((error) => ({
          kind: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
      const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
        const timeout = setTimeout(() => {
          process.kill();
          resolve({ kind: "timeout" });
        }, timeoutMs);
        process.exited.finally(() => clearTimeout(timeout));
      });

      const result = await Promise.race([outputPromise, timeoutPromise]);
      const durationMs = Date.now() - startedAt;

      if (result.kind === "timeout") {
        const outputRef = this.repo.writeBlob(
          this.auditBlobId(auditId, claim.id, check.id),
          `Final audit command timed out after ${timeoutMs}ms.\ncommand: ${check.command}\n`,
        );
        return this.buildAuditReplay({
          claim,
          check,
          actualExitCode: null,
          durationMs,
          outputRef,
          failureReason: "timeout",
          status: "failed",
        });
      }

      if (result.kind === "error") {
        const outputRef = this.repo.writeBlob(
          this.auditBlobId(auditId, claim.id, check.id),
          `Final audit command failed before completion.\ncommand: ${check.command}\nerror: ${result.message}\n`,
        );
        return this.buildAuditReplay({
          claim,
          check,
          actualExitCode: null,
          durationMs,
          outputRef,
          failureReason: "spawn_error",
          status: "failed",
        });
      }

      const outputRef = this.repo.writeBlob(
        this.auditBlobId(auditId, claim.id, check.id),
        [
          `command: ${check.command}`,
          `exit_code: ${result.exitCode}`,
          `duration_ms: ${durationMs}`,
          "",
          "stdout:",
          result.stdout,
          "",
          "stderr:",
          result.stderr,
        ].join("\n"),
      );
      const status: AuditStatus = result.exitCode === 0 ? "passed" : "failed";
      return this.buildAuditReplay({
        claim,
        check,
        actualExitCode: result.exitCode,
        durationMs,
        outputRef,
        failureReason: status === "failed" ? "nonzero_exit" : undefined,
        status,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const outputRef = this.repo.writeBlob(
        this.auditBlobId(auditId, claim.id, check.id),
        `Final audit command failed to start.\ncommand: ${check.command}\nerror: ${message}\n`,
      );
      return this.buildAuditReplay({
        claim,
        check,
        actualExitCode: null,
        durationMs,
        outputRef,
        failureReason: "spawn_error",
        status: "failed",
      });
    }
  }

  private buildAuditReplay(params: {
    claim: EvidenceClaim;
    check: EvidenceCheck;
    actualExitCode: number | null;
    durationMs?: number;
    outputRef?: string;
    failureReason?: FinalAuditFailureReason;
    status: AuditStatus;
  }): FinalAuditRecord["replayed_checks"][number] {
    return {
      evidence_claim_id: params.claim.id,
      check_id: params.check.id,
      command: params.check.command,
      exit_code: params.check.exit_code,
      recorded_exit_code: params.check.exit_code,
      actual_exit_code: params.actualExitCode,
      duration_ms: params.durationMs,
      output_ref: params.outputRef,
      failure_reason: params.failureReason,
      status: params.status,
    };
  }

  private auditBlobId(auditId: string, claimId: string, checkId: string): string {
    return `${auditId}-${claimId}-${checkId}`;
  }

  private auditFailureSummary(check: FinalAuditRecord["replayed_checks"][number]): string {
    switch (check.failure_reason) {
      case "unsupported_command":
        return `${check.command} was not replayed because it is outside the verification allowlist.`;
      case "timeout":
        return `${check.command} timed out during final audit.`;
      case "spawn_error":
        return `${check.command} failed to start during final audit.`;
      default:
        return `${check.command} exited ${check.actual_exit_code ?? "unknown"}.`;
    }
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
      if (plan.gate_mode === "hitl") {
        const audit = this.repo.latestFinalAuditForPlan(plan);
        if (!audit || audit.status !== "passed") {
          throw codedError(
            "final_audit_required",
            "HITL plans require a passing final audit before completion.",
          );
        }
      }
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
    this.onDigestTrigger?.("final");
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

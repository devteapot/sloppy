import { buildBudgetStatus } from "./budget";
import { failureClass, uniqueStrings } from "./classifiers";
import type { GatesCoordinator } from "./gates";
import type { OrchestrationRepository } from "./repository";
import type {
  BudgetStatus,
  CriterionSatisfaction,
  DriftEvent,
  DriftEventKind,
  DriftSeverity,
  EvidenceCheck,
  EvidenceClaim,
  EvidenceObservation,
  FailureDecision,
  GuardrailPolicy,
  Plan,
  VerificationRecord,
} from "./types";

export interface DriftDeps {
  repo: OrchestrationRepository;
  gates: GatesCoordinator;
  guardrails?: GuardrailPolicy;
  refresh: () => void;
}

const DEFAULT_REPEATED_FAILURE_LIMIT = 3;
const DEFAULT_PROGRESS_STALL_LIMIT = 0;

export type ProgressDriftMetrics = {
  criteria_total: number;
  criteria_satisfied: number;
  criteria_unknown: number;
  prior_distance: number;
  current_distance: number;
  velocity: number;
  stall_limit?: number;
  non_improving_evaluations?: number;
  projected_budget_exhaustion?: boolean;
};

export type CoherenceDriftMetrics = {
  replan_count: number;
  spec_revision_count: number;
  question_density: number;
  failure_count: number;
  failure_class_clusters: Record<string, number>;
  largest_failure_cluster_class?: string;
  largest_failure_cluster_size: number;
  thresholds: {
    replan_rate_limit?: number;
    spec_revision_rate_limit?: number;
    question_density_limit?: number;
    failure_cluster_limit?: number;
  };
  breaches: string[];
};

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function decideFailureResponse(params: {
  consecutive_failures: number;
  limit: number;
  context_health?: "ok" | "degraded";
}): FailureDecision {
  if (params.consecutive_failures >= params.limit) {
    return "escalate";
  }
  if (params.context_health === "degraded") {
    return "respawn";
  }
  if (params.consecutive_failures <= 1) {
    return "reprompt";
  }
  return "respawn";
}

function uniqueById(events: DriftEvent[]): DriftEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) {
      return false;
    }
    seen.add(event.id);
    return true;
  });
}

export class DriftCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly gates: GatesCoordinator;
  private readonly guardrails: GuardrailPolicy | undefined;
  private readonly refresh: () => void;

  constructor(deps: DriftDeps) {
    this.repo = deps.repo;
    this.gates = deps.gates;
    this.guardrails = deps.guardrails;
    this.refresh = deps.refresh;
  }

  describe(): Record<string, unknown> {
    const events = this.repo.listDriftEvents();
    return {
      configured: this.guardrails !== undefined,
      event_count: events.length,
      open_event_count: events.filter((event) => event.status === "open").length,
      blocking_event_count: events.filter(
        (event) => event.status === "open" && event.severity === "blocking",
      ).length,
      blast_radius: this.guardrails?.blast_radius ?? {},
      repeated_failure_limit:
        positiveInteger(this.guardrails?.repeated_failure_limit) ?? DEFAULT_REPEATED_FAILURE_LIMIT,
      progress_stall_limit:
        positiveInteger(this.guardrails?.progress_stall_limit) ?? DEFAULT_PROGRESS_STALL_LIMIT,
      progress_projection_requires_budget:
        this.guardrails?.progress_projection_requires_budget ?? false,
      coherence_thresholds: this.coherenceThresholds(),
    };
  }

  acknowledgeEvent(params: {
    event_id: string;
    resolution?: string;
    expected_version?: number;
  }): DriftEvent | { error: "version_conflict"; currentVersion: number } {
    const event = this.repo.loadDriftEvent(params.event_id);
    if (!event) {
      throw new Error(`Unknown drift event: ${params.event_id}`);
    }
    const currentVersion = this.repo.driftEventVersion(params.event_id);
    if (params.expected_version !== undefined && params.expected_version !== currentVersion) {
      return { error: "version_conflict", currentVersion };
    }
    if (event.status !== "open") {
      return event;
    }
    const version = this.repo.bumpDriftEventVersion(event.id);
    const next: DriftEvent = {
      ...event,
      status: "acknowledged",
      resolved_at: new Date().toISOString(),
      resolution: params.resolution,
      version,
    };
    this.repo.writeDriftEvent(next as DriftEvent & { version: number });
    this.refresh();
    return next;
  }

  recordEvidenceClaim(params: { claim: EvidenceClaim; previousCoveredCriteria: string[] }): {
    events: DriftEvent[];
    gateIds: string[];
    blocksPolicySliceGate: boolean;
  } {
    const events: DriftEvent[] = [];
    const gateIds: string[] = [];
    const plan = this.repo.loadPlan();
    const planId = plan?.id;
    const sliceRef = `slice:${params.claim.slice_id}`;
    const evidenceRefs = this.evidenceRefsForClaim(params.claim);

    for (const action of params.claim.risk.irreversible_actions) {
      const subjectRef = `${sliceRef}:irreversible:${action}`;
      const gate = this.gates.openGate({
        scope: sliceRef,
        gate_type: "irreversible_action",
        resolver: "user",
        subject_ref: subjectRef,
        summary: `Slice ${params.claim.slice_id} declared irreversible action: ${action}.`,
        evidence_refs: evidenceRefs,
      });
      gateIds.push(gate.id);
      events.push(
        this.recordEvent({
          kind: "irreversible_action_declared",
          severity: "blocking",
          plan_id: planId,
          slice_id: params.claim.slice_id,
          subject_ref: subjectRef,
          summary: `Irreversible action requires a human gate: ${action}.`,
          evidence_refs: [`gate:${gate.id}`, ...evidenceRefs],
          gate_id: gate.id,
          metrics: { action },
        }),
      );
    }

    const blastRadius = this.blastRadiusViolation(params.claim);
    if (blastRadius) {
      const gate = this.gates.openGate({
        scope: sliceRef,
        gate_type: "drift_escalation",
        resolver: "user",
        subject_ref: `${sliceRef}:guardrail:blast_radius`,
        summary: blastRadius.summary,
        evidence_refs: evidenceRefs,
      });
      gateIds.push(gate.id);
      events.push(
        this.recordEvent({
          kind: "blast_radius_violation",
          severity: "blocking",
          plan_id: planId,
          slice_id: params.claim.slice_id,
          subject_ref: `${sliceRef}:guardrail:blast_radius`,
          summary: blastRadius.summary,
          evidence_refs: [`gate:${gate.id}`, ...evidenceRefs],
          gate_id: gate.id,
          metrics: blastRadius.metrics,
        }),
      );
    }

    const failedChecks = params.claim.checks.filter((check) => check.exit_code !== 0);
    if (failedChecks.length > 0 && params.previousCoveredCriteria.length > 0) {
      const gate = this.gates.openGate({
        scope: planId ? `plan:${planId}` : sliceRef,
        gate_type: "drift_escalation",
        resolver: "user",
        subject_ref: `${sliceRef}:drift:evidence_regression`,
        summary: `Slice ${params.claim.slice_id} submitted failing evidence after prior criterion coverage.`,
        evidence_refs: evidenceRefs,
      });
      gateIds.push(gate.id);
      events.push(
        this.recordEvent({
          kind: "evidence_regression",
          severity: "blocking",
          plan_id: planId,
          slice_id: params.claim.slice_id,
          subject_ref: `${sliceRef}:drift:evidence_regression`,
          summary: `Failing evidence regressed covered criteria for slice ${params.claim.slice_id}.`,
          evidence_refs: [
            `gate:${gate.id}`,
            ...failedChecks.map((check) => `check:${check.id}`),
            ...evidenceRefs,
          ],
          gate_id: gate.id,
          metrics: {
            failed_check_count: failedChecks.length,
            prior_covered_criteria: params.previousCoveredCriteria.length,
          },
        }),
      );
    }

    const coverageGap = this.coverageGapForClaim(params.claim);
    if (coverageGap) {
      const gate =
        coverageGap.severity === "blocking"
          ? this.gates.openGate({
              scope: sliceRef,
              gate_type: "drift_escalation",
              resolver: "user",
              subject_ref: `${sliceRef}:drift:coverage_gap`,
              summary: coverageGap.summary,
              evidence_refs: evidenceRefs,
            })
          : undefined;
      if (gate) gateIds.push(gate.id);
      events.push(
        this.recordEvent({
          kind: "coverage_gap",
          severity: coverageGap.severity,
          plan_id: planId,
          slice_id: params.claim.slice_id,
          subject_ref: `${sliceRef}:drift:coverage_gap`,
          summary: coverageGap.summary,
          evidence_refs: gate ? [`gate:${gate.id}`, ...evidenceRefs] : evidenceRefs,
          gate_id: gate?.id,
          metrics: coverageGap.metrics,
        }),
      );
    }

    const observedOnly = this.observedOnlyCoverageForClaim(params.claim);
    if (observedOnly.length > 0) {
      events.push(
        this.recordEvent({
          kind: "observed_only_coverage",
          severity: "warning",
          plan_id: planId,
          slice_id: params.claim.slice_id,
          subject_ref: `${sliceRef}:drift:observed_only_coverage`,
          summary: `Slice ${params.claim.slice_id} satisfies ${observedOnly.length} criterion${observedOnly.length === 1 ? "" : "s"} with observed-only evidence: ${observedOnly.join(", ")}.`,
          evidence_refs: evidenceRefs,
          metrics: { observed_only_criteria: observedOnly },
        }),
      );
    }

    const intentDrift = this.intentDriftForClaim(params.claim);
    if (intentDrift) {
      const gate =
        intentDrift.severity === "blocking"
          ? this.gates.openGate({
              scope: sliceRef,
              gate_type: "drift_escalation",
              resolver: "user",
              subject_ref: `${sliceRef}:drift:intent`,
              summary: intentDrift.summary,
              evidence_refs: evidenceRefs,
            })
          : undefined;
      if (gate) gateIds.push(gate.id);
      events.push(
        this.recordEvent({
          kind: "intent_drift",
          severity: intentDrift.severity,
          plan_id: planId,
          slice_id: params.claim.slice_id,
          subject_ref: `${sliceRef}:drift:intent`,
          summary: intentDrift.summary,
          evidence_refs: gate ? [`gate:${gate.id}`, ...evidenceRefs] : evidenceRefs,
          gate_id: gate?.id,
          metrics: intentDrift.metrics,
        }),
      );
    }

    events.push(...this.evaluatePlanDrift());

    return {
      events,
      gateIds: uniqueStrings(gateIds),
      blocksPolicySliceGate:
        gateIds.length > 0 ||
        events.some((event) => event.status === "open" && event.severity === "blocking"),
    };
  }

  recordTaskFailure(params: {
    task_id: string;
    error: string;
    context_health?: "ok" | "degraded";
  }): {
    decision: FailureDecision;
    failure_class: string;
    consecutive_failures: number;
    event?: DriftEvent;
  } {
    const plan = this.repo.loadPlan();
    const planId = plan?.id;
    const limit =
      positiveInteger(this.guardrails?.repeated_failure_limit) ?? DEFAULT_REPEATED_FAILURE_LIMIT;
    const rootTaskId = this.repo.retryRootTaskId(params.task_id);
    const klass = failureClass(params.error);
    // Count existing failures of this class for this logical slice; +1 includes the current
    // failure even though the caller may not have written its terminal state yet.
    const priorAttempts = this.failedLogicalAttempts(rootTaskId, klass, params.task_id);
    const attempts = priorAttempts + 1;
    const decision = decideFailureResponse({
      consecutive_failures: attempts,
      limit,
      context_health: params.context_health,
    });

    if (attempts < limit) {
      // Skip plan-level drift evaluation here — the caller writes state after this call,
      // so coherenceMetricsForPlan would miss the current failure. Caller is responsible
      // for invoking evaluatePlanDrift() after the state write.
      return { decision, failure_class: klass, consecutive_failures: attempts };
    }

    const subjectRef = `slice:${rootTaskId}:drift:repeated_failure:${klass}`;
    const gate = this.gates.openGate({
      scope: `slice:${rootTaskId}`,
      gate_type: "drift_escalation",
      resolver: "user",
      subject_ref: subjectRef,
      summary: `Slice ${rootTaskId} hit repeated ${klass} failures (${attempts}/${limit}).`,
      evidence_refs: [`slice:${rootTaskId}`, `slice:${params.task_id}`],
    });
    const event = this.recordEvent({
      kind: "repeated_failure",
      severity: "blocking",
      plan_id: planId,
      slice_id: rootTaskId,
      subject_ref: subjectRef,
      summary: `Repeated ${klass} failures require planner escalation for slice ${rootTaskId}.`,
      evidence_refs: [`gate:${gate.id}`, `slice:${rootTaskId}`, `slice:${params.task_id}`],
      gate_id: gate.id,
      metrics: {
        failure_class: klass,
        attempts,
        limit,
        decision,
      },
    });
    return { decision, failure_class: klass, consecutive_failures: attempts, event };
  }

  hasBlockingGuardrailForSlice(taskId: string): boolean {
    const prefix = `slice:${taskId}`;
    return this.repo
      .listDriftEvents()
      .some(
        (event) =>
          event.status === "open" &&
          event.severity === "blocking" &&
          (event.subject_ref === prefix || event.subject_ref.startsWith(`${prefix}:`)),
      );
  }

  evaluatePlanDrift(params: { nowMs?: number } = {}): DriftEvent[] {
    const plan = this.repo.loadPlan();
    if (!plan?.id) {
      return [];
    }
    const taskIds = this.repo.listTaskIdsForPlan(plan);
    const activeTaskIds = this.repo.listActiveRevisionTaskIds(plan);
    const events: DriftEvent[] = [];
    const progress = this.progressMetricsForPlan(plan, activeTaskIds, params.nowMs);
    const stallLimit = positiveInteger(this.guardrails?.progress_stall_limit);
    if (
      stallLimit !== undefined &&
      progress.current_distance > 0 &&
      (progress.non_improving_evaluations ?? 0) >= stallLimit
    ) {
      events.push(
        this.recordEvent({
          kind: "progress_drift",
          severity: "warning",
          plan_id: plan.id,
          subject_ref: `plan:${plan.id}:drift:progress:stall`,
          summary: `Criteria distance has not improved for ${progress.non_improving_evaluations}/${stallLimit} progress evaluation(s).`,
          evidence_refs: [`plan:${plan.id}`],
          metrics: progress,
        }),
      );
    }

    if (progress.projected_budget_exhaustion) {
      const subjectRef = `plan:${plan.id}:drift:progress:budget_projection`;
      const shouldBlock = this.guardrails?.progress_projection_requires_budget === true;
      const gate =
        shouldBlock && !this.repo.findOpenGate("drift_escalation", subjectRef)
          ? this.gates.openGate({
              scope: `plan:${plan.id}`,
              gate_type: "drift_escalation",
              resolver: "user",
              subject_ref: subjectRef,
              summary: "Remaining criteria are projected to exhaust the configured plan budget.",
              evidence_refs: [`plan:${plan.id}`],
            })
          : undefined;
      events.push(
        this.recordEvent({
          kind: "progress_drift",
          severity: shouldBlock ? "blocking" : "warning",
          plan_id: plan.id,
          subject_ref: subjectRef,
          summary: "Remaining criteria are projected to exhaust the configured plan budget.",
          evidence_refs: gate ? [`gate:${gate.id}`, `plan:${plan.id}`] : [`plan:${plan.id}`],
          gate_id: gate?.id,
          metrics: progress,
        }),
      );
    }

    const coherence = this.coherenceMetricsForPlan(plan, taskIds);
    if (coherence.breaches.length > 0) {
      // The cross-slice failure_cluster breach is the doc-12 "stuck" signal: many
      // distinct slices failing the same way means the planner mis-modeled something
      // structural. Open a plan-scoped drift_escalation gate so new task dispatch
      // halts until a human clears it. Other coherence breaches stay informational.
      const isStuck = coherence.breaches.includes("failure_cluster");
      const subjectRef = isStuck
        ? `plan:${plan.id}:drift:stuck`
        : `plan:${plan.id}:drift:coherence`;
      const gate =
        isStuck && !this.openStuckGateExists(plan.id, subjectRef)
          ? this.gates.openGate({
              scope: `plan:${plan.id}`,
              gate_type: "drift_escalation",
              resolver: "user",
              subject_ref: subjectRef,
              summary: `Plan ${plan.id} stuck: ${coherence.largest_failure_cluster_size} slices share failure class "${coherence.largest_failure_cluster_class}".`,
              evidence_refs: [`plan:${plan.id}`],
            })
          : undefined;
      events.push(
        this.recordEvent({
          kind: "coherence_drift",
          severity: isStuck ? "blocking" : "warning",
          plan_id: plan.id,
          subject_ref: subjectRef,
          summary: `Plan coherence thresholds breached: ${coherence.breaches.join(", ")}.`,
          evidence_refs: gate ? [`gate:${gate.id}`, `plan:${plan.id}`] : [`plan:${plan.id}`],
          gate_id: gate?.id,
          metrics: coherence,
        }),
      );
    }

    return uniqueById(events);
  }

  private openStuckGateExists(planId: string, subjectRef: string): boolean {
    return this.repo
      .listGates()
      .some(
        (gate) =>
          gate.status === "open" &&
          gate.gate_type === "drift_escalation" &&
          gate.subject_ref === subjectRef &&
          gate.scope === `plan:${planId}`,
      );
  }

  hasOpenPlanHaltGate(planId: string): boolean {
    return this.repo
      .listGates()
      .some(
        (gate) =>
          gate.status === "open" &&
          gate.gate_type === "drift_escalation" &&
          gate.scope === `plan:${planId}`,
      );
  }

  progressMetricsForPlan(
    plan: Plan | null = this.repo.loadPlan(),
    taskIds = this.repo.listActiveRevisionTaskIds(plan),
    nowMs = Date.now(),
  ): ProgressDriftMetrics {
    const criteriaTotal = taskIds.reduce(
      (count, taskId) =>
        count + (this.repo.loadTaskDefinition(taskId)?.acceptance_criteria?.length ?? 0),
      0,
    );
    const criteriaSatisfied = taskIds.reduce(
      (count, taskId) => count + this.coveredAcceptanceCriteria(taskId).length,
      0,
    );
    const currentDistance = Math.max(0, criteriaTotal - criteriaSatisfied);
    const priorDistance = this.priorProgressDistance(plan) ?? currentDistance;
    const stallLimit = positiveInteger(this.guardrails?.progress_stall_limit);
    const metrics: ProgressDriftMetrics = {
      criteria_total: criteriaTotal,
      criteria_satisfied: criteriaSatisfied,
      criteria_unknown: currentDistance,
      prior_distance: priorDistance,
      current_distance: currentDistance,
      velocity: priorDistance - currentDistance,
      stall_limit: stallLimit,
      non_improving_evaluations: this.nonImprovingProgressEvaluations(plan, currentDistance),
    };
    return {
      ...metrics,
      projected_budget_exhaustion: this.projectedBudgetExhaustion(plan, metrics, nowMs),
    };
  }

  coherenceMetricsForPlan(
    plan: Plan | null = this.repo.loadPlan(),
    taskIds = this.repo.listTaskIdsForPlan(plan),
  ): CoherenceDriftMetrics {
    const thresholds = this.coherenceThresholds();
    const replanCount = plan?.id
      ? Math.max(
          0,
          this.repo
            .listPlanRevisions()
            .filter((revision) => revision.plan_id === plan.id && revision.status === "accepted")
            .length - 1,
        )
      : 0;
    const specRevisionCount = Math.max(0, (plan?.spec_version ?? 0) - 1);
    const questionDensity = this.repo
      .listMessages()
      .filter((message) => message.kind === "SpecQuestion").length;
    const failureCount = taskIds.filter(
      (taskId) => this.repo.loadTaskState(taskId)?.status === "failed",
    ).length;

    // Failure clustering: count distinct logical slices (root task ids) per failure class.
    // Retries of the same root slice count once — they're the per-slice signal handled by
    // recordTaskFailure. Clustering is the cross-slice signal: many different slices
    // failing the same way means the planner mis-modeled something structural.
    const classToRoots = new Map<string, Set<string>>();
    for (const taskId of taskIds) {
      const state = this.repo.loadTaskState(taskId);
      if (!state || state.status !== "failed" || !state.error) continue;
      const klass = failureClass(state.error);
      const root = this.repo.retryRootTaskId(taskId);
      const set = classToRoots.get(klass) ?? new Set<string>();
      set.add(root);
      classToRoots.set(klass, set);
    }
    const failureClassClusters: Record<string, number> = {};
    let largestClusterClass: string | undefined;
    let largestClusterSize = 0;
    for (const [klass, roots] of classToRoots) {
      failureClassClusters[klass] = roots.size;
      if (roots.size > largestClusterSize) {
        largestClusterSize = roots.size;
        largestClusterClass = klass;
      }
    }

    const breaches: string[] = [];
    if (thresholds.replan_rate_limit !== undefined && replanCount > thresholds.replan_rate_limit) {
      breaches.push("replan_rate");
    }
    if (
      thresholds.spec_revision_rate_limit !== undefined &&
      specRevisionCount > thresholds.spec_revision_rate_limit
    ) {
      breaches.push("spec_revision_rate");
    }
    if (
      thresholds.question_density_limit !== undefined &&
      questionDensity > thresholds.question_density_limit
    ) {
      breaches.push("question_density");
    }
    if (
      thresholds.failure_cluster_limit !== undefined &&
      largestClusterSize >= thresholds.failure_cluster_limit
    ) {
      breaches.push("failure_cluster");
    }

    return {
      replan_count: replanCount,
      spec_revision_count: specRevisionCount,
      question_density: questionDensity,
      failure_count: failureCount,
      failure_class_clusters: failureClassClusters,
      largest_failure_cluster_class: largestClusterClass,
      largest_failure_cluster_size: largestClusterSize,
      thresholds,
      breaches,
    };
  }

  private coherenceThresholds(): CoherenceDriftMetrics["thresholds"] {
    const replanLimit = positiveInteger(this.guardrails?.coherence_replan_rate_limit);
    return {
      replan_rate_limit: replanLimit,
      spec_revision_rate_limit: replanLimit,
      question_density_limit: positiveInteger(this.guardrails?.coherence_question_density_limit),
      failure_cluster_limit:
        positiveInteger(this.guardrails?.repeated_failure_limit) ?? DEFAULT_REPEATED_FAILURE_LIMIT,
    };
  }

  private priorProgressDistance(plan: Plan | null): number | undefined {
    if (!plan) {
      return undefined;
    }
    const progress = this.repo.latestDigestForPlan(plan)?.sections.drift_dashboard.progress;
    if (!progress) {
      return undefined;
    }
    return typeof progress.current_distance === "number"
      ? progress.current_distance
      : progress.criteria_unknown;
  }

  private nonImprovingProgressEvaluations(plan: Plan | null, currentDistance: number): number {
    if (!plan) {
      return 0;
    }
    const distances = this.repo
      .listDigests()
      .filter((digest) => digest.plan_id === plan.id)
      .map((digest) => digest.sections.drift_dashboard.progress)
      .map((progress) =>
        typeof progress.current_distance === "number"
          ? progress.current_distance
          : progress.criteria_unknown,
      );
    if (distances.length === 0) {
      return 0;
    }
    const series = [...distances, currentDistance];
    let count = 0;
    for (let index = series.length - 1; index > 0; index -= 1) {
      if (series[index] < series[index - 1]) {
        break;
      }
      count += 1;
    }
    return count;
  }

  private projectedBudgetExhaustion(
    plan: Plan | null,
    metrics: ProgressDriftMetrics,
    nowMs: number,
  ): boolean {
    if (!plan || metrics.current_distance === 0) {
      return false;
    }
    const budget = buildBudgetStatus(plan, {
      nowMs,
      ...this.repo.retryBudgetUsageForPlan(plan),
      ...this.repo.tokenCostBudgetUsageForPlan(plan),
    });
    if (this.guardrails?.progress_projection_requires_budget && !budget.configured) {
      return false;
    }
    if (!budget.configured) {
      return false;
    }
    if (budget.exceeded) {
      return true;
    }
    return (
      this.projectedWallTimeExhaustion(plan, metrics, budget, nowMs) ||
      this.projectedTokenExhaustion(metrics, budget) ||
      this.projectedCostExhaustion(metrics, budget)
    );
  }

  private projectedWallTimeExhaustion(
    plan: Plan,
    metrics: ProgressDriftMetrics,
    budget: BudgetStatus,
    nowMs: number,
  ): boolean {
    if (budget.remaining_wall_time_ms === undefined) {
      return false;
    }
    const previous = this.repo.latestDigestForPlan(plan);
    if (!previous) {
      return false;
    }
    if (metrics.velocity <= 0) {
      return true;
    }
    const previousAt = Date.parse(previous.created_at);
    if (!Number.isFinite(previousAt)) {
      return false;
    }
    const elapsedSincePrevious = Math.max(1, nowMs - previousAt);
    const projectedMs = (metrics.current_distance / metrics.velocity) * elapsedSincePrevious;
    return projectedMs > budget.remaining_wall_time_ms;
  }

  private projectedTokenExhaustion(metrics: ProgressDriftMetrics, budget: BudgetStatus): boolean {
    if (
      budget.tokens_remaining === undefined ||
      budget.tokens_used === undefined ||
      metrics.criteria_satisfied === 0
    ) {
      return false;
    }
    const tokensPerCriterion = budget.tokens_used / metrics.criteria_satisfied;
    return tokensPerCriterion * metrics.current_distance > budget.tokens_remaining;
  }

  private projectedCostExhaustion(metrics: ProgressDriftMetrics, budget: BudgetStatus): boolean {
    if (
      budget.cost_usd_remaining === undefined ||
      budget.cost_usd_used === undefined ||
      metrics.criteria_satisfied === 0
    ) {
      return false;
    }
    const costPerCriterion = budget.cost_usd_used / metrics.criteria_satisfied;
    return costPerCriterion * metrics.current_distance > budget.cost_usd_remaining;
  }

  private recordEvent(params: {
    kind: DriftEventKind;
    severity: DriftSeverity;
    plan_id?: string;
    slice_id?: string;
    subject_ref: string;
    summary: string;
    evidence_refs?: string[];
    metrics?: Record<string, unknown>;
    gate_id?: string;
  }): DriftEvent {
    const existing = this.repo.findOpenDriftEvent(params.kind, params.subject_ref);
    if (existing) {
      return existing;
    }

    const event: DriftEvent = {
      id: `drift-${crypto.randomUUID().slice(0, 8)}`,
      kind: params.kind,
      severity: params.severity,
      status: "open",
      plan_id: params.plan_id,
      slice_id: params.slice_id,
      subject_ref: params.subject_ref,
      summary: params.summary,
      evidence_refs: params.evidence_refs ?? [],
      metrics: params.metrics,
      gate_id: params.gate_id,
      created_at: new Date().toISOString(),
    };
    const version = this.repo.bumpDriftEventVersion(event.id);
    this.repo.writeDriftEvent({ ...event, version });
    return { ...event, version };
  }

  private evidenceRefsForClaim(claim: EvidenceClaim): string[] {
    return uniqueStrings([
      `evidence:${claim.id}`,
      ...claim.checks.map((check) => `check:${check.id}`),
      ...claim.observations.map((observation) => `observation:${observation.id}`),
    ]);
  }

  private coveredAcceptanceCriteria(taskId: string): string[] {
    const covered = new Set<string>();
    for (const verification of this.repo.loadVerifications(taskId)) {
      if (this.verificationCoversCriteria(verification)) {
        for (const criterionId of verification.criteria ?? []) {
          covered.add(criterionId);
        }
      }
    }
    for (const claim of this.repo.listEvidenceClaims(taskId)) {
      for (const criterion of this.validCriterionSatisfaction(claim)) {
        covered.add(criterion.criterion_id);
      }
    }
    return [...covered].sort();
  }

  private verificationCoversCriteria(verification: VerificationRecord): boolean {
    return verification.status === "passed" || verification.status === "not_required";
  }

  private validCriterionSatisfaction(claim: EvidenceClaim): CriterionSatisfaction[] {
    const evidenceItems = new Map<string, EvidenceCheck | EvidenceObservation>();
    for (const check of claim.checks) evidenceItems.set(check.id, check);
    for (const observation of claim.observations) evidenceItems.set(observation.id, observation);
    return claim.criterion_satisfaction.filter((satisfaction) =>
      satisfaction.evidence_refs.some((ref) => {
        const item = evidenceItems.get(ref);
        return item?.verification === "replayable" || item?.verification === "observed";
      }),
    );
  }

  private observedOnlyCoverageForClaim(claim: EvidenceClaim): string[] {
    const priorReplayableCriteria = new Set<string>();
    for (const prior of this.repo.listEvidenceClaims(claim.slice_id)) {
      if (prior.id === claim.id) continue;
      const priorItems = new Map<
        string,
        { verification: "replayable" | "observed" | "self_attested" }
      >();
      for (const check of prior.checks) priorItems.set(check.id, check);
      for (const observation of prior.observations) priorItems.set(observation.id, observation);
      for (const satisfaction of prior.criterion_satisfaction) {
        const replayableSupport = satisfaction.evidence_refs.some(
          (ref) => priorItems.get(ref)?.verification === "replayable",
        );
        if (replayableSupport) {
          priorReplayableCriteria.add(satisfaction.criterion_id);
        }
      }
    }

    const evidenceItems = new Map<
      string,
      { verification: "replayable" | "observed" | "self_attested" }
    >();
    for (const check of claim.checks) evidenceItems.set(check.id, check);
    for (const observation of claim.observations) evidenceItems.set(observation.id, observation);

    const perCriterion = new Map<string, { replayable: boolean; observed: boolean }>();
    for (const satisfaction of claim.criterion_satisfaction) {
      const aggregate = perCriterion.get(satisfaction.criterion_id) ?? {
        replayable: false,
        observed: false,
      };
      for (const ref of satisfaction.evidence_refs) {
        const item = evidenceItems.get(ref);
        if (item?.verification === "replayable") aggregate.replayable = true;
        else if (item?.verification === "observed") aggregate.observed = true;
      }
      perCriterion.set(satisfaction.criterion_id, aggregate);
    }

    const observedOnly: string[] = [];
    for (const [criterionId, support] of perCriterion) {
      if (priorReplayableCriteria.has(criterionId)) continue;
      if (!support.replayable && support.observed) {
        observedOnly.push(criterionId);
      }
    }
    return uniqueStrings(observedOnly);
  }

  private coverageGapForClaim(
    claim: EvidenceClaim,
  ): { severity: DriftSeverity; summary: string; metrics: Record<string, unknown> } | undefined {
    const changed =
      claim.risk.files_modified.length > 0 ||
      claim.risk.deps_added.length > 0 ||
      claim.risk.public_surface_delta !== undefined;
    if (!changed) {
      return undefined;
    }

    const knownCriteria = new Set(
      this.repo.loadAcceptanceCriteria(claim.slice_id).map((criterion) => criterion.id),
    );
    const satisfiedCriteria = uniqueStrings(
      claim.criterion_satisfaction.map((satisfaction) => satisfaction.criterion_id),
    );
    const unknownCriteria = satisfiedCriteria.filter(
      (criterionId) => !knownCriteria.has(criterionId),
    );
    const coveredKnownCriteria = satisfiedCriteria.filter((criterionId) =>
      knownCriteria.has(criterionId),
    );
    const metrics = {
      files_modified: claim.risk.files_modified.length,
      deps_added: claim.risk.deps_added.length,
      public_surface_delta: claim.risk.public_surface_delta,
      criterion_satisfaction_count: claim.criterion_satisfaction.length,
      known_criteria_count: knownCriteria.size,
      covered_known_criteria_count: coveredKnownCriteria.length,
      unknown_criteria: unknownCriteria,
    };

    if (unknownCriteria.length > 0) {
      return {
        severity: "blocking",
        summary: `Slice ${claim.slice_id} claimed coverage for criteria outside the accepted slice: ${unknownCriteria.join(", ")}.`,
        metrics,
      };
    }

    if (coveredKnownCriteria.length > 0) {
      return undefined;
    }

    const severity: DriftSeverity =
      claim.risk.deps_added.length > 0 || claim.risk.public_surface_delta !== undefined
        ? "blocking"
        : "warning";
    return {
      severity,
      summary:
        severity === "blocking"
          ? `Slice ${claim.slice_id} changed dependencies or public surface without accepted criterion coverage.`
          : `Slice ${claim.slice_id} changed scoped artifacts without criterion coverage.`,
      metrics,
    };
  }

  private intentDriftForClaim(
    claim: EvidenceClaim,
  ): { severity: DriftSeverity; summary: string; metrics: Record<string, unknown> } | undefined {
    const definition = this.repo.loadTaskDefinition(claim.slice_id);
    const sliceSpecRefs = definition?.spec_refs ?? [];
    const readSpecRefs = claim.provenance.spec_sections_read;
    const hasSpecTrace = sliceSpecRefs.length > 0 || readSpecRefs.length > 0;
    const highRiskChange =
      claim.risk.deps_added.length > 0 || claim.risk.public_surface_delta !== undefined;
    const changed = highRiskChange || claim.risk.files_modified.length > 0;

    if (!changed) {
      return undefined;
    }

    if (!hasSpecTrace) {
      const metrics = {
        files_modified: claim.risk.files_modified.length,
        deps_added: claim.risk.deps_added.length,
        public_surface_delta: claim.risk.public_surface_delta,
        criterion_satisfaction_count: claim.criterion_satisfaction.length,
        slice_spec_refs: sliceSpecRefs,
        spec_sections_read: readSpecRefs,
      };
      if (highRiskChange) {
        return {
          severity: "blocking",
          summary: `Slice ${claim.slice_id} changed dependencies or public surface without slice/spec traceability.`,
          metrics,
        };
      }
      return {
        severity: "warning",
        summary: `Slice ${claim.slice_id} modified files without slice/spec traceability.`,
        metrics,
      };
    }

    // Abstraction emergence: spec trace exists, but the executor modified files outside
    // anything the planner declared as in-scope and outside what the executor recorded
    // having inspected. Heuristic-only — soft warning.
    const abstractionFiles = this.abstractionEmergenceFiles(claim, definition);
    if (abstractionFiles.length > 0) {
      return {
        severity: "warning",
        summary: `Slice ${claim.slice_id} introduced files outside structural assumptions: ${abstractionFiles.slice(0, 5).join(", ")}.`,
        metrics: {
          abstraction_files: abstractionFiles,
          structural_assumptions: definition?.structural_assumptions ?? [],
          files_inspected: claim.provenance.files_inspected.map((entry) => entry.path),
          slice_spec_refs: sliceSpecRefs,
        },
      };
    }

    return undefined;
  }

  private abstractionEmergenceFiles(
    claim: EvidenceClaim,
    definition: ReturnType<OrchestrationRepository["loadTaskDefinition"]>,
  ): string[] {
    const assumptions = definition?.structural_assumptions ?? [];
    if (assumptions.length === 0) {
      // Without structural assumptions, every modification is "outside scope" by default
      // — too noisy. Skip until the planner authors them.
      return [];
    }
    const inspected = new Set(claim.provenance.files_inspected.map((entry) => entry.path));
    // Extract path-like tokens from the free-form structural_assumptions text. Trailing
    // slashes are normalized so `src/parser/` and `src/parser` both match the same paths.
    const tokens = new Set<string>();
    for (const assumption of assumptions) {
      for (const match of assumption.toLowerCase().matchAll(/[A-Za-z0-9_./-]+/g)) {
        const token = match[0].replace(/\/+$/, "");
        if (token.length > 0) tokens.add(token);
      }
    }
    const emerged: string[] = [];
    for (const file of claim.risk.files_modified) {
      if (inspected.has(file)) continue;
      const lower = file.toLowerCase();
      const covered = [...tokens].some(
        (token) =>
          token === lower || lower.startsWith(`${token}/`) || token.startsWith(`${lower}/`),
      );
      if (!covered) {
        emerged.push(file);
      }
    }
    return emerged;
  }

  private blastRadiusViolation(
    claim: EvidenceClaim,
  ): { summary: string; metrics: Record<string, unknown> } | undefined {
    const policy = this.guardrails?.blast_radius;
    if (!policy) {
      return undefined;
    }
    const maxFiles = nonNegativeInteger(policy.max_files_modified);
    const maxDeps = nonNegativeInteger(policy.max_deps_added);
    const maxExternalCalls = nonNegativeInteger(policy.max_external_calls);
    const externalCalls = claim.risk.external_calls ?? [];
    const violations: string[] = [];
    if (maxFiles !== undefined && claim.risk.files_modified.length > maxFiles) {
      violations.push(`files modified ${claim.risk.files_modified.length} > ${maxFiles}`);
    }
    if (maxDeps !== undefined && claim.risk.deps_added.length > maxDeps) {
      violations.push(`deps added ${claim.risk.deps_added.length} > ${maxDeps}`);
    }
    if (maxExternalCalls !== undefined && externalCalls.length > maxExternalCalls) {
      violations.push(`external calls ${externalCalls.length} > ${maxExternalCalls}`);
    }
    if (policy.public_surface_delta_requires_gate && claim.risk.public_surface_delta) {
      violations.push("public surface delta declared");
    }
    if (violations.length === 0) {
      return undefined;
    }

    return {
      summary: `Slice ${claim.slice_id} exceeded blast-radius guardrails: ${violations.join(", ")}.`,
      metrics: {
        files_modified: claim.risk.files_modified.length,
        max_files_modified: maxFiles,
        deps_added: claim.risk.deps_added.length,
        max_deps_added: maxDeps,
        external_calls: externalCalls.length,
        max_external_calls: maxExternalCalls,
        public_surface_delta: claim.risk.public_surface_delta,
      },
    };
  }

  private failedLogicalAttempts(rootTaskId: string, klass: string, excludeTaskId?: string): number {
    const plan = this.repo.loadPlan();
    return this.repo.listTaskIdsForPlan(plan).filter((taskId) => {
      if (taskId === excludeTaskId) return false;
      const state = this.repo.loadTaskState(taskId);
      if (!state || (state.status !== "failed" && state.status !== "superseded")) {
        return false;
      }
      if (!state.error) {
        return false;
      }
      if (this.repo.retryRootTaskId(taskId) !== rootTaskId) {
        return false;
      }
      return failureClass(state.error ?? "") === klass;
    }).length;
  }
}

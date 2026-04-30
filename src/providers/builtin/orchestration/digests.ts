import { buildBudgetStatus } from "./budget";
import type { DriftCoordinator } from "./drift";
import type { GatesCoordinator } from "./gates";
import type { OrchestrationRepository } from "./repository";
import type {
  AuditStatus,
  BudgetStatus,
  DigestAction,
  DigestCadence,
  DigestCadenceSource,
  DigestDelivery,
  DigestDeliveryReason,
  DigestDeliveryTransport,
  DigestDeliveryTransportResult,
  DigestGoalStatus,
  DigestPolicy,
  DigestRecord,
  DigestTriggerReason,
  EvidenceCheck,
  EvidenceClaim,
  EvidenceObservation,
  Gate,
  Plan,
  PlanBudget,
  ProtocolMessage,
  TaskState,
  VerificationRecord,
} from "./types";

function normalizeDeliveryChannel(channel: string | undefined): string {
  const normalized = channel?.trim();
  return normalized && normalized.length > 0 ? normalized : "orchestration";
}

export interface DigestDeps {
  repo: OrchestrationRepository;
  gates: GatesCoordinator;
  drift?: DriftCoordinator;
  sessionId: string;
  policy?: DigestPolicy;
  deliveryChannel?: string;
  deliveryTransports?: DigestDeliveryTransport[];
  refresh: () => void;
}

export class DigestCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly gates: GatesCoordinator;
  private readonly drift: DriftCoordinator | undefined;
  private readonly sessionId: string;
  private readonly policy: DigestPolicy;
  private readonly deliveryChannel: string;
  private readonly deliveryTransports = new Map<string, DigestDeliveryTransport>();
  private readonly refresh: () => void;
  private activeGenerationCount = 0;

  constructor(deps: DigestDeps) {
    this.repo = deps.repo;
    this.gates = deps.gates;
    this.drift = deps.drift;
    this.sessionId = deps.sessionId;
    this.policy = { cadence: deps.policy?.cadence ?? "manual" };
    this.deliveryChannel = normalizeDeliveryChannel(deps.deliveryChannel);
    for (const transport of deps.deliveryTransports ?? []) {
      const channel = normalizeDeliveryChannel(transport.channel);
      this.deliveryTransports.set(channel, { ...transport, channel });
    }
    this.refresh = deps.refresh;
  }

  describeDelivery(): {
    default_channel: string;
    configured_transport_channels: string[];
  } {
    return {
      default_channel: this.deliveryChannel,
      configured_transport_channels: [...this.deliveryTransports.keys()].sort(),
    };
  }

  describePolicy(): DigestPolicy {
    return this.policy;
  }

  maybeGenerateTriggeredDigest(params: {
    trigger_reason: DigestTriggerReason;
  }): DigestRecord | null {
    if (this.activeGenerationCount > 0) {
      return null;
    }
    const cadence = this.policy.cadence ?? "manual";
    if (!this.shouldGenerateForTrigger(cadence, params.trigger_reason)) {
      return null;
    }
    return this.generateDigest({
      cadence: params.trigger_reason === "final" ? "final" : cadence,
      trigger_reason: params.trigger_reason,
      cadence_source: params.trigger_reason === "final" ? "trigger" : "policy",
    });
  }

  generateDigest(
    params: {
      cadence?: DigestCadence;
      trigger_reason?: DigestTriggerReason;
      cadence_source?: DigestCadenceSource;
    } = {},
  ): DigestRecord {
    this.activeGenerationCount += 1;
    try {
      return this.generateDigestInner(params);
    } finally {
      this.activeGenerationCount -= 1;
    }
  }

  private generateDigestInner(
    params: {
      cadence?: DigestCadence;
      trigger_reason?: DigestTriggerReason;
      cadence_source?: DigestCadenceSource;
    },
  ): DigestRecord {
    const plan = this.repo.loadPlan();
    const createdAt = new Date().toISOString();
    this.drift?.evaluatePlanDrift({ nowMs: Date.parse(createdAt) });
    const budget = this.ensureBudgetGate(
      plan,
      buildBudgetStatus(plan, {
        nowMs: Date.parse(createdAt),
        ...this.repo.retryBudgetUsageForPlan(plan),
        ...this.repo.tokenCostBudgetUsageForPlan(plan),
      }),
    );
    const previous = plan
      ? this.repo.latestDigestForPlan(plan)
      : (this.repo.listDigests().at(-1) ?? null);
    const previousAt = previous?.created_at;
    const taskIds = plan ? this.repo.listActiveRevisionTaskIds(plan) : [];
    const taskStates = taskIds
      .map((id) => ({ id, state: this.repo.loadTaskState(id) }))
      .filter((entry): entry is { id: string; state: TaskState } => entry.state !== null);
    const allActiveRevisionTaskStates = (
      plan
        ? this.repo.listTaskIdsForPlan(plan).filter(
            (id) =>
              !plan.active_revision_id ||
              this.repo.loadTaskDefinition(id)?.plan_revision_id === plan.active_revision_id,
          )
        : []
    )
      .map((id) => ({ id, state: this.repo.loadTaskState(id) }))
      .filter((entry): entry is { id: string; state: TaskState } => entry.state !== null);
    const gates = this.repo.listGates();
    const planRevisions = plan
      ? this.repo.listPlanRevisions().filter((revision) => revision.plan_id === plan.id)
      : this.repo.listPlanRevisions();
    const messages = this.repo.listMessages();
    const audits = plan
      ? this.repo.listAudits().filter((audit) => audit.plan_id === plan.id)
      : this.repo.listAudits();
    const budgetUsage = this.repo.listBudgetUsageForPlan(plan);
    const driftEvents = this.repo.listDriftEventsForPlan(plan);
    const latestAudit = audits.at(-1);
    const drift = this.buildDriftDashboard(plan, taskIds, taskStates);
    const sliceCounts = this.countSlices(taskStates);
    const userEscalations = gates.filter(
      (gate) =>
        gate.resolver === "user" &&
        (gate.status === "open" ||
          this.after(gate.created_at, previousAt) ||
          this.after(gate.resolved_at, previousAt)),
    );
    const autoResolvedGates = gates.filter(
      (gate) =>
        gate.resolved_by === "policy" &&
        (this.after(gate.created_at, previousAt) || this.after(gate.resolved_at, previousAt)),
    );
    const autoResolvedMessages = messages.filter(
      (message) =>
        message.resolution?.decided_by === "policy" &&
        message.resolution.policy_ref !== undefined &&
        (this.after(message.created_at, previousAt) ||
          this.after(message.resolution.resolved_at, previousAt)),
    );
    const failedTasks = taskStates.filter((entry) => entry.state.status === "failed");
    const failedAudits = audits.filter(
      (audit) => audit.status === "failed" && this.after(audit.created_at, previousAt),
    );
    const rejectedGates = gates.filter(
      (gate) => gate.status === "rejected" && this.after(gate.resolved_at, previousAt),
    );
    const status = this.digestStatus({
      plan,
      openGateCount: gates.filter((gate) => gate.status === "open" && gate.resolver === "user")
        .length,
      failedTaskCount: failedTasks.length,
      latestAuditStatus: latestAudit?.status ?? "none",
      budgetExceeded: budget.exceeded,
    });
    const readySlices = this.readySlices(taskStates);
    const runningSlices = taskStates
      .filter((entry) => entry.state.status === "running" || entry.state.status === "verifying")
      .map((entry) => this.sliceLabel(entry.id))
      .slice(0, 10);
    const digestId = `digest-${crypto.randomUUID().slice(0, 8)}`;
    const sourceRefs = this.sourceRefs({
      plan,
      taskIds,
      gateIds: [
        ...userEscalations.map((gate) => gate.id),
        ...autoResolvedGates.map((gate) => gate.id),
        ...rejectedGates.map((gate) => gate.id),
      ],
      messageIds: autoResolvedMessages.map((message) => message.id),
      precedentIds: autoResolvedMessages
        .map((message) => message.resolution?.precedent_id)
        .filter((id): id is string => id !== undefined),
      budgetUsageIds: budgetUsage.map((record) => record.id),
      driftEventIds: driftEvents.map((event) => event.id),
      auditIds: audits.map((audit) => audit.id),
      previousDigestId: previous?.id,
    });
    const actions = this.digestActions({
      plan,
      budget,
      userEscalations,
      autoResolvedMessages,
      sliceCounts,
      latestAuditStatus: latestAudit?.status ?? "none",
    });
    const cadence = params.cadence ?? "manual";
    const triggerReason = params.trigger_reason ?? "manual";
    const pushReasons = this.pushDeliveryReasons({
      cadence,
      triggerReason,
      status,
      previousStatus: previous?.status,
      userEscalationCount: userEscalations.length,
    });
    const deliveryId =
      pushReasons.length > 0 ? `digest-delivery-${crypto.randomUUID().slice(0, 8)}` : undefined;

    const digest: DigestRecord = {
      id: digestId,
      cadence,
      trigger_reason: triggerReason,
      cadence_source: params.cadence_source ?? "manual",
      status,
      session_id: this.sessionId,
      plan_id: plan?.id,
      plan_version: plan ? this.repo.planVersion() : undefined,
      goal_id: plan?.goal_id,
      goal_version: plan?.goal_version,
      spec_id: plan?.spec_id,
      spec_version: plan?.spec_version,
      previous_digest_id: previous?.id,
      headline: this.headline({
        plan,
        status,
        sliceCounts,
        drift,
        openGateCount: gates.filter((gate) => gate.status === "open").length,
        latestAuditStatus: latestAudit?.status ?? "none",
      }),
      sections: {
        what_changed: {
          slices: sliceCounts,
          plan_revisions: {
            total: planRevisions.length,
            proposed: planRevisions.filter((revision) => revision.status === "proposed").length,
            accepted: planRevisions.filter((revision) => revision.status === "accepted").length,
            rejected: planRevisions.filter((revision) => revision.status === "rejected").length,
            superseded: planRevisions.filter((revision) => revision.status === "superseded").length,
          },
          audits: {
            total: audits.length,
            passed: audits.filter((audit) => audit.status === "passed").length,
            failed: audits.filter((audit) => audit.status === "failed").length,
            latest_status: latestAudit?.status ?? "none",
          },
          protocol_messages: {
            total: messages.length,
            open: messages.filter((message) => message.status === "open").length,
          },
        },
        escalations: userEscalations.map((gate) => ({
          gate_id: gate.id,
          gate_type: gate.gate_type,
          status: gate.status,
          subject_ref: gate.subject_ref,
          summary: gate.summary,
          evidence_refs: gate.evidence_refs,
          created_at: gate.created_at,
          resolved_at: gate.resolved_at,
        })),
        auto_resolutions: {
          count: autoResolvedGates.length + autoResolvedMessages.length,
          high_confidence_count:
            autoResolvedGates.length +
            autoResolvedMessages.filter(
              (message) =>
                message.resolution?.match_score === undefined ||
                message.resolution.match_score >= 0.9,
            ).length,
          entries: [
            ...autoResolvedGates.map((gate) => ({
              gate_id: gate.id,
              gate_type: gate.gate_type,
              subject_ref: gate.subject_ref,
              policy_ref: gate.resolution_policy_ref,
              evidence_refs: gate.resolution_evidence_refs ?? gate.evidence_refs,
              resolved_at: gate.resolved_at,
            })),
            ...autoResolvedMessages.map((message) => ({
              message_id: message.id,
              message_kind: message.kind,
              subject_ref: `message:${message.id}`,
              policy_ref: message.resolution?.policy_ref,
              precedent_id: message.resolution?.precedent_id,
              match_score: message.resolution?.match_score,
              match_band: message.resolution?.match_band,
              match_score_source: message.resolution?.match_score_source,
              evidence_refs: message.resolution?.evidence_refs ?? [],
              resolved_at: message.resolution?.resolved_at,
            })),
          ],
        },
        near_misses: [
          ...failedTasks.map((entry) => ({
            kind: "failed_slice" as const,
            ref: `slice:${entry.id}`,
            summary: entry.state.error ?? `Slice ${entry.id} failed.`,
            created_at: entry.state.updated_at,
          })),
          ...this.succeededAfterRetry(allActiveRevisionTaskStates).map((entry) => ({
            kind: "succeeded_after_retry" as const,
            ref: `slice:${entry.retry_id}`,
            summary: `Slice ${entry.original_id} failed and was completed by retry ${entry.retry_id}.`,
            created_at: entry.completed_at,
          })),
          ...this.borderlinePrecedentMatches(autoResolvedMessages).map((entry) => ({
            kind: "borderline_precedent_match" as const,
            ref: `message:${entry.message_id}`,
            summary: `Borderline precedent ${entry.precedent_id} (score ${entry.match_score}) auto-resolved a SpecQuestion.`,
            created_at: entry.resolved_at,
          })),
          ...failedAudits.map((audit) => ({
            kind: "failed_audit" as const,
            ref: `audit:${audit.id}`,
            summary: audit.failures.at(0) ?? "Final audit failed.",
            created_at: audit.created_at,
          })),
          ...rejectedGates.map((gate) => ({
            kind: "rejected_gate" as const,
            ref: `gate:${gate.id}`,
            summary: gate.summary,
            created_at: gate.resolved_at,
          })),
          ...this.repo
            .listDriftEventsForPlan(plan)
            .filter(
              (event) =>
                event.kind === "observed_only_coverage" &&
                this.after(event.created_at, previousAt),
            )
            .map((event) => ({
              kind: "observed_only_coverage" as const,
              ref: `drift:${event.id}`,
              summary: event.summary,
              created_at: event.created_at,
            })),
        ],
        ...(previous
          ? {
              trends: this.computeTrends({
                previous,
                drift,
                sliceCounts,
                openGateCount: gates.filter((gate) => gate.status === "open").length,
              }),
            }
          : {}),
        drift_dashboard: drift,
        budget: {
          configured: budget.configured,
          exceeded: budget.exceeded,
          exceeded_limits: budget.exceeded_limits,
          wall_time_ms: budget.wall_time_ms,
          elapsed_wall_time_ms: budget.elapsed_wall_time_ms,
          remaining_wall_time_ms: budget.remaining_wall_time_ms,
          retries_per_slice: budget.retries_per_slice,
          retry_attempts_used: budget.retry_attempts_used,
          retry_over_budget_slice_count: budget.retry_over_budget_slice_count,
          retry_gate_id: budget.retry_gate_id,
          token_limit: budget.token_limit,
          input_tokens_used: budget.input_tokens_used,
          output_tokens_used: budget.output_tokens_used,
          tokens_used: budget.tokens_used,
          tokens_remaining: budget.tokens_remaining,
          token_gate_id: budget.token_gate_id,
          cost_usd: budget.cost_usd,
          cost_usd_used: budget.cost_usd_used,
          cost_usd_remaining: budget.cost_usd_remaining,
          cost_gate_id: budget.cost_gate_id,
          gate_id: budget.gate_id,
          message: budget.message,
        },
        whats_next: {
          pending_gate_count: gates.filter((gate) => gate.status === "open").length,
          next_ready_slices: readySlices,
          running_slices: runningSlices,
          final_audit_status: latestAudit?.status ?? "none",
        },
      },
      actions,
      delivery: {
        pull_ref: `/digests/${digestId}`,
        push_required: pushReasons.length > 0,
        push_reasons: pushReasons,
        delivery_id: deliveryId,
      },
      source_refs: sourceRefs,
      created_at: createdAt,
    };

    if (deliveryId) {
      this.writeDigestDelivery({
        id: deliveryId,
        digest,
        reasons: pushReasons,
        sourceRefs,
        createdAt,
      });
    }
    this.repo.writeDigest(digest);
    this.refresh();
    return digest;
  }

  markDeliveryDelivered(params: {
    delivery_id: string;
    expected_version?: number;
  }): DigestDelivery | { error: "version_conflict"; currentVersion: number } {
    const delivery = this.repo.loadDigestDelivery(params.delivery_id);
    if (!delivery) {
      throw new Error(`Unknown digest delivery: ${params.delivery_id}`);
    }
    const currentVersion = this.repo.digestDeliveryVersion(params.delivery_id);
    if (params.expected_version !== undefined && params.expected_version !== currentVersion) {
      return { error: "version_conflict", currentVersion };
    }
    if (delivery.status !== "pending") {
      return delivery;
    }
    const version = this.repo.bumpDigestDeliveryVersion(delivery.id);
    const next: DigestDelivery = {
      ...delivery,
      status: "delivered",
      last_error: undefined,
      delivered_by: delivery.delivered_by ?? "manual",
      delivered_at: new Date().toISOString(),
      version,
    };
    this.repo.writeDigestDelivery(next as DigestDelivery & { version: number });
    this.refresh();
    return next;
  }

  async deliverPendingDigests(params: { channel?: string; limit?: number } = {}): Promise<{
    attempted: number;
    delivered: number;
    failed: number;
    results: Array<{
      delivery_id: string;
      digest_id: string;
      channel: string;
      status: DigestDelivery["status"];
      external_ref?: string;
      error?: string;
    }>;
  }> {
    const channel = params.channel ? normalizeDeliveryChannel(params.channel) : undefined;
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(0, Math.floor(params.limit))
        : Number.POSITIVE_INFINITY;
    const deliveries = this.repo
      .listDigestDeliveries()
      .filter((delivery) => delivery.status === "pending")
      .filter((delivery) => channel === undefined || delivery.channel === channel)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, limit);
    const results: Array<{
      delivery_id: string;
      digest_id: string;
      channel: string;
      status: DigestDelivery["status"];
      external_ref?: string;
      error?: string;
    }> = [];

    for (const delivery of deliveries) {
      const digest = this.repo.loadDigest(delivery.digest_id);
      if (!digest) {
        const failed = this.recordDeliveryAttempt({
          delivery,
          result: {
            ok: false,
            error: `Digest ${delivery.digest_id} no longer exists.`,
          },
        });
        results.push({
          delivery_id: failed.id,
          digest_id: failed.digest_id,
          channel: failed.channel,
          status: failed.status,
          error: failed.last_error,
        });
        continue;
      }

      const transport = this.deliveryTransports.get(delivery.channel);
      if (!transport) {
        const failed = this.recordDeliveryAttempt({
          delivery,
          result: {
            ok: false,
            error: `No digest delivery transport configured for channel "${delivery.channel}".`,
          },
        });
        results.push({
          delivery_id: failed.id,
          digest_id: failed.digest_id,
          channel: failed.channel,
          status: failed.status,
          error: failed.last_error,
        });
        continue;
      }

      let result: DigestDeliveryTransportResult;
      try {
        result = await transport.deliver({ delivery, digest });
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const updated = this.recordDeliveryAttempt({ delivery, result });
      results.push({
        delivery_id: updated.id,
        digest_id: updated.digest_id,
        channel: updated.channel,
        status: updated.status,
        external_ref: updated.external_ref,
        error: updated.last_error,
      });
    }

    if (results.length > 0) {
      this.refresh();
    }

    return {
      attempted: results.length,
      delivered: results.filter((result) => result.status === "delivered").length,
      failed: results.filter((result) => result.status !== "delivered").length,
      results,
    };
  }

  private writeDigestDelivery(params: {
    id: string;
    digest: DigestRecord;
    reasons: DigestDeliveryReason[];
    sourceRefs: string[];
    createdAt: string;
  }): void {
    const delivery: DigestDelivery = {
      id: params.id,
      digest_id: params.digest.id,
      plan_id: params.digest.plan_id,
      goal_id: params.digest.goal_id,
      mode: "push",
      channel: this.deliveryChannel,
      reasons: params.reasons,
      status: "pending",
      source_refs: [`digest:${params.digest.id}`, ...params.sourceRefs],
      created_at: params.createdAt,
      attempt_count: 0,
    };
    const version = this.repo.bumpDigestDeliveryVersion(delivery.id);
    this.repo.writeDigestDelivery({ ...delivery, version });
  }

  private recordDeliveryAttempt(params: {
    delivery: DigestDelivery;
    result: DigestDeliveryTransportResult;
  }): DigestDelivery {
    const attemptedAt = new Date().toISOString();
    const version = this.repo.bumpDigestDeliveryVersion(params.delivery.id);
    const attemptCount = (params.delivery.attempt_count ?? 0) + 1;
    const next: DigestDelivery = params.result.ok
      ? {
          ...params.delivery,
          status: "delivered",
          attempt_count: attemptCount,
          last_attempt_at: attemptedAt,
          last_error: undefined,
          delivered_by: `transport:${params.delivery.channel}`,
          delivered_at: attemptedAt,
          external_ref: params.result.external_ref,
          version,
        }
      : {
          ...params.delivery,
          status: "pending",
          attempt_count: attemptCount,
          last_attempt_at: attemptedAt,
          last_error: params.result.error,
          version,
        };
    this.repo.writeDigestDelivery(next as DigestDelivery & { version: number });
    return next;
  }

  private digestActions(params: {
    plan: Plan | null;
    budget: BudgetStatus;
    userEscalations: Gate[];
    autoResolvedMessages: ProtocolMessage[];
    sliceCounts: DigestRecord["sections"]["what_changed"]["slices"];
    latestAuditStatus: AuditStatus | "none";
  }): DigestAction[] {
    const actions: DigestAction[] = [];
    for (const gate of params.userEscalations.filter((candidate) => candidate.status === "open")) {
      actions.push({
        id: `action-${gate.id}-accept`,
        kind: "accept_gate",
        label: `Accept ${gate.gate_type}`,
        target_ref: `gate:${gate.id}`,
        action_path: `/gates/${gate.id}`,
        action_name: "resolve_gate",
        params: { status: "accepted" },
        source_refs: [`gate:${gate.id}`],
        urgency: "high",
      });
      actions.push({
        id: `action-${gate.id}-reject`,
        kind: "reject_gate",
        label: `Reject ${gate.gate_type}`,
        target_ref: `gate:${gate.id}`,
        action_path: `/gates/${gate.id}`,
        action_name: "resolve_gate",
        params: { status: "rejected" },
        source_refs: [`gate:${gate.id}`],
        urgency: "high",
      });
    }

    const precedentIds = new Set(
      params.autoResolvedMessages
        .map((message) => message.resolution?.precedent_id)
        .filter((id): id is string => id !== undefined),
    );
    for (const precedentId of precedentIds) {
      actions.push({
        id: `action-${precedentId}-contradict`,
        kind: "contradict_precedent",
        label: "Contradict precedent",
        target_ref: `precedent:${precedentId}`,
        action_path: `/precedents/${precedentId}`,
        action_name: "contradict_precedent",
        params: {},
        source_refs: [`precedent:${precedentId}`],
        urgency: "normal",
      });
    }

    const budgetRaise = this.suggestedBudgetRaise(params.budget);
    if (params.plan?.id && budgetRaise) {
      actions.push({
        id: `action-${params.plan.id}-raise-budget`,
        kind: "raise_budget",
        label: "Raise budget cap",
        target_ref: `plan:${params.plan.id}`,
        action_path: "/budget",
        action_name: "raise_budget_cap",
        params: {
          ...budgetRaise,
          resolve_gates: true,
          resolution: "Budget cap raised from digest action.",
        },
        source_refs: [`plan:${params.plan.id}`, ...this.budgetGateRefs(params.budget)],
        urgency: "high",
      });
    }

    if (
      params.plan?.gate_mode === "hitl" &&
      params.plan.status === "active" &&
      params.sliceCounts.total > 0 &&
      params.sliceCounts.completed === params.sliceCounts.total &&
      params.latestAuditStatus !== "passed"
    ) {
      actions.push({
        id: `action-${params.plan.id ?? "plan"}-run-final-audit`,
        kind: "run_final_audit",
        label: "Run final audit",
        target_ref: `plan:${params.plan.id ?? "plan"}`,
        action_path: "/audit",
        action_name: "run_final_audit",
        params: {},
        source_refs: params.plan.id ? [`plan:${params.plan.id}`] : [],
        urgency: "high",
      });
    }

    if (params.plan?.status === "active") {
      actions.push({
        id: `action-${params.plan.id ?? "plan"}-cancel`,
        kind: "cancel_plan",
        label: "Cancel plan",
        target_ref: `plan:${params.plan.id ?? "plan"}`,
        action_path: "/orchestration",
        action_name: "complete_plan",
        params: { status: "cancelled" },
        source_refs: params.plan.id ? [`plan:${params.plan.id}`] : [],
        urgency: "low",
      });
    }

    return actions;
  }

  private suggestedBudgetRaise(budget: BudgetStatus): PlanBudget | null {
    if (!budget.configured || !budget.exceeded) {
      return null;
    }

    const raised: PlanBudget = {};
    if (budget.exceeded_limits.includes("wall_time_ms") && budget.wall_time_ms !== undefined) {
      const elapsed = Math.max(
        budget.elapsed_wall_time_ms ?? budget.wall_time_ms,
        budget.wall_time_ms,
      );
      raised.wall_time_ms = Math.max(budget.wall_time_ms + 1, Math.ceil(elapsed * 1.25));
    }
    if (
      budget.exceeded_limits.includes("retries_per_slice") &&
      budget.retries_per_slice !== undefined
    ) {
      raised.retries_per_slice = Math.max(
        budget.retries_per_slice + 1,
        (budget.retry_attempts_used ?? 0) + 1,
      );
    }
    if (budget.exceeded_limits.includes("token_limit") && budget.token_limit !== undefined) {
      const tokensUsed = Math.max(budget.tokens_used ?? 0, budget.token_limit);
      raised.token_limit = Math.max(budget.token_limit + 1, Math.ceil(tokensUsed * 1.25));
    }
    if (budget.exceeded_limits.includes("cost_usd") && budget.cost_usd !== undefined) {
      const costUsed = Math.max(budget.cost_usd_used ?? 0, budget.cost_usd);
      raised.cost_usd = Math.max(
        Number((budget.cost_usd + 0.01).toFixed(4)),
        Number((costUsed * 1.25).toFixed(4)),
      );
    }

    return Object.keys(raised).length > 0 ? raised : null;
  }

  private budgetGateRefs(budget: BudgetStatus): string[] {
    return [budget.gate_id, budget.retry_gate_id, budget.token_gate_id, budget.cost_gate_id]
      .filter((id): id is string => id !== undefined)
      .map((id) => `gate:${id}`);
  }

  private pushDeliveryReasons(params: {
    cadence: DigestCadence;
    triggerReason?: DigestTriggerReason;
    status: DigestGoalStatus;
    previousStatus?: DigestGoalStatus;
    userEscalationCount: number;
  }): DigestDeliveryReason[] {
    const reasons = new Set<DigestDeliveryReason>();
    if (params.cadence === "final" || params.triggerReason === "final") {
      reasons.add("final");
    }
    if (params.userEscalationCount > 0 || params.triggerReason === "escalation") {
      reasons.add("escalation");
    }
    if (
      params.triggerReason === "goal_status_change" ||
      (params.previousStatus !== undefined && params.previousStatus !== params.status)
    ) {
      reasons.add("goal_status_change");
    }
    return [...reasons];
  }

  private shouldGenerateForTrigger(
    cadence: DigestCadence,
    triggerReason: DigestTriggerReason,
  ): boolean {
    if (triggerReason === "final") {
      return true;
    }
    switch (cadence) {
      case "continuous":
        return triggerReason === "escalation" || triggerReason === "goal_status_change";
      case "on_escalation":
        return triggerReason === "escalation";
      case "on_milestone":
        return triggerReason === "goal_status_change";
      case "daily":
      case "manual":
      case "final":
        return false;
    }
  }

  private countSlices(
    taskStates: Array<{ state: TaskState }>,
  ): DigestRecord["sections"]["what_changed"]["slices"] {
    const counts = {
      total: taskStates.length,
      pending: 0,
      scheduled: 0,
      running: 0,
      verifying: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      superseded: 0,
    };
    for (const { state } of taskStates) {
      counts[state.status] += 1;
    }
    return counts;
  }

  private ensureBudgetGate(plan: Plan | null, status: BudgetStatus): BudgetStatus {
    if (!plan?.id || !status.exceeded) {
      return status;
    }

    let next = status;
    if (status.exceeded_limits.includes("wall_time_ms")) {
      const gate = this.ensureBudgetLimitGate({
        plan,
        subjectRef: `plan:${plan.id}:budget:wall_time`,
        summary: `Plan "${plan.query}" exceeded its wall-time budget.`,
      });
      next = { ...next, gate_id: next.gate_id ?? gate.id };
    }
    if (status.exceeded_limits.includes("token_limit")) {
      const gate = this.ensureBudgetLimitGate({
        plan,
        subjectRef: `plan:${plan.id}:budget:token_limit`,
        summary: `Plan "${plan.query}" exceeded its token budget.`,
      });
      next = { ...next, token_gate_id: gate.id, gate_id: next.gate_id ?? gate.id };
    }
    if (status.exceeded_limits.includes("cost_usd")) {
      const gate = this.ensureBudgetLimitGate({
        plan,
        subjectRef: `plan:${plan.id}:budget:cost_usd`,
        summary: `Plan "${plan.query}" exceeded its cost budget.`,
      });
      next = { ...next, cost_gate_id: gate.id, gate_id: next.gate_id ?? gate.id };
    }

    return next;
  }

  private ensureBudgetLimitGate(params: { plan: Plan; subjectRef: string; summary: string }) {
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

  private buildDriftDashboard(
    plan: Plan | null,
    taskIds: string[],
    taskStates: Array<{ state: TaskState }>,
  ): DigestRecord["sections"]["drift_dashboard"] {
    const fallbackCriteriaTotal = taskIds.reduce(
      (count, taskId) =>
        count + (this.repo.loadTaskDefinition(taskId)?.acceptance_criteria?.length ?? 0),
      0,
    );
    const fallbackCriteriaSatisfied = taskIds.reduce(
      (count, taskId) => count + this.coveredAcceptanceCriteria(taskId).length,
      0,
    );
    const fallbackCriteriaUnknown = Math.max(0, fallbackCriteriaTotal - fallbackCriteriaSatisfied);
    const progress = this.drift?.progressMetricsForPlan(plan, taskIds) ?? {
      criteria_total: fallbackCriteriaTotal,
      criteria_satisfied: fallbackCriteriaSatisfied,
      criteria_unknown: fallbackCriteriaUnknown,
      prior_distance: fallbackCriteriaUnknown,
      current_distance: fallbackCriteriaUnknown,
      velocity: 0,
    };
    const normalizedProgress = {
      ...progress,
      criteria_unknown:
        progress.criteria_unknown ??
        Math.max(0, progress.criteria_total - progress.criteria_satisfied),
      prior_distance: progress.prior_distance ?? progress.criteria_unknown,
      current_distance: progress.current_distance ?? progress.criteria_unknown,
      velocity: progress.velocity ?? 0,
    };
    const coherence =
      this.drift?.coherenceMetricsForPlan(plan, taskIds) ??
      ({
        replan_count: Math.max(
          0,
          this.repo.listPlanRevisions().filter((revision) => revision.status === "accepted")
            .length - 1,
        ),
        spec_revision_count: Math.max(0, (plan?.spec_version ?? 0) - 1),
        question_density: this.repo
          .listMessages()
          .filter((message) => message.kind === "SpecQuestion").length,
        failure_count: taskStates.filter((entry) => entry.state.status === "failed").length,
        thresholds: {},
        breaches: [],
      } satisfies DigestRecord["sections"]["drift_dashboard"]["coherence"]);
    const goalRevisions =
      plan?.goal_id !== undefined ? this.repo.loadGoalRevisions(plan.goal_id) : [];
    const goalRevisionPressure =
      goalRevisions.length > 0
        ? Math.max(0, goalRevisions.length - 1)
        : this.repo.listMessages().filter((message) => message.kind === "GoalRevision").length;
    const driftEvents = this.repo.listDriftEventsForPlan(plan);
    const openCoverageGaps = driftEvents.filter(
      (event) => event.kind === "coverage_gap" && event.status === "open",
    );
    return {
      progress: normalizedProgress,
      coherence,
      intent: {
        coverage_gap_count: Math.max(this.coverageGapCount(taskIds), openCoverageGaps.length),
        off_plan_slice_count: plan
          ? this.repo.listTaskIds().filter((taskId) => !taskIds.includes(taskId)).length
          : 0,
        goal_revision_pressure: goalRevisionPressure,
        latest_goal_revision_magnitude: goalRevisions.at(-1)?.magnitude,
        minor_goal_revision_count: goalRevisions.filter(
          (revision) => revision.magnitude === "minor",
        ).length,
        material_goal_revision_count: goalRevisions.filter(
          (revision) => revision.magnitude !== "minor",
        ).length,
      },
      recent_events: driftEvents
        .slice(-10)
        .map((event) => ({
          id: event.id,
          kind: event.kind,
          severity: event.severity,
          status: event.status,
          subject_ref: event.subject_ref,
          summary: event.summary,
          gate_id: event.gate_id,
          created_at: event.created_at,
        }))
        .reverse(),
    };
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

  private validCriterionSatisfaction(claim: EvidenceClaim) {
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

  private coverageGapCount(taskIds: string[]): number {
    return taskIds.reduce(
      (count, taskId) =>
        count +
        this.repo
          .listEvidenceClaims(taskId)
          .filter(
            (claim) =>
              claim.risk.files_modified.length > 0 && claim.criterion_satisfaction.length === 0,
          ).length,
      0,
    );
  }

  private digestStatus(params: {
    plan: Plan | null;
    openGateCount: number;
    failedTaskCount: number;
    latestAuditStatus: AuditStatus | "none";
    budgetExceeded: boolean;
  }): DigestGoalStatus {
    if (!params.plan) return "blocked";
    if (params.plan.status === "completed") return "completed";
    if (params.plan.status === "cancelled") return "halted";
    if (params.openGateCount > 0) return "blocked";
    if (params.budgetExceeded) return "at_risk";
    if (params.failedTaskCount > 0 || params.latestAuditStatus === "failed") return "at_risk";
    return "on_track";
  }

  private headline(params: {
    plan: Plan | null;
    status: DigestGoalStatus;
    sliceCounts: DigestRecord["sections"]["what_changed"]["slices"];
    drift: DigestRecord["sections"]["drift_dashboard"];
    openGateCount: number;
    latestAuditStatus: AuditStatus | "none";
  }): string[] {
    if (!params.plan) {
      return [
        "No orchestration plan exists.",
        "Create or accept a plan before dispatching slices.",
      ];
    }
    return [
      `Plan "${params.plan.query}" is ${params.status}.`,
      `${params.sliceCounts.completed}/${params.sliceCounts.total} slices complete; ${params.sliceCounts.running + params.sliceCounts.verifying} active; ${params.sliceCounts.failed} failed.`,
      `Criteria coverage: ${params.drift.progress.criteria_satisfied}/${params.drift.progress.criteria_total} satisfied; ${params.drift.progress.criteria_unknown} unknown.`,
      `Pending escalations: ${params.openGateCount}.`,
      `Final audit: ${params.latestAuditStatus}.`,
    ];
  }

  private readySlices(taskStates: Array<{ id: string; state: TaskState }>): string[] {
    return taskStates
      .filter(
        (entry) =>
          entry.state.status === "scheduled" ||
          (entry.state.status === "pending" && this.dependenciesSatisfied(entry.id)),
      )
      .map((entry) => this.sliceLabel(entry.id))
      .slice(0, 10);
  }

  private dependenciesSatisfied(taskId: string): boolean {
    const definition = this.repo.loadTaskDefinition(taskId);
    if (!definition) return false;
    return definition.depends_on.every((dependencyId) => this.dependencySatisfied(dependencyId));
  }

  private dependencySatisfied(taskId: string): boolean {
    const state = this.repo.loadTaskState(taskId);
    if (!state) return false;
    if (state.status === "completed") return true;
    return (
      state.status === "superseded" &&
      state.superseded_by !== undefined &&
      this.repo.loadTaskState(state.superseded_by)?.status === "completed"
    );
  }

  private sliceLabel(taskId: string): string {
    const definition = this.repo.loadTaskDefinition(taskId);
    return definition ? `${definition.name}:${taskId}` : taskId;
  }

  private sourceRefs(params: {
    plan: Plan | null;
    taskIds: string[];
    gateIds: string[];
    messageIds?: string[];
    precedentIds?: string[];
    budgetUsageIds?: string[];
    driftEventIds?: string[];
    auditIds: string[];
    previousDigestId?: string;
  }): string[] {
    return [
      params.plan?.id ? `plan:${params.plan.id}` : undefined,
      ...params.taskIds.map((id) => `slice:${id}`),
      ...params.gateIds.map((id) => `gate:${id}`),
      ...(params.messageIds ?? []).map((id) => `message:${id}`),
      ...(params.precedentIds ?? []).map((id) => `precedent:${id}`),
      ...(params.budgetUsageIds ?? []).map((id) => `budget_usage:${id}`),
      ...(params.driftEventIds ?? []).map((id) => `drift:${id}`),
      ...params.auditIds.map((id) => `audit:${id}`),
      params.previousDigestId ? `digest:${params.previousDigestId}` : undefined,
    ]
      .filter((ref): ref is string => ref !== undefined)
      .filter((ref, index, refs) => refs.indexOf(ref) === index);
  }

  private after(value: string | undefined, boundary: string | undefined): boolean {
    if (!boundary) return true;
    if (!value) return false;
    return value > boundary;
  }

  private succeededAfterRetry(
    taskStates: Array<{ id: string; state: TaskState }>,
  ): Array<{ original_id: string; retry_id: string; completed_at?: string }> {
    const out: Array<{ original_id: string; retry_id: string; completed_at?: string }> = [];
    for (const entry of taskStates) {
      if (entry.state.status !== "superseded" || !entry.state.superseded_by) continue;
      const successor = taskStates.find((candidate) => candidate.id === entry.state.superseded_by);
      if (!successor || successor.state.status !== "completed") continue;
      out.push({
        original_id: entry.id,
        retry_id: successor.id,
        completed_at: successor.state.completed_at,
      });
    }
    return out;
  }

  private borderlinePrecedentMatches(autoResolvedMessages: ProtocolMessage[]): Array<{
    message_id: string;
    precedent_id: string;
    match_score?: number;
    resolved_at?: string;
  }> {
    return autoResolvedMessages
      .filter(
        (message) =>
          message.resolution?.match_band === "borderline" &&
          message.resolution.precedent_id !== undefined,
      )
      .map((message) => ({
        message_id: message.id,
        precedent_id: message.resolution?.precedent_id ?? "",
        match_score: message.resolution?.match_score,
        resolved_at: message.resolution?.resolved_at,
      }));
  }

  private computeTrends(params: {
    previous: DigestRecord;
    drift: DigestRecord["sections"]["drift_dashboard"];
    sliceCounts: DigestRecord["sections"]["what_changed"]["slices"];
    openGateCount: number;
  }): NonNullable<DigestRecord["sections"]["trends"]> {
    const prev = params.previous.sections;
    const prevProgress = prev.drift_dashboard.progress;
    const prevCoherence = prev.drift_dashboard.coherence;
    const prevSlices = prev.what_changed.slices;
    const prevOpenGates = prev.escalations.filter((entry) => entry.status === "open").length;
    const current = {
      progress: {
        current_distance: params.drift.progress.current_distance,
        velocity: params.drift.progress.velocity,
      },
      gates: { open_count: params.openGateCount },
      slices: { failed: params.sliceCounts.failed, completed: params.sliceCounts.completed },
      coherence: {
        replan_count: params.drift.coherence.replan_count,
        spec_revision_count: params.drift.coherence.spec_revision_count,
      },
    };
    return {
      previous_digest_id: params.previous.id,
      previous_created_at: params.previous.created_at,
      ...current,
      deltas: {
        current_distance: current.progress.current_distance - prevProgress.current_distance,
        velocity: current.progress.velocity - prevProgress.velocity,
        open_gate_count: current.gates.open_count - prevOpenGates,
        failed_slice_count: current.slices.failed - prevSlices.failed,
        completed_slice_count: current.slices.completed - prevSlices.completed,
        replan_count: current.coherence.replan_count - prevCoherence.replan_count,
        spec_revision_count:
          current.coherence.spec_revision_count - prevCoherence.spec_revision_count,
      },
    };
  }
}

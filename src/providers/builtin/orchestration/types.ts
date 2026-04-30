import type { ExecutorBinding } from "../../../runtime/delegation/executor-binding";

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type TaskKind = "implementation" | "audit" | "repair" | "docs" | "verification";

export type CriterionKind = "code" | "text";

export type GoalStatus = "draft" | "accepted" | "archived";
export type GoalRevisionMagnitude = "minor" | "material";

export type GoalRevision = {
  goal_id: string;
  version: number;
  title: string;
  intent: string;
  magnitude: GoalRevisionMagnitude;
  reason: string;
  evidence_refs: string[];
  created_at: string;
  accepted_at?: string;
};

export type Goal = {
  id: string;
  status: GoalStatus;
  title: string;
  intent: string;
  version: number;
  created_at: string;
  updated_at: string;
  accepted_at?: string;
  /**
   * When set, the orchestration runtime spawns spec-agent / planner
   * sub-agents as the goal moves through its gates. Otherwise the artifact
   * pipeline is human-driven via affordances.
   */
  autonomous?: boolean;
  autonomous_lifecycle?: {
    stage: string;
    updated_at: string;
    refs: Record<string, string>;
  };
};

export type GateType =
  | "goal_accept"
  | "spec_accept"
  | "plan_accept"
  | "slice_gate"
  | "irreversible_action"
  | "budget_exceeded"
  | "drift_escalation";

export type GateStatus = "open" | "accepted" | "rejected" | "cancelled";
export type GateResolver = "user" | "policy";

export type GatePolicyScope = {
  default_resolver?: GateResolver;
  gates?: Partial<Record<GateType, GateResolver>>;
};

export type GatePolicy = GatePolicyScope & {
  goals?: Record<string, GatePolicyScope>;
  specs?: Record<string, GatePolicyScope>;
  slices?: Record<string, GatePolicyScope>;
};

export type Gate = {
  id: string;
  scope: string;
  gate_type: GateType;
  status: GateStatus;
  resolver: GateResolver;
  subject_ref: string;
  summary: string;
  evidence_refs: string[];
  created_at: string;
  resolved_at?: string;
  resolution?: string;
  resolved_by?: GateResolver;
  resolution_policy_ref?: string;
  resolution_evidence_refs?: string[];
  applied_at?: string;
  version?: number;
};

export type ProtocolMessageKind =
  | "SpecQuestion"
  | "SpecRevisionProposal"
  | "PlanRevisionProposal"
  | "EscalationRequest"
  | "EvidenceClaim"
  | "GoalRevision";

export type ProtocolRole =
  | "user"
  | "resolver"
  | "spec-agent"
  | "planner"
  | "executor"
  | "orchestrator";
export type ProtocolMessageStatus = "open" | "acknowledged" | "resolved" | "rejected";

export type SpecQuestionClass = "lookup" | "inference" | "judgment" | "conflict";
export type PrecedentQuestionClass = Extract<SpecQuestionClass, "lookup" | "inference">;
export type CaseRecordQuestionClass = Extract<SpecQuestionClass, "judgment" | "conflict">;
export type PrecedentRaisedByRole = "planner" | "executor";
export type PrecedentDecidedBy = "user" | "policy" | "supervisor_agent";

export type ProtocolMessageSpecQuestion = {
  question_class: SpecQuestionClass;
  project_id: string;
  goal_id?: string;
  spec_version_at_creation?: number;
  spec_sections_referenced: string[];
  code_areas: string[];
  auto_resolve_with_precedent?: boolean;
  precedent_resolution_attempt?: PrecedentResolutionAttempt;
  case_record_matches?: CaseRecordMatch[];
};

export type ProtocolMessageResolution = {
  decided_by: PrecedentDecidedBy;
  answer: string;
  reasoning?: string;
  evidence_refs: string[];
  policy_ref?: string;
  precedent_id?: string;
  match_score?: number;
  match_band?: PrecedentMatchBand;
  match_score_source?: PrecedentMatchScoreSource;
  structural_keys?: PrecedentMatch["structural_keys"];
  resolved_at: string;
};

export type ProtocolMessage = {
  id: string;
  kind: ProtocolMessageKind;
  version: number;
  from_role: ProtocolRole;
  to_role: ProtocolRole;
  artifact_refs: string[];
  evidence_refs: string[];
  status: ProtocolMessageStatus;
  summary: string;
  body?: string;
  spec_question?: ProtocolMessageSpecQuestion;
  resolution?: ProtocolMessageResolution;
  created_at: string;
  updated_at: string;
};

export type Precedent = {
  id: string;
  created_at: string;
  last_used_at?: string;
  use_count: number;
  context: {
    project_id: string;
    goal_id?: string;
    spec_version_at_creation?: number;
    question_class: PrecedentQuestionClass;
    spec_sections_referenced: string[];
    code_areas: string[];
  };
  question: {
    text: string;
    canonical_summary: string;
    raised_by_role: PrecedentRaisedByRole;
    embedding?: number[];
  };
  resolution: {
    decided_by: PrecedentDecidedBy;
    answer: string;
    reasoning?: string;
    evidence_refs?: string[];
  };
  health: {
    matches_promoted: number;
    matches_escalated_anyway: number;
    contradicted: boolean;
    invalidated_by?: string;
    expires_at?: string;
  };
  version?: number;
};

export type CaseRecord = {
  id: string;
  created_at: string;
  last_used_at?: string;
  use_count: number;
  context: {
    project_id: string;
    goal_id?: string;
    spec_version_at_creation?: number;
    question_class: CaseRecordQuestionClass;
    spec_sections_referenced: string[];
    code_areas: string[];
  };
  question: {
    text: string;
    canonical_summary: string;
    raised_by_role: PrecedentRaisedByRole;
  };
  resolution: {
    decided_by: PrecedentDecidedBy;
    answer: string;
    reasoning?: string;
    evidence_refs?: string[];
  };
  version?: number;
};

export type PrecedentMatchBand = "high" | "borderline" | "low";
export type PrecedentMatchScoreSource = "embedding" | "lexical";

export type PrecedentMatch = {
  precedent_id: string;
  score: number;
  score_source?: PrecedentMatchScoreSource;
  band: PrecedentMatchBand;
  auto_resolvable: boolean;
  structural_keys: {
    project_id: string;
    question_class: PrecedentQuestionClass;
    spec_sections_referenced: string[];
    code_areas: string[];
  };
};

export type PrecedentResolutionAttempt = {
  decision: "accepted" | "escalated";
  policy_ref?: string;
  precedent_id: string;
  match_score: number;
  match_band: PrecedentMatchBand;
  match_score_source?: PrecedentMatchScoreSource;
  structural_keys: PrecedentMatch["structural_keys"];
  reasoning?: string;
  evidence_refs: string[];
  decided_at: string;
};

export type PrecedentEmbeddingInput = {
  project_id: string;
  question_class: PrecedentQuestionClass;
  spec_sections_referenced: string[];
  code_areas: string[];
  question: string;
  canonical_summary: string;
};

export type PrecedentEmbeddingProvider = (
  input: PrecedentEmbeddingInput,
) => number[] | null | undefined | Promise<number[] | null | undefined>;

export type PrecedentTieBreakInput = {
  precedent: Precedent;
  match: PrecedentMatch;
  question: {
    text: string;
    canonical_summary: string;
  };
};

export type PrecedentTieBreakDecision = {
  equivalent: boolean;
  reasoning?: string;
  evidence_refs?: string[];
  policy_ref?: string;
};

export type PrecedentTieBreaker = (
  input: PrecedentTieBreakInput,
) =>
  | PrecedentTieBreakDecision
  | null
  | undefined
  | Promise<PrecedentTieBreakDecision | null | undefined>;

export type CaseRecordMatch = {
  case_record_id: string;
  score: number;
  structural_keys: {
    project_id: string;
    question_class: CaseRecordQuestionClass;
    spec_sections_referenced: string[];
    code_areas: string[];
  };
};

export type EvidenceVerification = "replayable" | "observed" | "self_attested";

export type EvidenceCheck = {
  id: string;
  type: "test" | "typecheck" | "lint" | "build" | "custom";
  command: string;
  exit_code: number;
  output_ref?: string;
  duration_ms?: number;
  verification: "replayable" | "self_attested";
};

export type EvidenceObservation = {
  id: string;
  type: string;
  description: string;
  captured_data_ref?: string;
  replay_recipe?: string;
  verification: "observed";
};

export type CriterionSatisfaction = {
  criterion_id: string;
  evidence_refs: string[];
  kind: "replayable" | "observed";
};

export type EvidenceClaim = {
  id: string;
  slice_id: string;
  attempt_id: string;
  executor_id?: string;
  timestamp: string;
  at_commit?: string;
  diff_ref?: string;
  checks: EvidenceCheck[];
  observations: EvidenceObservation[];
  criterion_satisfaction: CriterionSatisfaction[];
  provenance: {
    spec_sections_read: string[];
    clarifications_used: string[];
    files_inspected: Array<{ path: string; commit?: string }>;
    planner_assumptions: string[];
  };
  risk: {
    files_modified: string[];
    public_surface_delta?: string;
    irreversible_actions: string[];
    deps_added: string[];
    external_calls: string[];
  };
  source?: "submit_evidence_claim" | "legacy_record_verification";
};

export type DriftEventKind =
  | "progress_drift"
  | "coherence_drift"
  | "intent_drift"
  | "evidence_regression"
  | "coverage_gap"
  | "observed_only_coverage"
  | "repeated_failure"
  | "blast_radius_violation"
  | "irreversible_action_declared"
  | "budget_exhaustion";

export type DriftSeverity = "info" | "warning" | "blocking";
export type DriftEventStatus = "open" | "acknowledged" | "resolved";

export type DriftEvent = {
  id: string;
  kind: DriftEventKind;
  severity: DriftSeverity;
  status: DriftEventStatus;
  plan_id?: string;
  slice_id?: string;
  subject_ref: string;
  summary: string;
  evidence_refs: string[];
  metrics?: Record<string, unknown>;
  gate_id?: string;
  created_at: string;
  resolved_at?: string;
  resolution?: string;
  version?: number;
};

export type BlastRadiusPolicy = {
  max_files_modified?: number;
  max_deps_added?: number;
  max_external_calls?: number;
  public_surface_delta_requires_gate?: boolean;
};

export type GuardrailPolicy = {
  blast_radius?: BlastRadiusPolicy;
  repeated_failure_limit?: number;
  progress_stall_limit?: number;
  progress_projection_requires_budget?: boolean;
  coherence_replan_rate_limit?: number;
  coherence_question_density_limit?: number;
};

export type PlanRevisionStatus = "proposed" | "accepted" | "rejected" | "superseded";

export type PlanSliceInput = CreateTaskParams & {
  planner_assumptions?: string[];
  structural_assumptions?: string[];
};

export type PlanRevision = {
  id: string;
  plan_id: string;
  status: PlanRevisionStatus;
  revision_number: number;
  goal_id?: string;
  goal_version?: number;
  spec_id?: string;
  spec_version?: number;
  planned_commit?: string;
  query: string;
  strategy: string;
  max_agents: number;
  planner_assumptions: string[];
  structural_assumptions: string[];
  slices: PlanSliceInput[];
  slice_gate_resolver?: GateResolver;
  budget?: PlanBudget;
  gate_id?: string;
  created_at: string;
  accepted_at?: string;
  resolved_at?: string;
  resolution?: string;
  version?: number;
};

export type AuditStatus = "passed" | "failed";
export type FinalAuditFailureReason =
  | "nonzero_exit"
  | "unsupported_command"
  | "timeout"
  | "spawn_error";

export type FinalAuditRecord = {
  id: string;
  plan_id: string;
  plan_version: number;
  status: AuditStatus;
  replayed_checks: Array<{
    evidence_claim_id: string;
    check_id: string;
    command: string;
    exit_code: number;
    recorded_exit_code: number;
    actual_exit_code?: number | null;
    duration_ms?: number;
    output_ref?: string;
    failure_reason?: FinalAuditFailureReason;
    status: AuditStatus;
  }>;
  failures: string[];
  created_at: string;
};

export type DigestGoalStatus = "on_track" | "at_risk" | "blocked" | "completed" | "halted";
export type DigestCadence =
  | "manual"
  | "on_milestone"
  | "on_escalation"
  | "daily"
  | "continuous"
  | "final";
export type DigestTriggerReason = "manual" | "escalation" | "goal_status_change" | "final";
export type DigestCadenceSource = "manual" | "policy" | "trigger";

export type DigestPolicy = {
  cadence?: DigestCadence;
};
export type DigestActionKind =
  | "accept_gate"
  | "reject_gate"
  | "contradict_precedent"
  | "raise_budget"
  | "run_final_audit"
  | "cancel_plan";

export type DigestAction = {
  id: string;
  kind: DigestActionKind;
  label: string;
  target_ref: string;
  action_path: string;
  action_name: string;
  params: Record<string, unknown>;
  source_refs: string[];
  urgency: "low" | "normal" | "high";
};

export type DigestDeliveryReason = "escalation" | "goal_status_change" | "final";
export type DigestDeliveryStatus = "pending" | "delivered" | "cancelled";

export type DigestDeliveryTransportResult =
  | { ok: true; external_ref?: string }
  | { ok: false; error: string; retryable?: boolean };

export type DigestDeliveryTransport = {
  channel: string;
  deliver(input: {
    delivery: DigestDelivery;
    digest: DigestRecord;
  }): DigestDeliveryTransportResult | Promise<DigestDeliveryTransportResult>;
};

export type DigestTransportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SlackDigestTransportOptions = {
  channel?: string;
  webhookUrl: string;
  username?: string;
  iconEmoji?: string;
  fetch?: DigestTransportFetch;
};

export type EmailDigestTransportOptions = {
  channel?: string;
  endpointUrl: string;
  from: string;
  to: string[];
  apiKey?: string;
  subjectPrefix?: string;
  headers?: Record<string, string>;
  fetch?: DigestTransportFetch;
};

export type DigestDelivery = {
  id: string;
  digest_id: string;
  plan_id?: string;
  goal_id?: string;
  mode: "push";
  channel: string;
  reasons: DigestDeliveryReason[];
  status: DigestDeliveryStatus;
  source_refs: string[];
  created_at: string;
  attempt_count: number;
  last_attempt_at?: string;
  last_error?: string;
  delivered_by?: string;
  external_ref?: string;
  delivered_at?: string;
  version?: number;
};

export type PlanBudget = {
  wall_time_ms?: number;
  retries_per_slice?: number;
  token_limit?: number;
  cost_usd?: number;
};

export type BudgetStatus = {
  configured: boolean;
  exceeded: boolean;
  exceeded_limits: Array<keyof PlanBudget>;
  wall_time_ms?: number;
  elapsed_wall_time_ms?: number;
  remaining_wall_time_ms?: number;
  retries_per_slice?: number;
  retry_attempts_used?: number;
  retry_over_budget_slice_count?: number;
  retry_gate_id?: string;
  token_limit?: number;
  input_tokens_used?: number;
  output_tokens_used?: number;
  tokens_used?: number;
  tokens_remaining?: number;
  token_gate_id?: string;
  cost_usd?: number;
  cost_usd_used?: number;
  cost_usd_remaining?: number;
  cost_gate_id?: string;
  gate_id?: string;
  message: string;
};

export type BudgetUsageSource = "llm" | "manual" | "delegation" | "external";

export type BudgetUsageRecord = {
  id: string;
  plan_id: string;
  task_id?: string;
  source: BudgetUsageSource;
  model?: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd?: number;
  evidence_refs: string[];
  created_at: string;
};

export type DigestRecord = {
  id: string;
  cadence: DigestCadence;
  trigger_reason?: DigestTriggerReason;
  cadence_source?: DigestCadenceSource;
  status: DigestGoalStatus;
  session_id: string;
  plan_id?: string;
  plan_version?: number;
  goal_id?: string;
  goal_version?: number;
  spec_id?: string;
  spec_version?: number;
  previous_digest_id?: string;
  headline: string[];
  sections: {
    what_changed: {
      slices: {
        total: number;
        pending: number;
        scheduled: number;
        running: number;
        verifying: number;
        completed: number;
        failed: number;
        cancelled: number;
        superseded: number;
      };
      plan_revisions: {
        total: number;
        proposed: number;
        accepted: number;
        rejected: number;
        superseded: number;
      };
      audits: {
        total: number;
        passed: number;
        failed: number;
        latest_status: AuditStatus | "none";
      };
      protocol_messages: {
        total: number;
        open: number;
      };
    };
    escalations: Array<{
      gate_id: string;
      gate_type: GateType;
      status: GateStatus;
      subject_ref: string;
      summary: string;
      evidence_refs: string[];
      created_at: string;
      resolved_at?: string;
    }>;
    auto_resolutions: {
      count: number;
      high_confidence_count: number;
      entries: Array<{
        gate_id?: string;
        gate_type?: GateType;
        message_id?: string;
        message_kind?: ProtocolMessageKind;
        subject_ref: string;
        policy_ref?: string;
        precedent_id?: string;
        match_score?: number;
        match_band?: PrecedentMatchBand;
        match_score_source?: PrecedentMatchScoreSource;
        evidence_refs: string[];
        resolved_at?: string;
      }>;
    };
    near_misses: Array<{
      kind:
        | "failed_slice"
        | "failed_audit"
        | "rejected_gate"
        | "succeeded_after_retry"
        | "borderline_precedent_match"
        | "observed_only_coverage";
      ref: string;
      summary: string;
      created_at?: string;
    }>;
    trends?: {
      previous_digest_id: string;
      previous_created_at?: string;
      progress: { current_distance: number; velocity: number };
      gates: { open_count: number };
      slices: { failed: number; completed: number };
      coherence: { replan_count: number; spec_revision_count: number };
      deltas: {
        current_distance: number;
        velocity: number;
        open_gate_count: number;
        failed_slice_count: number;
        completed_slice_count: number;
        replan_count: number;
        spec_revision_count: number;
      };
    };
    drift_dashboard: {
      progress: {
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
      coherence: {
        replan_count: number;
        spec_revision_count: number;
        question_density: number;
        failure_count: number;
        thresholds: {
          replan_rate_limit?: number;
          spec_revision_rate_limit?: number;
          question_density_limit?: number;
          failure_cluster_limit?: number;
        };
        breaches: string[];
      };
      intent: {
        coverage_gap_count: number;
        off_plan_slice_count: number;
        goal_revision_pressure: number;
        latest_goal_revision_magnitude?: GoalRevisionMagnitude;
        minor_goal_revision_count: number;
        material_goal_revision_count: number;
      };
      recent_events: Array<{
        id: string;
        kind: DriftEventKind;
        severity: DriftSeverity;
        status: DriftEventStatus;
        subject_ref: string;
        summary: string;
        gate_id?: string;
        created_at: string;
      }>;
    };
    budget: {
      configured: boolean;
      exceeded: boolean;
      exceeded_limits: Array<keyof PlanBudget>;
      wall_time_ms?: number;
      elapsed_wall_time_ms?: number;
      remaining_wall_time_ms?: number;
      retries_per_slice?: number;
      retry_attempts_used?: number;
      retry_over_budget_slice_count?: number;
      retry_gate_id?: string;
      token_limit?: number;
      input_tokens_used?: number;
      output_tokens_used?: number;
      tokens_used?: number;
      tokens_remaining?: number;
      token_gate_id?: string;
      cost_usd?: number;
      cost_usd_used?: number;
      cost_usd_remaining?: number;
      cost_gate_id?: string;
      gate_id?: string;
      message: string;
    };
    whats_next: {
      pending_gate_count: number;
      next_ready_slices: string[];
      running_slices: string[];
      final_audit_status: AuditStatus | "none";
    };
  };
  actions: DigestAction[];
  delivery: {
    pull_ref: string;
    push_required: boolean;
    push_reasons: DigestDeliveryReason[];
    delivery_id?: string;
  };
  source_refs: string[];
  created_at: string;
};

export type TaskDefinition = {
  id: string;
  plan_id?: string;
  slice_id?: string;
  plan_version?: number;
  plan_revision_id?: string;
  spec_version?: number;
  executor_binding?: ExecutorBinding;
  name: string;
  goal: string;
  kind?: TaskKind;
  depends_on: string[];
  spec_refs?: string[];
  audit_of?: string;
  finding_refs?: string[];
  acceptance_criteria?: AcceptanceCriterion[];
  aliases?: string[];
  client_ref?: string;
  retry_of?: string;
  planner_assumptions?: string[];
  structural_assumptions?: string[];
  attempt_count?: number;
  requires_slice_gate?: boolean;
  slice_gate_resolver?: GateResolver;
  created_at: string;
};

export type FailureDecision = "reprompt" | "respawn" | "escalate";

export type TaskState = {
  status: TaskStatus;
  updated_at: string;
  iteration: number;
  message?: string;
  error?: string;
  scheduled_at?: string;
  verification_started_at?: string;
  completed_at?: string;
  superseded_by?: string;
  last_failure_class?: string;
  last_failure_decision?: FailureDecision;
  consecutive_failure_count?: number;
  version?: number;
};

export type VerificationStatus = "passed" | "failed" | "skipped" | "not_required" | "unknown";

export type VerificationRecord = {
  id: string;
  kind: string;
  status: VerificationStatus;
  summary: string;
  created_at: string;
  criteria?: string[];
  command?: string;
  evidence?: string;
  evidence_refs?: string[];
  evidence_claim_id?: string;
  source?: "legacy_record_verification";
};

export type AcceptanceCriterion = {
  id: string;
  text: string;
  criterion_kind?: CriterionKind;
  verification_hint?: string;
};

export type CreateTaskParams = {
  name: string;
  goal: string;
  kind?: TaskKind;
  depends_on?: string[];
  spec_refs?: string[];
  audit_of?: string;
  finding_refs?: string[];
  acceptance_criteria?: string[];
  client_ref?: string;
  retry_of?: string;
  planner_assumptions?: string[];
  structural_assumptions?: string[];
  plan_version?: number;
  plan_revision_id?: string;
  spec_version?: number;
  requires_slice_gate?: boolean;
  slice_gate_resolver?: GateResolver;
  executor_binding?: ExecutorBinding;
};

export type TaskDraft = CreateTaskParams & {
  id: string;
  aliases: string[];
};

export type Plan = {
  id?: string;
  session_id: string;
  query: string;
  strategy: string;
  max_agents: number;
  created_at: string;
  status: "active" | "final_audit" | "completed" | "cancelled";
  goal_id?: string;
  goal_version?: number;
  spec_id?: string;
  spec_version?: number;
  planned_commit?: string;
  active_revision_id?: string;
  gate_mode?: "legacy" | "hitl";
  budget?: PlanBudget;
  final_audit_id?: string;
  version?: number;
};

export type HandoffStatus = "pending" | "responded" | "cancelled";
export type HandoffKind =
  | "question"
  | "artifact_request"
  | "review_request"
  | "decision_request"
  | "dependency_signal";
export type HandoffPriority = "low" | "normal" | "high";

export type Handoff = {
  id: string;
  plan_id?: string;
  from_task: string;
  to_task: string;
  kind?: HandoffKind;
  priority?: HandoffPriority;
  request: string;
  spec_refs?: string[];
  evidence_refs?: string[];
  blocks_task?: boolean;
  status: HandoffStatus;
  created_at: string;
  responded_at?: string;
  response?: string;
  decision_refs?: string[];
  response_evidence_refs?: string[];
  unblock?: boolean;
  version?: number;
};

export type AuditFindingSeverity = "blocking" | "warning" | "note";
export type AuditFindingStatus = "open" | "accepted" | "fixed" | "dismissed";
export type AuditFindingRecommendation = "repair" | "spec_change" | "accept_deviation";

export type AuditFinding = {
  id: string;
  audit_task_id: string;
  target_task_id: string;
  severity: AuditFindingSeverity;
  status: AuditFindingStatus;
  spec_refs: string[];
  summary: string;
  evidence_refs: string[];
  recommendation: AuditFindingRecommendation;
  created_at: string;
  resolved_at?: string;
  resolution_reason?: string;
  repair_task_id?: string;
  version?: number;
};

export const ORCHESTRATION_DIR = ".sloppy/orchestration";
export const OPTIONAL_EXPECTED_VERSION_PARAM = {
  type: "number",
  description:
    "Optional CAS guard. If provided, the update is rejected when the task/handoff/plan version has moved on.",
  optional: true,
} as const;

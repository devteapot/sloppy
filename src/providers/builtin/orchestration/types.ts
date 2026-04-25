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

export type TaskDefinition = {
  id: string;
  plan_id?: string;
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
  created_at: string;
};

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
};

export type AcceptanceCriterion = {
  id: string;
  text: string;
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
  status: "active" | "completed" | "cancelled";
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

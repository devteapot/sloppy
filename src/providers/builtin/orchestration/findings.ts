import { debug } from "../../../core/debug";
import type { TaskLifecycle } from "./lifecycle";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type {
  AuditFinding,
  AuditFindingRecommendation,
  AuditFindingSeverity,
  AuditFindingStatus,
} from "./types";

export interface FindingsDeps {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  refresh: () => void;
}

export class FindingsCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly refresh: () => void;

  constructor(deps: FindingsDeps) {
    this.repo = deps.repo;
    this.lifecycle = deps.lifecycle;
    this.refresh = deps.refresh;
  }

  recordFinding(params: {
    audit_task_id: string;
    target_task_id: string;
    severity: AuditFindingSeverity;
    spec_refs?: string[];
    summary: string;
    evidence_refs?: string[];
    recommendation: AuditFindingRecommendation;
  }): AuditFinding {
    const plan = this.repo.requireActivePlan();
    if (!this.repo.taskBelongsToPlan(this.repo.loadTaskDefinition(params.audit_task_id), plan)) {
      throw codedError(
        "invalid_audit_task",
        `audit_task_id must reference a task in the active plan.`,
      );
    }
    if (!this.repo.taskBelongsToPlan(this.repo.loadTaskDefinition(params.target_task_id), plan)) {
      throw codedError(
        "invalid_target_task",
        `target_task_id must reference a task in the active plan.`,
      );
    }

    const evidenceRefs = params.evidence_refs ?? [];
    const invalidEvidenceRefs = this.repo.invalidEvidenceRefs(evidenceRefs);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }

    const id = `finding-${crypto.randomUUID().slice(0, 8)}`;
    const finding: AuditFinding = {
      id,
      audit_task_id: params.audit_task_id,
      target_task_id: params.target_task_id,
      severity: params.severity,
      status: "open",
      spec_refs: params.spec_refs ?? [],
      summary: params.summary,
      evidence_refs: evidenceRefs,
      recommendation: params.recommendation,
      created_at: new Date().toISOString(),
      version: this.repo.bumpFindingVersion(id),
    };
    this.repo.writeFinding(finding);
    debug("orchestration", "record_finding", {
      id,
      audit_task_id: finding.audit_task_id,
      target_task_id: finding.target_task_id,
      severity: finding.severity,
      recommendation: finding.recommendation,
    });
    this.refresh();
    return finding;
  }

  resolveFinding(params: {
    finding_id: string;
    status: Exclude<AuditFindingStatus, "open">;
    reason?: string;
  }): { id: string; status: AuditFindingStatus; version: number } {
    const finding = this.repo.loadFinding(params.finding_id);
    if (!finding) {
      throw new Error(`Unknown finding: ${params.finding_id}`);
    }
    if (finding.status !== "open") {
      throw new Error(`Finding ${params.finding_id} is already ${finding.status}.`);
    }
    const version = this.repo.bumpFindingVersion(params.finding_id);
    const next: AuditFinding = {
      ...finding,
      status: params.status,
      resolved_at: new Date().toISOString(),
      resolution_reason: params.reason,
      version,
    };
    this.repo.writeFinding(next);
    this.refresh();
    return { id: next.id, status: next.status, version };
  }

  createRepairTask(params: {
    finding_id: string;
    name?: string;
    goal?: string;
    acceptance_criteria?: string[];
  }): {
    finding_id: string;
    repair_task_id: string;
    version: number;
  } {
    const finding = this.repo.loadFinding(params.finding_id);
    if (!finding) {
      throw new Error(`Unknown finding: ${params.finding_id}`);
    }
    if (finding.status !== "open") {
      throw new Error(`Finding ${params.finding_id} is ${finding.status}; repair is not needed.`);
    }

    const task = this.lifecycle.createTask({
      name: params.name ?? `repair-${params.finding_id}`,
      goal:
        params.goal ??
        `Repair audit finding ${params.finding_id} for ${finding.target_task_id}: ${finding.summary}`,
      kind: "repair",
      spec_refs: finding.spec_refs,
      finding_refs: [finding.id],
      depends_on: [finding.target_task_id],
      acceptance_criteria: params.acceptance_criteria ?? [
        `Finding ${finding.id} is resolved or no longer applies after re-audit`,
      ],
    });

    const version = this.repo.bumpFindingVersion(params.finding_id);
    this.repo.writeFinding({
      ...finding,
      repair_task_id: task.id,
      version,
    });
    this.refresh();
    return { finding_id: finding.id, repair_task_id: task.id, version };
  }
}

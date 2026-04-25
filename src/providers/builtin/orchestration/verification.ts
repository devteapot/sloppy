import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { debug } from "../../../core/debug";
import { uniqueStrings } from "./classifiers";
import type { StateTransitionResult, TaskLifecycle } from "./lifecycle";
import { normalizeReference } from "./normalization";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type { TaskStatus, VerificationRecord, VerificationStatus } from "./types";

export interface VerificationDeps {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  refresh: () => void;
}

export class VerificationCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly refresh: () => void;

  constructor(deps: VerificationDeps) {
    this.repo = deps.repo;
    this.lifecycle = deps.lifecycle;
    this.refresh = deps.refresh;
  }

  startVerification(params: { task_id: string; expected_version?: number }): StateTransitionResult {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "running" && state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} cannot enter verification from status ${state.status}.`,
      );
    }
    if (state.status === "verifying") {
      return { version: this.repo.taskVersion(params.task_id), status: state.status };
    }
    const result = this.lifecycle.updateTaskState(
      params.task_id,
      { status: "verifying", verification_started_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  attachResult(params: {
    task_id: string;
    result: string;
    expected_version?: number;
  }):
    | { version: number; status: TaskStatus; bytes: number }
    | { error: string; currentVersion: number } {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "running" && state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} can only attach a pushed result while running or verifying (current status: ${state.status}).`,
      );
    }
    mkdirSync(this.repo.taskDir(params.task_id), { recursive: true });
    writeFileSync(this.repo.resultPath(params.task_id), params.result, "utf8");

    const update =
      state.status === "running"
        ? { status: "verifying" as const, verification_started_at: new Date().toISOString() }
        : {};
    const result = this.lifecycle.updateTaskState(params.task_id, update, params.expected_version);
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status, bytes: params.result.length };
  }

  recordVerification(params: {
    task_id: string;
    kind?: string;
    status: VerificationStatus;
    summary: string;
    criteria?: string[];
    command?: string;
    evidence?: string;
    evidence_refs?: string[];
  }): {
    task_id: string;
    verification_id: string;
    status: VerificationStatus;
    count: number;
    covered_criteria: string[];
    missing_criteria: string[];
  } {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status === "pending") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} must be running before verification can be recorded.`,
      );
    }
    if (
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "superseded"
    ) {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} is ${state.status}; verification cannot be recorded.`,
      );
    }
    if (state.status === "running") {
      this.lifecycle.updateTaskState(
        params.task_id,
        {
          status: "verifying",
          verification_started_at: new Date().toISOString(),
        },
        undefined,
      );
    }

    const verifications = this.repo.loadVerifications(params.task_id);
    const criteria = this.normalizeVerificationCriteria(params.task_id, params.criteria);
    const evidenceRefs = params.evidence_refs ?? [];
    if (params.status === "passed" && criteria.length > 0 && evidenceRefs.length === 0) {
      throw codedError(
        "evidence_required",
        "Passed verification covering acceptance criteria must include evidence_refs with supporting files, commands, URLs, screenshots, or state paths.",
      );
    }
    const invalidEvidenceRefs = this.repo.invalidEvidenceRefs(evidenceRefs);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }
    const record: VerificationRecord = {
      id: `verification-${crypto.randomUUID().slice(0, 8)}`,
      kind: params.kind?.trim() || "check",
      status: params.status,
      summary: params.summary,
      criteria,
      command: params.command,
      evidence: params.evidence,
      evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
      created_at: new Date().toISOString(),
    };
    const next = [...verifications, record];
    this.repo.writeVerifications(params.task_id, next);
    debug("orchestration", "record_verification", {
      taskId: params.task_id,
      verificationId: record.id,
      kind: record.kind,
      status: record.status,
    });
    this.refresh();
    return {
      task_id: params.task_id,
      verification_id: record.id,
      status: record.status,
      count: next.length,
      covered_criteria: this.coveredAcceptanceCriteria(params.task_id, next),
      missing_criteria: this.missingAcceptanceCriteria(params.task_id, next),
    };
  }

  normalizeVerificationCriteria(taskId: string, rawCriteria?: string[]): string[] {
    const criteria = this.repo.loadAcceptanceCriteria(taskId);
    if (criteria.length === 0) {
      return [];
    }
    if (!rawCriteria || rawCriteria.length === 0) {
      return [];
    }

    const byReference = new Map<string, string>();
    for (const criterion of criteria) {
      byReference.set(normalizeReference(criterion.id), criterion.id);
      byReference.set(normalizeReference(criterion.text), criterion.id);
      const numeric = criterion.id.replace(/^ac-/, "");
      byReference.set(normalizeReference(numeric), criterion.id);
    }

    const ids: string[] = [];
    for (const item of rawCriteria) {
      const normalized = normalizeReference(item);
      if (normalized === "all" || normalized === "*") {
        ids.push(...criteria.map((criterion) => criterion.id));
        continue;
      }
      const id = byReference.get(normalized);
      if (id) {
        ids.push(id);
      }
    }

    return uniqueStrings(ids);
  }

  coveredAcceptanceCriteria(
    taskId: string,
    verifications = this.repo.loadVerifications(taskId),
  ): string[] {
    const covered = new Set<string>();
    for (const verification of verifications) {
      if (verification.status !== "passed" && verification.status !== "not_required") {
        continue;
      }
      for (const criterionId of verification.criteria ?? []) {
        covered.add(criterionId);
      }
    }
    return [...covered].sort();
  }

  missingAcceptanceCriteria(
    taskId: string,
    verifications = this.repo.loadVerifications(taskId),
  ): string[] {
    const covered = new Set(this.coveredAcceptanceCriteria(taskId, verifications));
    return this.repo
      .loadAcceptanceCriteria(taskId)
      .map((criterion) => criterion.id)
      .filter((criterionId) => !covered.has(criterionId));
  }

  hasCompletionVerification(taskId: string): boolean {
    const criteria = this.repo.loadAcceptanceCriteria(taskId);
    if (criteria.length > 0) {
      return this.missingAcceptanceCriteria(taskId).length === 0;
    }

    return this.repo
      .loadVerifications(taskId)
      .some(
        (verification) =>
          verification.status === "passed" || verification.status === "not_required",
      );
  }

  getResult(taskId: string): { task_id: string; result: string | null } {
    const resultPath = this.repo.resultPath(taskId);
    if (!existsSync(resultPath)) {
      return { task_id: taskId, result: null };
    }
    return { task_id: taskId, result: readFileSync(resultPath, "utf8") };
  }

  getVerifications(taskId: string): {
    task_id: string;
    verifications: VerificationRecord[];
  } {
    return {
      task_id: taskId,
      verifications: this.repo.loadVerifications(taskId),
    };
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { debug } from "../../../core/debug";
import { classifyIrreversibleCommand, uniqueStrings } from "./classifiers";
import type { DriftCoordinator } from "./drift";
import type { GatesCoordinator } from "./gates";
import type { StateTransitionResult, TaskLifecycle } from "./lifecycle";
import { normalizeReference } from "./normalization";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type {
  CriterionSatisfaction,
  EvidenceCheck,
  EvidenceClaim,
  EvidenceObservation,
  TaskStatus,
  VerificationRecord,
  VerificationStatus,
} from "./types";

export interface VerificationDeps {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  gates: GatesCoordinator;
  drift?: DriftCoordinator;
  refresh: () => void;
}

export class VerificationCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly gates: GatesCoordinator;
  private readonly drift: DriftCoordinator | undefined;
  private readonly refresh: () => void;

  constructor(deps: VerificationDeps) {
    this.repo = deps.repo;
    this.lifecycle = deps.lifecycle;
    this.gates = deps.gates;
    this.drift = deps.drift;
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
    const previousCoveredCriteria = this.coveredAcceptanceCriteria(params.task_id, verifications);
    const legacyClaim = this.createLegacyEvidenceClaim({
      task_id: params.task_id,
      kind: params.kind?.trim() || "check",
      status: params.status,
      summary: params.summary,
      criteria,
      command: params.command,
      evidence: params.evidence,
      evidence_refs: evidenceRefs,
    });
    this.drift?.recordEvidenceClaim({ claim: legacyClaim, previousCoveredCriteria });

    const record: VerificationRecord = {
      id: `verification-${crypto.randomUUID().slice(0, 8)}`,
      kind: params.kind?.trim() || "check",
      status: params.status,
      summary: params.summary,
      criteria,
      command: params.command,
      evidence: params.evidence,
      evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
      evidence_claim_id: legacyClaim.id,
      source: "legacy_record_verification",
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

  submitEvidenceClaim(params: {
    task_id: string;
    attempt_id?: string;
    executor_id?: string;
    at_commit?: string;
    diff_ref?: string;
    checks?: unknown[];
    observations?: unknown[];
    criterion_satisfaction?: unknown[];
    provenance?: unknown;
    risk?: unknown;
  }): {
    task_id: string;
    evidence_claim_id: string;
    gate_id?: string;
    gate_ids: string[];
    drift_event_ids: string[];
    covered_criteria: string[];
    missing_criteria: string[];
  } {
    const state = this.repo.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "running" && state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} must be running or verifying before evidence can be submitted.`,
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

    const previousCoveredCriteria = this.coveredAcceptanceCriteria(params.task_id);
    const claim = this.normalizeEvidenceClaim(params);
    this.validateEvidenceClaim(claim);
    this.repo.writeEvidenceClaim(claim);

    const drift = this.drift?.recordEvidenceClaim({ claim, previousCoveredCriteria });
    const gate = this.maybeOpenSliceGate(params.task_id);
    this.refresh();
    return {
      task_id: params.task_id,
      evidence_claim_id: claim.id,
      gate_id: gate?.id,
      gate_ids: uniqueStrings([gate?.id, ...(drift?.gateIds ?? [])].filter(Boolean) as string[]),
      drift_event_ids: drift?.events.map((event) => event.id) ?? [],
      covered_criteria: this.coveredAcceptanceCriteria(params.task_id),
      missing_criteria: this.missingAcceptanceCriteria(params.task_id),
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
    for (const claim of this.repo.listEvidenceClaims(taskId)) {
      for (const criterion of this.validCriterionSatisfaction(claim)) {
        covered.add(criterion.criterion_id);
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

  hasAcceptedSliceGate(taskId: string): boolean {
    const definition = this.repo.loadTaskDefinition(taskId);
    if (!definition?.requires_slice_gate) {
      return true;
    }
    return this.repo.latestAcceptedGate("slice_gate", `slice:${taskId}`) !== null;
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
    evidence_claims: EvidenceClaim[];
  } {
    return {
      task_id: taskId,
      verifications: this.repo.loadVerifications(taskId),
      evidence_claims: this.repo.listEvidenceClaims(taskId),
    };
  }

  private createLegacyEvidenceClaim(params: {
    task_id: string;
    kind: string;
    status: VerificationStatus;
    summary: string;
    criteria: string[];
    command?: string;
    evidence?: string;
    evidence_refs: string[];
  }): EvidenceClaim {
    const claimId = `evidence-${crypto.randomUUID().slice(0, 8)}`;
    const itemId = params.command ? "check-1" : "observation-1";
    const satisfiable = params.status === "passed" || params.status === "not_required";
    const checks: EvidenceCheck[] =
      params.command && params.status === "passed"
        ? [
            {
              id: itemId,
              type: this.normalizeCheckType(params.kind),
              command: params.command,
              exit_code: 0,
              verification: "replayable",
            },
          ]
        : [];
    const observations: EvidenceObservation[] =
      checks.length === 0
        ? [
            {
              id: itemId,
              type: params.kind,
              description: params.evidence ?? params.summary,
              verification: "observed",
            },
          ]
        : [];
    const claim: EvidenceClaim = {
      id: claimId,
      slice_id: params.task_id,
      attempt_id: `legacy-${claimId}`,
      timestamp: new Date().toISOString(),
      checks,
      observations,
      criterion_satisfaction: satisfiable
        ? params.criteria.map((criterionId) => ({
            criterion_id: criterionId,
            evidence_refs: [itemId],
            kind: checks.length > 0 ? "replayable" : "observed",
          }))
        : [],
      provenance: {
        spec_sections_read: [],
        clarifications_used: [],
        files_inspected: [],
        planner_assumptions: [],
      },
      risk: {
        files_modified: [],
        irreversible_actions: [],
        deps_added: [],
        external_calls: [],
      },
      source: "legacy_record_verification",
    };
    this.repo.writeEvidenceClaim(claim);
    return claim;
  }

  private normalizeEvidenceClaim(params: {
    task_id: string;
    attempt_id?: string;
    executor_id?: string;
    at_commit?: string;
    diff_ref?: string;
    checks?: unknown[];
    observations?: unknown[];
    criterion_satisfaction?: unknown[];
    provenance?: unknown;
    risk?: unknown;
  }): EvidenceClaim {
    const claimId = `evidence-${crypto.randomUUID().slice(0, 8)}`;
    const checks = (params.checks ?? [])
      .map((item, index) => this.normalizeCheck(item, index))
      .filter((item): item is EvidenceCheck => item !== null);
    const observations = (params.observations ?? [])
      .map((item, index) => this.normalizeObservation(item, index))
      .filter((item): item is EvidenceObservation => item !== null);
    const satisfaction = (params.criterion_satisfaction ?? [])
      .map((item) => this.normalizeCriterionSatisfaction(item))
      .filter((item): item is CriterionSatisfaction => item !== null);
    const provenance = this.asRecord(params.provenance);
    const risk = this.asRecord(params.risk);

    return {
      id: claimId,
      slice_id: params.task_id,
      attempt_id: params.attempt_id ?? `attempt-${claimId}`,
      executor_id: params.executor_id,
      timestamp: new Date().toISOString(),
      at_commit: params.at_commit,
      diff_ref: params.diff_ref,
      checks,
      observations,
      criterion_satisfaction: satisfaction,
      provenance: {
        spec_sections_read: this.stringArray(provenance.spec_sections_read),
        clarifications_used: this.stringArray(provenance.clarifications_used),
        files_inspected: this.normalizeFilesInspected(provenance.files_inspected),
        planner_assumptions: this.stringArray(provenance.planner_assumptions),
      },
      risk: {
        files_modified: this.stringArray(risk.files_modified),
        public_surface_delta:
          typeof risk.public_surface_delta === "string" ? risk.public_surface_delta : undefined,
        irreversible_actions: uniqueStrings([
          ...this.stringArray(risk.irreversible_actions),
          ...this.classifyIrreversibleFromChecks(checks),
        ]),
        deps_added: this.stringArray(risk.deps_added),
        external_calls: this.stringArray(risk.external_calls),
      },
      source: "submit_evidence_claim",
    };
  }

  private validateEvidenceClaim(claim: EvidenceClaim): void {
    if (claim.checks.length === 0 && claim.observations.length === 0) {
      throw codedError(
        "invalid_evidence",
        "EvidenceClaim requires at least one check or observation.",
      );
    }

    const refs = [
      claim.diff_ref,
      ...claim.checks.map((check) => check.output_ref),
      ...claim.observations.map((observation) => observation.captured_data_ref),
      ...claim.risk.files_modified,
    ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    const invalidRefs = this.invalidArtifactRefs(refs);
    if (invalidRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidRefs.join(", ")}.`,
      );
    }

    const evidenceItems = new Map<string, EvidenceCheck | EvidenceObservation>();
    for (const check of claim.checks) evidenceItems.set(check.id, check);
    for (const observation of claim.observations) evidenceItems.set(observation.id, observation);

    const knownCriteria = new Set(
      this.repo.loadAcceptanceCriteria(claim.slice_id).map((criterion) => criterion.id),
    );
    const unknownCriteria = claim.criterion_satisfaction
      .map((satisfaction) => satisfaction.criterion_id)
      .filter((id) => !knownCriteria.has(id));
    if (unknownCriteria.length > 0) {
      throw codedError(
        "unknown_criterion",
        `Criterion ids not declared on slice ${claim.slice_id}: ${unknownCriteria.join(", ")}.`,
      );
    }

    for (const satisfaction of claim.criterion_satisfaction) {
      if (satisfaction.evidence_refs.length === 0) {
        throw codedError(
          "invalid_evidence",
          `Criterion ${satisfaction.criterion_id} must reference at least one evidence item.`,
        );
      }
      let hasReplayable = false;
      for (const ref of satisfaction.evidence_refs) {
        const item = evidenceItems.get(ref);
        if (!item) {
          throw codedError("invalid_evidence", `Unknown evidence item reference: ${ref}.`);
        }
        if (item.verification === "self_attested") {
          throw codedError(
            "invalid_evidence",
            `Self-attested evidence ${ref} cannot satisfy criterion ${satisfaction.criterion_id}.`,
          );
        }
        if (
          item.verification === "replayable" &&
          "exit_code" in item &&
          item.exit_code !== 0
        ) {
          throw codedError(
            "failing_evidence",
            `Replayable check ${ref} (exit ${item.exit_code}) cannot satisfy criterion ${satisfaction.criterion_id}.`,
          );
        }
        if (item.verification === "replayable") hasReplayable = true;
      }
      if (satisfaction.kind === "replayable" && !hasReplayable) {
        throw codedError(
          "criterion_kind_mismatch",
          `Criterion ${satisfaction.criterion_id} declared kind=replayable but no referenced evidence is replayable.`,
        );
      }
    }
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

  private maybeOpenSliceGate(taskId: string) {
    const definition = this.repo.loadTaskDefinition(taskId);
    if (!definition?.requires_slice_gate) {
      return null;
    }
    const missing = this.missingAcceptanceCriteria(taskId);
    if (missing.length > 0) {
      return null;
    }
    const resolver = this.drift?.hasBlockingGuardrailForSlice(taskId)
      ? "user"
      : definition.slice_gate_resolver;
    const claims = this.repo.listEvidenceClaims(taskId);
    const evidenceRefs = claims.flatMap((claim) => [
      claim.id,
      ...claim.checks.map((check) => check.id),
      ...claim.observations.map((observation) => observation.id),
    ]);
    return this.gates.openGate({
      gate_type: "slice_gate",
      resolver,
      subject_ref: `slice:${taskId}`,
      summary: `Accept completed evidence for slice ${taskId}.`,
      evidence_refs: uniqueStrings(evidenceRefs),
    });
  }

  private invalidArtifactRefs(refs: string[]): string[] {
    const blobRefs = refs.filter((ref) => ref.startsWith("blob:"));
    const missingBlobs = blobRefs.filter((ref) => {
      const id = ref.slice("blob:".length);
      return !existsSync(this.repo.blobPath(id));
    });
    return [
      ...missingBlobs,
      ...this.repo.invalidEvidenceRefs(refs.filter((ref) => !ref.startsWith("blob:"))),
    ];
  }

  private normalizeCheck(value: unknown, index: number): EvidenceCheck | null {
    const record = this.asRecord(value);
    const command = this.stringValue(record.command);
    if (!command) return null;
    const outputRef =
      this.stringValue(record.output_ref) ??
      this.writeOptionalBlob(record.output, `check-${index + 1}`);
    return {
      id: this.stringValue(record.id) ?? `check-${index + 1}`,
      type: this.normalizeCheckType(this.stringValue(record.type)),
      command,
      exit_code: this.numberValue(record.exit_code) ?? 0,
      output_ref: outputRef,
      duration_ms: this.numberValue(record.duration_ms),
      verification: record.verification === "self_attested" ? "self_attested" : "replayable",
    };
  }

  private normalizeObservation(value: unknown, index: number): EvidenceObservation | null {
    const record = this.asRecord(value);
    const description = this.stringValue(record.description);
    if (!description) return null;
    const capturedDataRef =
      this.stringValue(record.captured_data_ref) ??
      this.writeOptionalBlob(record.captured_data, `observation-${index + 1}`);
    return {
      id: this.stringValue(record.id) ?? `observation-${index + 1}`,
      type: this.stringValue(record.type) ?? "observation",
      description,
      captured_data_ref: capturedDataRef,
      replay_recipe: this.stringValue(record.replay_recipe),
      verification: "observed",
    };
  }

  private normalizeCriterionSatisfaction(value: unknown): CriterionSatisfaction | null {
    const record = this.asRecord(value);
    const criterionId = this.stringValue(record.criterion_id);
    if (!criterionId) return null;
    return {
      criterion_id: criterionId,
      evidence_refs: this.stringArray(record.evidence_refs),
      kind: record.kind === "observed" ? "observed" : "replayable",
    };
  }

  private normalizeFilesInspected(value: unknown): Array<{ path: string; commit?: string }> {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => this.asRecord(item))
      .map((item) => ({
        path: this.stringValue(item.path) ?? "",
        commit: this.stringValue(item.commit),
      }))
      .filter((item) => item.path.length > 0);
  }

  private normalizeCheckType(value: unknown): EvidenceCheck["type"] {
    switch (value) {
      case "test":
      case "typecheck":
      case "lint":
      case "build":
      case "custom":
        return value;
      default:
        return "custom";
    }
  }

  private writeOptionalBlob(value: unknown, prefix: string): string | undefined {
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
    const blobId = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    return this.repo.writeBlob(blobId, value);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  }

  private classifyIrreversibleFromChecks(checks: EvidenceCheck[]): string[] {
    const out: string[] = [];
    for (const check of checks) {
      const label = classifyIrreversibleCommand(check.command);
      if (label) out.push(label);
    }
    return out;
  }
}

import type { PrecedentsCoordinator } from "./precedents";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type {
  ProtocolMessage,
  ProtocolMessageKind,
  ProtocolMessageResolution,
  ProtocolMessageSpecQuestion,
  ProtocolRole,
  SpecQuestionClass,
} from "./types";

export interface MessagesDeps {
  repo: OrchestrationRepository;
  precedents?: PrecedentsCoordinator;
  refresh: () => void;
}

const PRECEDENT_POLICY_REF = "policy:spec_question:precedent_high_match:v1";

function normalizeRole(value: unknown, fallback: ProtocolRole): ProtocolRole {
  switch (value) {
    case "user":
    case "resolver":
    case "spec-agent":
    case "planner":
    case "executor":
    case "orchestrator":
      return value;
    default:
      return fallback;
  }
}

function normalizeKind(value: unknown): ProtocolMessageKind {
  switch (value) {
    case "SpecQuestion":
    case "SpecRevisionProposal":
    case "PlanRevisionProposal":
    case "EscalationRequest":
    case "EvidenceClaim":
    case "GoalRevision":
      return value;
    default:
      throw codedError(
        "invalid_message_kind",
        `Unsupported protocol message kind: ${String(value)}`,
      );
  }
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))]
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort();
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSpecQuestionClass(value: unknown): SpecQuestionClass | undefined {
  if (value === undefined) return undefined;
  if (value === "lookup" || value === "inference" || value === "judgment" || value === "conflict") {
    return value;
  }
  throw codedError("invalid_spec_question", `Unsupported question class: ${String(value)}`);
}

function assertAllowedDirection(
  kind: ProtocolMessageKind,
  from: ProtocolRole,
  to: ProtocolRole,
): void {
  const allowed =
    (kind === "SpecQuestion" && from === "planner" && to === "spec-agent") ||
    (kind === "SpecRevisionProposal" &&
      from === "spec-agent" &&
      (to === "user" || to === "resolver")) ||
    (kind === "PlanRevisionProposal" &&
      from === "planner" &&
      (to === "user" || to === "resolver")) ||
    (kind === "EscalationRequest" && from === "executor" && to === "planner") ||
    (kind === "EvidenceClaim" && from === "executor" && to === "orchestrator") ||
    (kind === "GoalRevision" && (to === "user" || to === "resolver"));

  if (!allowed) {
    throw codedError("invalid_message_direction", `${kind} cannot be sent from ${from} to ${to}.`);
  }
}

export class MessagesCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly precedents: PrecedentsCoordinator | undefined;
  private readonly refresh: () => void;

  constructor(deps: MessagesDeps) {
    this.repo = deps.repo;
    this.precedents = deps.precedents;
    this.refresh = deps.refresh;
  }

  async submitMessage(params: {
    kind: unknown;
    from_role: unknown;
    to_role: unknown;
    summary: string;
    body?: string;
    artifact_refs?: string[];
    evidence_refs?: string[];
    question_class?: unknown;
    project_id?: unknown;
    goal_id?: unknown;
    spec_version_at_creation?: unknown;
    spec_sections_referenced?: unknown;
    code_areas?: unknown;
    auto_resolve_with_precedent?: unknown;
  }): Promise<ProtocolMessage> {
    const kind = normalizeKind(params.kind);
    const from = normalizeRole(params.from_role, "orchestrator");
    const to = normalizeRole(params.to_role, "user");
    assertAllowedDirection(kind, from, to);

    const timestamp = new Date().toISOString();
    const id = `msg-${crypto.randomUUID().slice(0, 8)}`;
    const specQuestion = this.buildSpecQuestionMetadata(kind, params);
    const precedentResolution = await this.maybeResolveSpecQuestion({
      specQuestion,
      summary: params.summary,
      body: params.body,
      resolvedAt: timestamp,
    });
    const resolution = precedentResolution?.resolution;
    const caseMatches = this.lookupCaseRecordMatches(specQuestion, params.summary);
    const messageSpecQuestion = specQuestion
      ? {
          ...specQuestion,
          ...(precedentResolution?.attempt
            ? { precedent_resolution_attempt: precedentResolution.attempt }
            : {}),
          ...(caseMatches.length > 0 ? { case_record_matches: caseMatches } : {}),
        }
      : undefined;
    const artifactRefs = params.artifact_refs ?? [];
    const precedentRef = resolution?.precedent_id ?? precedentResolution?.attempt?.precedent_id;
    const message: ProtocolMessage = {
      id,
      kind,
      version: this.repo.bumpMessageVersion(id),
      from_role: from,
      to_role: to,
      artifact_refs: [
        ...artifactRefs,
        ...(precedentRef ? [`precedent:${precedentRef}`] : []),
      ].filter((ref, index, refs) => refs.indexOf(ref) === index),
      evidence_refs: params.evidence_refs ?? [],
      status: resolution ? "resolved" : "open",
      summary: params.summary,
      body: params.body,
      spec_question: messageSpecQuestion,
      resolution,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.repo.writeMessage(message);
    this.refresh();
    return message;
  }

  private buildSpecQuestionMetadata(
    kind: ProtocolMessageKind,
    params: {
      question_class?: unknown;
      project_id?: unknown;
      goal_id?: unknown;
      spec_version_at_creation?: unknown;
      spec_sections_referenced?: unknown;
      code_areas?: unknown;
      auto_resolve_with_precedent?: unknown;
    },
  ): ProtocolMessageSpecQuestion | undefined {
    if (kind !== "SpecQuestion") {
      return undefined;
    }
    const questionClass = normalizeSpecQuestionClass(params.question_class);
    const autoResolve = params.auto_resolve_with_precedent === true;
    if (!questionClass && !autoResolve) {
      return undefined;
    }
    if (!questionClass) {
      throw codedError(
        "invalid_spec_question",
        "question_class is required when auto_resolve_with_precedent is true.",
      );
    }
    const specSections = normalizeStringList(params.spec_sections_referenced);
    const codeAreas = normalizeStringList(params.code_areas);
    if (specSections.length === 0 || codeAreas.length === 0) {
      throw codedError(
        "invalid_spec_question",
        "SpecQuestion precedent matching requires non-empty spec_sections_referenced and code_areas.",
      );
    }
    return {
      question_class: questionClass,
      project_id: normalizeString(params.project_id) ?? "local",
      goal_id: normalizeString(params.goal_id),
      spec_version_at_creation: normalizeNumber(params.spec_version_at_creation),
      spec_sections_referenced: specSections,
      code_areas: codeAreas,
      auto_resolve_with_precedent: autoResolve || undefined,
    };
  }

  private async maybeResolveSpecQuestion(params: {
    specQuestion: ProtocolMessageSpecQuestion | undefined;
    summary: string;
    body?: string;
    resolvedAt: string;
  }): Promise<
    | {
        resolution?: ProtocolMessageResolution;
        attempt?: NonNullable<ProtocolMessageSpecQuestion["precedent_resolution_attempt"]>;
      }
    | undefined
  > {
    const specQuestion = params.specQuestion;
    if (
      !specQuestion?.auto_resolve_with_precedent ||
      !this.precedents ||
      (specQuestion.question_class !== "lookup" && specQuestion.question_class !== "inference")
    ) {
      return undefined;
    }

    const resolved = await this.precedents.resolveSpecQuestionWithPrecedent({
      project_id: specQuestion.project_id,
      question_class: specQuestion.question_class,
      spec_sections_referenced: specQuestion.spec_sections_referenced,
      code_areas: specQuestion.code_areas,
      question: normalizeString(params.body) ?? params.summary,
    });
    if (!resolved) {
      return undefined;
    }

    const evidenceRefs =
      resolved.evidence_refs && resolved.evidence_refs.length > 0
        ? [
            ...new Set([
              ...(resolved.precedent.resolution.evidence_refs ?? []),
              ...resolved.evidence_refs,
            ]),
          ]
        : (resolved.precedent.resolution.evidence_refs ?? []);
    const policyRef = resolved.policy_ref ?? PRECEDENT_POLICY_REF;
    const attempt = {
      decision: resolved.status === "resolved" ? ("accepted" as const) : ("escalated" as const),
      policy_ref: policyRef,
      precedent_id: resolved.precedent.id,
      match_score: resolved.match.score,
      match_band: resolved.match.band,
      match_score_source: resolved.match.score_source,
      structural_keys: resolved.match.structural_keys,
      reasoning: resolved.reasoning ?? resolved.precedent.resolution.reasoning,
      evidence_refs: evidenceRefs,
      decided_at: params.resolvedAt,
    };

    if (resolved.status === "escalated") {
      return { attempt };
    }

    return {
      attempt,
      resolution: {
        decided_by: "policy",
        answer: resolved.precedent.resolution.answer,
        reasoning: resolved.reasoning ?? resolved.precedent.resolution.reasoning,
        evidence_refs: evidenceRefs,
        policy_ref: policyRef,
        precedent_id: resolved.precedent.id,
        match_score: resolved.match.score,
        match_band: resolved.match.band,
        match_score_source: resolved.match.score_source,
        structural_keys: resolved.match.structural_keys,
        resolved_at: params.resolvedAt,
      },
    };
  }

  private lookupCaseRecordMatches(
    specQuestion: ProtocolMessageSpecQuestion | undefined,
    question: string,
  ): NonNullable<ProtocolMessageSpecQuestion["case_record_matches"]> {
    if (
      !this.precedents ||
      !specQuestion ||
      (specQuestion.question_class !== "judgment" && specQuestion.question_class !== "conflict")
    ) {
      return [];
    }
    try {
      return this.precedents.findCaseRecordMatches({
        project_id: specQuestion.project_id,
        question_class: specQuestion.question_class,
        spec_sections_referenced: specQuestion.spec_sections_referenced,
        code_areas: specQuestion.code_areas,
        question,
      }).matches;
    } catch {
      return [];
    }
  }
}

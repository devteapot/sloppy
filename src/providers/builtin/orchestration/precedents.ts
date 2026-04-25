import { debug } from "../../../core/debug";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type {
  CaseRecord,
  CaseRecordMatch,
  CaseRecordQuestionClass,
  Precedent,
  PrecedentDecidedBy,
  PrecedentEmbeddingInput,
  PrecedentEmbeddingProvider,
  PrecedentMatch,
  PrecedentMatchBand,
  PrecedentMatchScoreSource,
  PrecedentQuestionClass,
  PrecedentRaisedByRole,
  PrecedentTieBreaker,
  SpecQuestionClass,
} from "./types";

export interface PrecedentsDeps {
  repo: OrchestrationRepository;
  tieBreaker?: PrecedentTieBreaker;
  embeddingProvider?: PrecedentEmbeddingProvider;
  refresh: () => void;
}

const HIGH_PRECEDENT_POLICY_REF = "policy:spec_question:precedent_high_match:v1";
const HIGH_MATCH_SCORE = 0.9;
const LOW_MATCH_SCORE = 0.65;
const BORDERLINE_TIEBREAK_POLICY_REF = "policy:spec_question:precedent_borderline_tiebreak:v1";
const INFERENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type PrecedentResolveOutcome =
  | {
      status: "resolved";
      precedent: Precedent;
      match: PrecedentMatch;
      policy_ref?: string;
      reasoning?: string;
      evidence_refs?: string[];
    }
  | {
      status: "escalated";
      precedent: Precedent;
      match: PrecedentMatch;
      policy_ref?: string;
      reasoning?: string;
      evidence_refs?: string[];
    };

function normalizeSpecQuestionClass(value: unknown): SpecQuestionClass {
  switch (value) {
    case "lookup":
    case "inference":
    case "judgment":
    case "conflict":
      return value;
    default:
      throw codedError("invalid_question_class", `Unsupported question class: ${String(value)}`);
  }
}

function normalizePrecedentClass(value: unknown): PrecedentQuestionClass {
  const questionClass = normalizeSpecQuestionClass(value);
  if (questionClass === "lookup" || questionClass === "inference") {
    return questionClass;
  }
  throw codedError(
    "invalid_precedent_class",
    "Only lookup and inference questions can become auto-resolvable precedents.",
  );
}

function normalizeCaseRecordClass(value: unknown): CaseRecordQuestionClass {
  const questionClass = normalizeSpecQuestionClass(value);
  if (questionClass === "judgment" || questionClass === "conflict") {
    return questionClass;
  }
  throw codedError(
    "invalid_case_record_class",
    "Only judgment and conflict questions can become case records.",
  );
}

function normalizeRaisedByRole(value: unknown): PrecedentRaisedByRole {
  return value === "executor" ? "executor" : "planner";
}

function normalizeDecidedBy(value: unknown): PrecedentDecidedBy {
  switch (value) {
    case "policy":
    case "supervisor_agent":
      return value;
    default:
      return "user";
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

function normalizeEmbedding(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const embedding = value.filter((item): item is number => typeof item === "number");
  if (embedding.length !== value.length || embedding.some((item) => !Number.isFinite(item))) {
    return undefined;
  }
  return embedding.length > 0 ? embedding : undefined;
}

function requireString(value: unknown, field: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw codedError("invalid_precedent", `${field} must be a non-empty string.`);
  }
  return normalized;
}

function requireStructuralKeys(params: {
  spec_sections_referenced?: unknown;
  code_areas?: unknown;
}): { specSections: string[]; codeAreas: string[] } {
  const specSections = normalizeStringList(params.spec_sections_referenced);
  const codeAreas = normalizeStringList(params.code_areas);
  if (specSections.length === 0) {
    throw codedError(
      "invalid_structural_keys",
      "spec_sections_referenced must include at least one spec section.",
    );
  }
  if (codeAreas.length === 0) {
    throw codedError("invalid_structural_keys", "code_areas must include at least one code area.");
  }
  return { specSections, codeAreas };
}

function canonicalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 1));
}

function overlap(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return Number((intersection / union.size).toFixed(4));
}

function cosineSimilarity(left: number[], right: number[]): number | undefined {
  if (left.length === 0 || left.length !== right.length) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined;
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Number(Math.max(0, Math.min(1, score)).toFixed(4));
}

function matchBand(score: number): PrecedentMatchBand {
  if (score >= HIGH_MATCH_SCORE) return "high";
  if (score >= LOW_MATCH_SCORE) return "borderline";
  return "low";
}

function expiresAtFor(
  questionClass: PrecedentQuestionClass,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (questionClass !== "inference") return undefined;
  return new Date(Date.now() + INFERENCE_TTL_MS).toISOString();
}

function isExpired(record: Precedent, now: string): boolean {
  return record.health.expires_at !== undefined && record.health.expires_at <= now;
}

export class PrecedentsCoordinator {
  private readonly repo: OrchestrationRepository;
  private tieBreaker: PrecedentTieBreaker | undefined;
  private embeddingProvider: PrecedentEmbeddingProvider | undefined;
  private readonly refresh: () => void;

  constructor(deps: PrecedentsDeps) {
    this.repo = deps.repo;
    this.tieBreaker = deps.tieBreaker;
    this.embeddingProvider = deps.embeddingProvider;
    this.refresh = deps.refresh;
  }

  setEmbeddingProvider(provider: PrecedentEmbeddingProvider | undefined): void {
    this.embeddingProvider = provider;
  }

  setTieBreaker(tieBreaker: PrecedentTieBreaker | undefined): void {
    this.tieBreaker = tieBreaker;
  }

  async createPrecedent(params: {
    project_id?: unknown;
    goal_id?: unknown;
    spec_version_at_creation?: unknown;
    question_class: unknown;
    spec_sections_referenced?: unknown;
    code_areas?: unknown;
    question: unknown;
    canonical_summary?: unknown;
    raised_by_role?: unknown;
    decided_by?: unknown;
    answer: unknown;
    reasoning?: unknown;
    evidence_refs?: unknown;
    expires_at?: unknown;
    embedding?: unknown;
  }): Promise<Precedent> {
    const questionClass = normalizePrecedentClass(params.question_class);
    const { specSections, codeAreas } = requireStructuralKeys(params);
    const question = requireString(params.question, "question");
    const answer = requireString(params.answer, "answer");
    const projectId = normalizeString(params.project_id) ?? "local";
    const canonicalSummary = canonicalizeQuestion(
      normalizeString(params.canonical_summary) ?? question,
    );
    const embedding =
      normalizeEmbedding(params.embedding) ??
      (await this.tryCreateEmbedding({
        project_id: projectId,
        question_class: questionClass,
        spec_sections_referenced: specSections,
        code_areas: codeAreas,
        question,
        canonical_summary: canonicalSummary,
      }));
    const timestamp = new Date().toISOString();
    const id = `precedent-${crypto.randomUUID().slice(0, 8)}`;
    const precedent: Precedent = {
      id,
      created_at: timestamp,
      use_count: 0,
      context: {
        project_id: projectId,
        goal_id: normalizeString(params.goal_id),
        spec_version_at_creation:
          typeof params.spec_version_at_creation === "number" &&
          Number.isFinite(params.spec_version_at_creation)
            ? params.spec_version_at_creation
            : undefined,
        question_class: questionClass,
        spec_sections_referenced: specSections,
        code_areas: codeAreas,
      },
      question: {
        text: question,
        canonical_summary: canonicalSummary,
        raised_by_role: normalizeRaisedByRole(params.raised_by_role),
        embedding,
      },
      resolution: {
        decided_by: normalizeDecidedBy(params.decided_by),
        answer,
        reasoning: normalizeString(params.reasoning),
        evidence_refs: normalizeStringList(params.evidence_refs),
      },
      health: {
        matches_promoted: 0,
        matches_escalated_anyway: 0,
        contradicted: false,
        expires_at: expiresAtFor(questionClass, normalizeString(params.expires_at)),
      },
    };
    const version = this.repo.bumpPrecedentVersion(id);
    const created = { ...precedent, version };
    this.repo.writePrecedent(created);
    this.refresh();
    return created;
  }

  createCaseRecord(params: {
    project_id?: unknown;
    goal_id?: unknown;
    spec_version_at_creation?: unknown;
    question_class: unknown;
    spec_sections_referenced?: unknown;
    code_areas?: unknown;
    question: unknown;
    canonical_summary?: unknown;
    raised_by_role?: unknown;
    decided_by?: unknown;
    answer: unknown;
    reasoning?: unknown;
    evidence_refs?: unknown;
  }): CaseRecord {
    const questionClass = normalizeCaseRecordClass(params.question_class);
    const { specSections, codeAreas } = requireStructuralKeys(params);
    const question = requireString(params.question, "question");
    const answer = requireString(params.answer, "answer");
    const timestamp = new Date().toISOString();
    const id = `case-${crypto.randomUUID().slice(0, 8)}`;
    const record: CaseRecord = {
      id,
      created_at: timestamp,
      use_count: 0,
      context: {
        project_id: normalizeString(params.project_id) ?? "local",
        goal_id: normalizeString(params.goal_id),
        spec_version_at_creation:
          typeof params.spec_version_at_creation === "number" &&
          Number.isFinite(params.spec_version_at_creation)
            ? params.spec_version_at_creation
            : undefined,
        question_class: questionClass,
        spec_sections_referenced: specSections,
        code_areas: codeAreas,
      },
      question: {
        text: question,
        canonical_summary: canonicalizeQuestion(
          normalizeString(params.canonical_summary) ?? question,
        ),
        raised_by_role: normalizeRaisedByRole(params.raised_by_role),
      },
      resolution: {
        decided_by: normalizeDecidedBy(params.decided_by),
        answer,
        reasoning: normalizeString(params.reasoning),
        evidence_refs: normalizeStringList(params.evidence_refs),
      },
    };
    const version = this.repo.bumpCaseRecordVersion(id);
    const created = { ...record, version };
    this.repo.writeCaseRecord(created);
    this.refresh();
    return created;
  }

  async findPrecedentMatches(params: {
    project_id?: unknown;
    question_class: unknown;
    spec_sections_referenced?: unknown;
    code_areas?: unknown;
    question: unknown;
  }): Promise<{ matches: PrecedentMatch[]; high_threshold: number; low_threshold: number }> {
    const projectId = normalizeString(params.project_id) ?? "local";
    const questionClass = normalizePrecedentClass(params.question_class);
    const { specSections, codeAreas } = requireStructuralKeys(params);
    const question = requireString(params.question, "question");
    const canonical = canonicalizeQuestion(question);
    const queryEmbedding = await this.tryCreateEmbedding({
      project_id: projectId,
      question_class: questionClass,
      spec_sections_referenced: specSections,
      code_areas: codeAreas,
      question,
      canonical_summary: canonical,
    });
    const now = new Date().toISOString();

    const matches = this.repo
      .listPrecedents()
      .filter((precedent) => {
        if (precedent.context.project_id !== projectId) return false;
        if (precedent.context.question_class !== questionClass) return false;
        if (precedent.health.contradicted || precedent.health.invalidated_by) return false;
        if (isExpired(precedent, now)) return false;
        return (
          overlap(precedent.context.spec_sections_referenced, specSections).length > 0 &&
          overlap(precedent.context.code_areas, codeAreas).length > 0
        );
      })
      .map((precedent): PrecedentMatch => {
        const { score, source } = this.scorePrecedent({
          canonical,
          queryEmbedding,
          precedent,
        });
        return {
          precedent_id: precedent.id,
          score,
          score_source: source,
          band: matchBand(score),
          auto_resolvable: score >= HIGH_MATCH_SCORE,
          structural_keys: {
            project_id: projectId,
            question_class: questionClass,
            spec_sections_referenced: overlap(
              precedent.context.spec_sections_referenced,
              specSections,
            ),
            code_areas: overlap(precedent.context.code_areas, codeAreas),
          },
        };
      })
      .sort((a, b) => b.score - a.score);

    return { matches, high_threshold: HIGH_MATCH_SCORE, low_threshold: LOW_MATCH_SCORE };
  }

  async resolveSpecQuestionWithPrecedent(params: {
    project_id?: unknown;
    question_class: unknown;
    spec_sections_referenced?: unknown;
    code_areas?: unknown;
    question: unknown;
  }): Promise<PrecedentResolveOutcome | null> {
    const { matches } = await this.findPrecedentMatches(params);
    const highMatch = matches.find((candidate) => candidate.auto_resolvable);
    if (highMatch) {
      const promoted = this.promotePrecedentMatch(highMatch);
      return promoted
        ? { ...promoted, status: "resolved", policy_ref: HIGH_PRECEDENT_POLICY_REF }
        : null;
    }

    const borderlineMatch = matches.find((candidate) => candidate.band === "borderline");
    if (!borderlineMatch || !this.tieBreaker) {
      return null;
    }

    const precedent = this.repo.loadPrecedent(borderlineMatch.precedent_id);
    if (!precedent) {
      return null;
    }
    const question = requireString(params.question, "question");
    const decision = await this.tieBreaker({
      precedent,
      match: borderlineMatch,
      question: {
        text: question,
        canonical_summary: canonicalizeQuestion(question),
      },
    });
    if (!decision?.equivalent) {
      this.recordPrecedentUse({
        precedent_id: precedent.id,
        promoted: false,
      });
      return {
        status: "escalated",
        precedent,
        match: borderlineMatch,
        policy_ref: normalizeString(decision?.policy_ref) ?? BORDERLINE_TIEBREAK_POLICY_REF,
        reasoning: normalizeString(decision?.reasoning),
        evidence_refs: normalizeStringList(decision?.evidence_refs),
      };
    }

    const promoted = this.promotePrecedentMatch(borderlineMatch);
    if (!promoted) {
      return null;
    }
    return {
      ...promoted,
      status: "resolved",
      policy_ref: normalizeString(decision.policy_ref) ?? BORDERLINE_TIEBREAK_POLICY_REF,
      reasoning: normalizeString(decision.reasoning),
      evidence_refs: normalizeStringList(decision.evidence_refs),
    };
  }

  private promotePrecedentMatch(
    match: PrecedentMatch,
  ): { precedent: Precedent; match: PrecedentMatch } | null {
    const precedent = this.repo.loadPrecedent(match.precedent_id);
    if (!precedent) {
      return null;
    }
    const used = this.recordPrecedentUse({
      precedent_id: precedent.id,
      promoted: true,
    });
    return { precedent: "error" in used ? precedent : used, match };
  }

  private scorePrecedent(params: {
    canonical: string;
    queryEmbedding?: number[];
    precedent: Precedent;
  }): { score: number; source: PrecedentMatchScoreSource } {
    const precedentEmbedding = normalizeEmbedding(params.precedent.question.embedding);
    if (params.queryEmbedding && precedentEmbedding) {
      const score = cosineSimilarity(params.queryEmbedding, precedentEmbedding);
      if (score !== undefined) {
        return { score, source: "embedding" };
      }
    }
    return {
      score: textSimilarity(
        params.canonical,
        params.precedent.question.canonical_summary ??
          canonicalizeQuestion(params.precedent.question.text),
      ),
      source: "lexical",
    };
  }

  private async tryCreateEmbedding(input: PrecedentEmbeddingInput): Promise<number[] | undefined> {
    if (!this.embeddingProvider) {
      return undefined;
    }
    try {
      return normalizeEmbedding(await this.embeddingProvider(input));
    } catch (error) {
      debug("orchestration", "precedent_embedding_failed", {
        questionClass: input.question_class,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  findCaseRecordMatches(params: {
    project_id?: unknown;
    question_class: unknown;
    spec_sections_referenced?: unknown;
    code_areas?: unknown;
    question: unknown;
  }): { matches: CaseRecordMatch[] } {
    const projectId = normalizeString(params.project_id) ?? "local";
    const questionClass = normalizeCaseRecordClass(params.question_class);
    const { specSections, codeAreas } = requireStructuralKeys(params);
    const canonical = canonicalizeQuestion(requireString(params.question, "question"));

    const matches = this.repo
      .listCaseRecords()
      .filter((record) => {
        if (record.context.project_id !== projectId) return false;
        if (record.context.question_class !== questionClass) return false;
        return (
          overlap(record.context.spec_sections_referenced, specSections).length > 0 &&
          overlap(record.context.code_areas, codeAreas).length > 0
        );
      })
      .map(
        (record): CaseRecordMatch => ({
          case_record_id: record.id,
          score: textSimilarity(canonical, record.question.canonical_summary),
          structural_keys: {
            project_id: projectId,
            question_class: questionClass,
            spec_sections_referenced: overlap(
              record.context.spec_sections_referenced,
              specSections,
            ),
            code_areas: overlap(record.context.code_areas, codeAreas),
          },
        }),
      )
      .sort((a, b) => b.score - a.score);

    return { matches };
  }

  recordPrecedentUse(params: {
    precedent_id: string;
    promoted?: boolean;
    expected_version?: number;
  }): Precedent | { error: "version_conflict"; currentVersion: number } {
    const precedent = this.repo.loadPrecedent(params.precedent_id);
    if (!precedent) {
      throw codedError("unknown_precedent", `Unknown precedent: ${params.precedent_id}`);
    }
    const currentVersion = this.repo.precedentVersion(params.precedent_id);
    if (params.expected_version !== undefined && params.expected_version !== currentVersion) {
      return { error: "version_conflict", currentVersion };
    }
    const version = this.repo.bumpPrecedentVersion(precedent.id);
    const promoted = params.promoted ?? true;
    const next: Precedent = {
      ...precedent,
      last_used_at: new Date().toISOString(),
      use_count: precedent.use_count + 1,
      health: {
        ...precedent.health,
        matches_promoted: precedent.health.matches_promoted + (promoted ? 1 : 0),
        matches_escalated_anyway: precedent.health.matches_escalated_anyway + (promoted ? 0 : 1),
      },
      version,
    };
    this.repo.writePrecedent(next as Precedent & { version: number });
    this.refresh();
    return next;
  }

  contradictPrecedent(params: {
    precedent_id: string;
    expected_version?: number;
  }): Precedent | { error: "version_conflict"; currentVersion: number } {
    const precedent = this.repo.loadPrecedent(params.precedent_id);
    if (!precedent) {
      throw codedError("unknown_precedent", `Unknown precedent: ${params.precedent_id}`);
    }
    const currentVersion = this.repo.precedentVersion(params.precedent_id);
    if (params.expected_version !== undefined && params.expected_version !== currentVersion) {
      return { error: "version_conflict", currentVersion };
    }
    const version = this.repo.bumpPrecedentVersion(precedent.id);
    const next: Precedent = {
      ...precedent,
      health: {
        ...precedent.health,
        contradicted: true,
      },
      version,
    };
    this.repo.writePrecedent(next as Precedent & { version: number });
    this.refresh();
    return next;
  }

  recordCaseUse(params: {
    case_record_id: string;
    expected_version?: number;
  }): CaseRecord | { error: "version_conflict"; currentVersion: number } {
    const record = this.repo.loadCaseRecord(params.case_record_id);
    if (!record) {
      throw codedError("unknown_case_record", `Unknown case record: ${params.case_record_id}`);
    }
    const currentVersion = this.repo.caseRecordVersion(params.case_record_id);
    if (params.expected_version !== undefined && params.expected_version !== currentVersion) {
      return { error: "version_conflict", currentVersion };
    }
    const version = this.repo.bumpCaseRecordVersion(record.id);
    const next: CaseRecord = {
      ...record,
      last_used_at: new Date().toISOString(),
      use_count: record.use_count + 1,
      version,
    };
    this.repo.writeCaseRecord(next as CaseRecord & { version: number });
    this.refresh();
    return next;
  }

  invalidatePrecedents(params: { spec_revision_id: unknown; spec_sections_referenced?: unknown }): {
    invalidated_precedent_ids: string[];
  } {
    const specRevisionId = requireString(params.spec_revision_id, "spec_revision_id");
    const specSections = normalizeStringList(params.spec_sections_referenced);
    if (specSections.length === 0) {
      throw codedError(
        "invalid_structural_keys",
        "spec_sections_referenced must include at least one spec section.",
      );
    }

    const invalidated: string[] = [];
    for (const precedent of this.repo.listPrecedents()) {
      if (
        precedent.health.invalidated_by ||
        overlap(precedent.context.spec_sections_referenced, specSections).length === 0
      ) {
        continue;
      }
      const version = this.repo.bumpPrecedentVersion(precedent.id);
      this.repo.writePrecedent({
        ...precedent,
        health: {
          ...precedent.health,
          invalidated_by: specRevisionId,
        },
        version,
      });
      invalidated.push(precedent.id);
    }
    this.refresh();
    return { invalidated_precedent_ids: invalidated.sort() };
  }
}

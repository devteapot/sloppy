import type {
  ExperimentEvaluation,
  MetaScope,
  Proposal,
  TopologyExperiment,
} from "./meta-runtime-model";
import { asString } from "./meta-runtime-ops";

function optionalScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("promotion_criteria.min_score must be a number between 0 and 1.");
  }
  return value;
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("promotion_criteria.required_evaluations must be a positive integer.");
  }
  return value;
}

export function createExperiment(
  scope: MetaScope,
  proposal: Proposal,
  params: Record<string, unknown>,
): TopologyExperiment {
  const criteria =
    params.promotion_criteria &&
    typeof params.promotion_criteria === "object" &&
    !Array.isArray(params.promotion_criteria)
      ? (params.promotion_criteria as Record<string, unknown>)
      : {};

  return {
    id: `experiment-${crypto.randomUUID()}`,
    scope,
    name: asString(params.name, "name"),
    proposalId: proposal.id,
    objective: asString(params.objective, "objective"),
    status: "candidate",
    createdAt: new Date().toISOString(),
    parentExperimentId:
      typeof params.parent_experiment_id === "string" ? params.parent_experiment_id : undefined,
    promotionCriteria: {
      minScore: optionalScore(criteria.min_score),
      requiredEvaluations: optionalCount(criteria.required_evaluations),
    },
  };
}

export function createEvaluation(
  experimentId: string,
  params: Record<string, unknown>,
): ExperimentEvaluation {
  const score = params.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("score must be a number between 0 and 1.");
  }

  return {
    id: `evaluation-${crypto.randomUUID()}`,
    experimentId,
    score,
    summary: asString(params.summary, "summary"),
    evaluator: typeof params.evaluator === "string" ? params.evaluator : undefined,
    evidence:
      params.evidence && typeof params.evidence === "object" && !Array.isArray(params.evidence)
        ? (params.evidence as Record<string, unknown>)
        : undefined,
    createdAt: new Date().toISOString(),
  };
}

export function experimentMeetsCriteria(
  experiment: TopologyExperiment,
  evaluations: ExperimentEvaluation[],
): boolean {
  const criteria = experiment.promotionCriteria ?? {};
  const requiredEvaluations = criteria.requiredEvaluations ?? 1;
  const minScore = criteria.minScore ?? 0;
  if (evaluations.length < requiredEvaluations) return false;
  return evaluations.some((evaluation) => evaluation.score >= minScore);
}

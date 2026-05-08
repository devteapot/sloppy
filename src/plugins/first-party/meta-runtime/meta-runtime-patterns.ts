import type {
  ExperimentEvaluation,
  MetaScope,
  Proposal,
  TopologyChange,
  TopologyExperiment,
  TopologyPattern,
} from "./meta-runtime-model";
import { parseChange } from "./meta-runtime-ops";

function asTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("tags must be an array of strings.");
  }
  return value;
}

function asTopologyOps(value: unknown, field: string): TopologyChange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of typed topology changes.`);
  }
  return value.map(parseChange);
}

export function buildTopologyPattern(options: {
  experiment: TopologyExperiment;
  proposal: Proposal;
  evaluations: ExperimentEvaluation[];
  params: Record<string, unknown>;
}): TopologyPattern {
  if (options.experiment.status !== "promoted") {
    throw new Error(
      `Experiment ${options.experiment.id} is ${options.experiment.status}, not promoted.`,
    );
  }
  if (options.proposal.status !== "applied") {
    throw new Error(`Proposal ${options.proposal.id} is ${options.proposal.status}, not applied.`);
  }
  const latestEvaluation = options.evaluations
    .filter((evaluation) => evaluation.experimentId === options.experiment.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return {
    id: `pattern-${crypto.randomUUID()}`,
    scope: options.experiment.scope,
    name:
      typeof options.params.name === "string" && options.params.name.trim() !== ""
        ? options.params.name
        : options.experiment.name,
    summary:
      typeof options.params.summary === "string"
        ? options.params.summary
        : options.proposal.summary,
    sourceExperimentId: options.experiment.id,
    sourceProposalId: options.proposal.id,
    ops: asTopologyOps(options.params.ops, "ops"),
    tags: asTags(options.params.tags),
    evidence: latestEvaluation
      ? {
          evaluation_id: latestEvaluation.id,
          score: latestEvaluation.score,
          summary: latestEvaluation.summary,
          evidence: latestEvaluation.evidence,
        }
      : undefined,
    createdAt: new Date().toISOString(),
    usageCount: 0,
  };
}

export function patternProposalParams(options: {
  pattern: TopologyPattern;
  scope: MetaScope;
  params: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    scope: options.scope,
    summary:
      typeof options.params.summary === "string" && options.params.summary.trim() !== ""
        ? options.params.summary
        : `Instantiate topology pattern ${options.pattern.name}`,
    rationale:
      typeof options.params.rationale === "string" && options.params.rationale.trim() !== ""
        ? options.params.rationale
        : `Reuses topology pattern ${options.pattern.id} archived from experiment ${options.pattern.sourceExperimentId}.`,
    ops: asTopologyOps(options.params.ops, "ops"),
    ttl_ms: options.params.ttl_ms,
  };
}

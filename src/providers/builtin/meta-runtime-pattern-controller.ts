import { createApprovalRequiredError, type ProviderApprovalManager } from "../approvals";
import type {
  ExperimentEvaluation,
  MetaEvent,
  MetaScope,
  Proposal,
  TopologyExperiment,
  TopologyPattern,
} from "./meta-runtime-model";
import { listById } from "./meta-runtime-model";
import { asScope, asString } from "./meta-runtime-ops";
import { buildTopologyPattern, patternProposalParams } from "./meta-runtime-patterns";

export type MetaRuntimePatternContext = {
  approvals: ProviderApprovalManager;
  patterns: Map<string, TopologyPattern>;
  proposals: Map<string, Proposal>;
  experiments: Map<string, TopologyExperiment>;
  evaluations: Map<string, ExperimentEvaluation>;
  proposeChange: (params: Record<string, unknown>) => Proposal;
  recordEvent: (event: Omit<MetaEvent, "id" | "createdAt">) => void;
  persist: (scope: MetaScope) => void;
  refresh: () => void;
};

export function archiveTopologyPattern(
  context: MetaRuntimePatternContext,
  params: Record<string, unknown>,
  approved = false,
): TopologyPattern {
  const experimentId = asString(params.experiment_id, "experiment_id");
  const experiment = context.experiments.get(experimentId);
  if (!experiment) {
    throw new Error(`Unknown experiment: ${experimentId}`);
  }
  const proposal = context.proposals.get(experiment.proposalId);
  if (!proposal) {
    throw new Error(
      `Experiment ${experimentId} references unknown proposal ${experiment.proposalId}.`,
    );
  }
  if (experiment.scope !== "session" && !approved) {
    const approvalId = context.approvals.request({
      path: "/session",
      action: "archive_topology_pattern",
      reason: `Archiving a ${experiment.scope} topology pattern writes persisted meta-runtime metadata.`,
      paramsPreview: JSON.stringify({
        experiment_id: experimentId,
        proposal_id: proposal.id,
        name: params.name,
      }),
      dangerous: true,
      execute: () => archiveTopologyPattern(context, params, true),
    });
    throw createApprovalRequiredError(
      `Archiving pattern for ${experiment.scope} experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
    );
  }
  const pattern = buildTopologyPattern({
    experiment,
    proposal,
    evaluations: listById(context.evaluations),
    params,
  });
  context.patterns.set(pattern.id, pattern);
  context.recordEvent({
    kind: "pattern.archived",
    scope: pattern.scope,
    proposalId: proposal.id,
    summary: `Archived topology pattern ${pattern.name}.`,
    metadata: {
      pattern_id: pattern.id,
      experiment_id: experiment.id,
    },
  });
  context.persist(pattern.scope);
  context.refresh();
  return pattern;
}

export function proposeFromPattern(
  context: MetaRuntimePatternContext,
  params: Record<string, unknown>,
): Proposal {
  const patternId = asString(params.pattern_id, "pattern_id");
  const pattern = context.patterns.get(patternId);
  if (!pattern) {
    throw new Error(`Unknown topology pattern: ${patternId}`);
  }
  const proposal = context.proposeChange(
    patternProposalParams({
      pattern,
      scope: asScope(params.scope),
      params,
    }),
  );
  context.recordEvent({
    kind: "pattern.instantiated",
    scope: proposal.scope,
    proposalId: proposal.id,
    summary: `Instantiated topology pattern ${pattern.name}.`,
    metadata: {
      pattern_id: pattern.id,
      source_experiment_id: pattern.sourceExperimentId,
    },
  });
  pattern.usageCount = (pattern.usageCount ?? 0) + 1;
  context.persist(pattern.scope);
  context.refresh();
  return proposal;
}

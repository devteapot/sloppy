import type { ProviderRuntimeHub } from "../../core/hub";
import { createApprovalRequiredError, type ProviderApprovalManager } from "../approvals";
import {
  createExperiment as buildExperiment,
  createEvaluation,
  experimentMeetsCriteria,
} from "./meta-runtime-experiments";
import type {
  ExperimentEvaluation,
  MetaEvent,
  MetaScope,
  MetaStateMaps,
  Proposal,
  TopologyExperiment,
} from "./meta-runtime-model";
import { listById } from "./meta-runtime-model";
import { asString } from "./meta-runtime-ops";

export type MetaRuntimeExperimentContext = {
  approvals: ProviderApprovalManager;
  hub: ProviderRuntimeHub | null;
  layers: Record<MetaScope, MetaStateMaps>;
  proposals: Map<string, Proposal>;
  experiments: Map<string, TopologyExperiment>;
  evaluations: Map<string, ExperimentEvaluation>;
  rebuildMergedState: () => void;
  applyProposal: (id: string, approved?: boolean) => Promise<Proposal>;
  recordEvent: (event: Omit<MetaEvent, "id" | "createdAt">) => void;
  persist: (scope: MetaScope) => void;
  refresh: () => void;
};

function now(): string {
  return new Date().toISOString();
}

export function createTopologyExperiment(
  context: MetaRuntimeExperimentContext,
  params: Record<string, unknown>,
  approved = false,
): TopologyExperiment {
  const proposalId = asString(params.proposal_id, "proposal_id");
  const proposal = context.proposals.get(proposalId);
  if (!proposal) {
    throw new Error(`Unknown proposal for experiment: ${proposalId}`);
  }
  if (proposal.scope !== "session" && !approved) {
    const approvalId = context.approvals.request({
      path: "/session",
      action: "create_experiment",
      reason: `Creating a ${proposal.scope} topology experiment writes persisted meta-runtime metadata.`,
      paramsPreview: JSON.stringify({
        proposal_id: proposalId,
        name: params.name,
        objective: params.objective,
      }),
      dangerous: true,
      execute: () => createTopologyExperiment(context, params, true),
    });
    throw createApprovalRequiredError(
      `Creating experiment for ${proposal.scope} proposal ${proposalId} requires approval via /approvals/${approvalId}.`,
    );
  }
  const experiment = buildExperiment(proposal.scope, proposal, params);
  context.layers[proposal.scope].experiments.set(experiment.id, experiment);
  context.rebuildMergedState();
  context.recordEvent({
    kind: "experiment.created",
    scope: experiment.scope,
    proposalId,
    summary: `Created topology experiment ${experiment.name}.`,
  });
  context.persist(experiment.scope);
  context.refresh();
  return experiment;
}

export function recordTopologyExperimentEvaluation(
  context: MetaRuntimeExperimentContext,
  params: Record<string, unknown>,
  approved = false,
): ExperimentEvaluation {
  const experimentId = asString(params.experiment_id, "experiment_id");
  const experiment = context.experiments.get(experimentId);
  if (!experiment) {
    throw new Error(`Unknown experiment: ${experimentId}`);
  }
  if (experiment.scope !== "session" && !approved) {
    const approvalId = context.approvals.request({
      path: "/session",
      action: "record_evaluation",
      reason: `Recording an evaluation for ${experiment.scope} experiment ${experimentId} writes persisted meta-runtime metadata.`,
      paramsPreview: JSON.stringify({
        experiment_id: experimentId,
        score: params.score,
        evaluator: params.evaluator,
      }),
      dangerous: true,
      execute: () => recordTopologyExperimentEvaluation(context, params, true),
    });
    throw createApprovalRequiredError(
      `Recording evaluation for ${experiment.scope} experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
    );
  }
  const evaluation = createEvaluation(experimentId, params);
  context.layers[experiment.scope].evaluations.set(evaluation.id, evaluation);
  context.rebuildMergedState();
  context.recordEvent({
    kind: "experiment.evaluated",
    scope: experiment.scope,
    proposalId: experiment.proposalId,
    summary: `Recorded evaluation ${evaluation.id} for ${experiment.name}.`,
  });
  context.persist(experiment.scope);
  context.refresh();
  return evaluation;
}

export async function promoteTopologyExperiment(
  context: MetaRuntimeExperimentContext,
  experimentId: string,
  approved = false,
): Promise<TopologyExperiment> {
  const experiment = context.experiments.get(experimentId);
  if (!experiment) {
    throw new Error(`Unknown experiment: ${experimentId}`);
  }
  if (experiment.status !== "candidate") {
    throw new Error(`Experiment ${experimentId} is already ${experiment.status}.`);
  }
  const evaluations = listById(context.evaluations).filter(
    (evaluation) => evaluation.experimentId === experiment.id,
  );
  if (!experimentMeetsCriteria(experiment, evaluations)) {
    throw new Error(`Experiment ${experimentId} does not meet promotion criteria.`);
  }
  const proposal = context.proposals.get(experiment.proposalId);
  if (!proposal) {
    throw new Error(
      `Experiment ${experimentId} references unknown proposal ${experiment.proposalId}.`,
    );
  }
  if (proposal.status !== "proposed" && proposal.status !== "applied") {
    throw new Error(
      `Experiment ${experimentId} references proposal ${proposal.id}, which is ${proposal.status}.`,
    );
  }
  if ((experiment.scope !== "session" || proposal.requiresApproval) && !approved) {
    const approvalId = context.approvals.request({
      path: "/session",
      action: "promote_experiment",
      reason: `Promoting experiment ${experimentId} applies or records privileged meta-runtime state.`,
      paramsPreview: JSON.stringify({
        experiment_id: experimentId,
        proposal_id: proposal.id,
        proposal_scope: proposal.scope,
        proposal_ops: proposal.ops.map((op) => op.type),
      }),
      dangerous: true,
      execute: () => promoteTopologyExperiment(context, experimentId, true),
    });
    throw createApprovalRequiredError(
      `Promoting experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
    );
  }
  if (proposal.status === "proposed") {
    await context.applyProposal(proposal.id, true);
  }
  const promoted = { ...experiment, status: "promoted" as const, promotedAt: now() };
  context.layers[experiment.scope].experiments.set(promoted.id, promoted);
  context.rebuildMergedState();
  context.recordEvent({
    kind: "experiment.promoted",
    scope: promoted.scope,
    proposalId: promoted.proposalId,
    summary: `Promoted topology experiment ${promoted.name}.`,
  });
  context.persist(promoted.scope);
  context.refresh();
  return promoted;
}

export async function markTopologyExperimentRolledBack(
  context: MetaRuntimeExperimentContext,
  params: Record<string, unknown>,
  approved = false,
): Promise<TopologyExperiment> {
  const experimentId = asString(params.experiment_id, "experiment_id");
  const experiment = context.experiments.get(experimentId);
  if (!experiment) {
    throw new Error(`Unknown experiment: ${experimentId}`);
  }
  if (experiment.status !== "promoted") {
    throw new Error(`Experiment ${experimentId} is ${experiment.status}, not promoted.`);
  }
  const rollbackProposalId =
    typeof params.rollback_proposal_id === "string" ? params.rollback_proposal_id : undefined;
  const rollbackProposal = rollbackProposalId
    ? context.proposals.get(rollbackProposalId)
    : undefined;
  if (rollbackProposalId && !rollbackProposal) {
    throw new Error(`Unknown rollback proposal: ${rollbackProposalId}`);
  }
  if (
    rollbackProposal &&
    rollbackProposal.status !== "proposed" &&
    rollbackProposal.status !== "applied"
  ) {
    throw new Error(
      `Rollback proposal ${rollbackProposal.id} is ${rollbackProposal.status}, not proposed or applied.`,
    );
  }
  if (
    (experiment.scope !== "session" || rollbackProposal?.requiresApproval === true) &&
    !approved
  ) {
    const approvalId = context.approvals.request({
      path: "/session",
      action: "rollback_experiment",
      reason: `Rolling back experiment ${experimentId} applies or records privileged meta-runtime state.`,
      paramsPreview: JSON.stringify({
        experiment_id: experimentId,
        rollback_proposal_id: rollbackProposalId,
        experiment_scope: experiment.scope,
      }),
      dangerous: true,
      execute: () => markTopologyExperimentRolledBack(context, params, true),
    });
    throw createApprovalRequiredError(
      `Rolling back experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
    );
  }
  if (rollbackProposal?.status === "proposed") {
    await context.applyProposal(rollbackProposal.id, true);
  }
  const rolledBack = {
    ...experiment,
    status: "rolled_back" as const,
    rolledBackAt: now(),
    rollbackProposalId,
  };
  context.layers[experiment.scope].experiments.set(rolledBack.id, rolledBack);
  context.rebuildMergedState();
  context.recordEvent({
    kind: "experiment.rolled_back",
    scope: rolledBack.scope,
    proposalId: rolledBack.proposalId,
    summary: `Marked topology experiment ${rolledBack.name} as rolled back.`,
  });
  context.persist(rolledBack.scope);
  context.refresh();
  return rolledBack;
}

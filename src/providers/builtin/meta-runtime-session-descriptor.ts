import { action } from "@slop-ai/server";

import type { MetaScope, PersistedState, Proposal, TopologyExperiment } from "./meta-runtime-model";
import { asScope } from "./meta-runtime-ops";

export type MetaRuntimeSessionDescriptorContext = {
  counts: {
    agents: number;
    profiles: number;
    channels: number;
    routes: number;
    experiments: number;
    proposals: number;
    patterns: number;
    pendingProposals: number;
  };
  globalRoot: string;
  workspaceRoot: string;
  proposeChange: (params: Record<string, unknown>) => Proposal;
  dispatchRoute: (params: Record<string, unknown>) => unknown;
  createExperiment: (params: Record<string, unknown>) => TopologyExperiment;
  recordEvaluation: (params: Record<string, unknown>) => unknown;
  promoteExperiment: (params: Record<string, unknown>) => unknown;
  rollbackExperiment: (params: Record<string, unknown>) => unknown;
  archiveTopologyPattern: (params: Record<string, unknown>) => unknown;
  proposeFromPattern: (params: Record<string, unknown>) => unknown;
  exportState: (scope?: MetaScope) => unknown;
  importState: (scope: MetaScope, state: PersistedState, mode: "merge" | "replace") => unknown;
};

export function buildMetaRuntimeSessionDescriptor(context: MetaRuntimeSessionDescriptorContext) {
  return {
    type: "context",
    props: {
      agents_count: context.counts.agents,
      profiles_count: context.counts.profiles,
      channels_count: context.counts.channels,
      routes_count: context.counts.routes,
      experiments_count: context.counts.experiments,
      proposals_count: context.counts.proposals,
      patterns_count: context.counts.patterns,
      pending_proposals_count: context.counts.pendingProposals,
      global_root: context.globalRoot,
      workspace_root: context.workspaceRoot,
      strategy_surface: "skills",
    },
    summary:
      "Meta-runtime topology substrate: graph, channels, routes, skills, experiments, proposals, and pattern records. Reusable strategy lives in skills.",
    actions: {
      propose_change: action(
        {
          summary: "string",
          scope: {
            type: "string",
            enum: ["session", "workspace", "global"],
            optional: true,
          },
          rationale: {
            type: "string",
            optional: true,
          },
          ttl_ms: {
            type: "number",
            optional: true,
          },
          ops: {
            type: "array",
            description: "Typed TopologyChange operations.",
            items: { type: "object", additionalProperties: true },
          },
        },
        (params) => context.proposeChange(params),
        {
          label: "Propose Change",
          description: "Record a proposed change to the agent communication topology.",
          estimate: "fast",
        },
      ),
      dispatch_route: action(
        {
          source: "string",
          message: "string",
          envelope: {
            type: "object",
            description:
              "Optional typed route envelope: { id?, source?, body, topic?, channelId?, inReplyTo?, causationId?, metadata? }.",
            optional: true,
          },
          fanout: {
            type: "boolean",
            optional: true,
          },
        },
        (params) => context.dispatchRoute(params),
        {
          label: "Dispatch Route",
          description:
            "Route a typed message envelope through active meta-runtime routes to delegated agents or messaging channels.",
          estimate: "fast",
        },
      ),
      create_experiment: action(
        {
          proposal_id: "string",
          name: "string",
          objective: "string",
          parent_experiment_id: {
            type: "string",
            optional: true,
          },
          promotion_criteria: {
            type: "object",
            optional: true,
          },
        },
        (params) => context.createExperiment(params),
        {
          label: "Create Experiment",
          description: "Attach a topology proposal to an evaluable experiment before promotion.",
          estimate: "fast",
        },
      ),
      record_evaluation: action(
        {
          experiment_id: "string",
          score: "number",
          summary: "string",
          evaluator: {
            type: "string",
            optional: true,
          },
          evidence: {
            type: "object",
            optional: true,
          },
        },
        (params) => context.recordEvaluation(params),
        {
          label: "Record Evaluation",
          description: "Record scored evidence for a topology experiment.",
          estimate: "fast",
        },
      ),
      promote_experiment: action(
        {
          experiment_id: "string",
          evaluation_id: {
            type: "string",
            optional: true,
          },
        },
        (params) => context.promoteExperiment(params),
        {
          label: "Promote Experiment",
          description:
            "Mark an experiment promoted after an evaluator records evidence, applying its proposal if needed.",
          dangerous: true,
          estimate: "fast",
        },
      ),
      rollback_experiment: action(
        {
          experiment_id: "string",
          rollback_proposal_id: {
            type: "string",
            optional: true,
          },
        },
        (params) => context.rollbackExperiment(params),
        {
          label: "Rollback Experiment",
          description:
            "Mark a promoted experiment as rolled back, applying a pending rollback proposal when provided.",
          dangerous: true,
          estimate: "fast",
        },
      ),
      archive_topology_pattern: action(
        {
          experiment_id: "string",
          name: {
            type: "string",
            optional: true,
          },
          summary: {
            type: "string",
            optional: true,
          },
          tags: {
            type: "array",
            items: { type: "string" },
            optional: true,
          },
          ops: {
            type: "array",
            description:
              "Explicit typed TopologyChange operations to archive. Supply these from a topology-pattern skill; they are not inferred from the source proposal.",
            items: { type: "object", additionalProperties: true },
          },
        },
        (params) => context.archiveTopologyPattern(params),
        {
          label: "Archive Topology Pattern",
          description:
            "Archive explicit topology operations as a reusable pattern linked to a promoted experiment.",
          estimate: "fast",
        },
      ),
      propose_from_pattern: action(
        {
          pattern_id: "string",
          scope: {
            type: "string",
            enum: ["session", "workspace", "global"],
            optional: true,
          },
          summary: {
            type: "string",
            optional: true,
          },
          rationale: {
            type: "string",
            optional: true,
          },
          ttl_ms: {
            type: "number",
            optional: true,
          },
          ops: {
            type: "array",
            description:
              "Explicit typed TopologyChange operations adapted from the pattern for the current graph.",
            items: { type: "object", additionalProperties: true },
          },
        },
        (params) => context.proposeFromPattern(params),
        {
          label: "Propose From Pattern",
          description:
            "Create a normal topology proposal from a pattern using explicit adapted operations.",
          estimate: "fast",
        },
      ),
      export_state: action(
        {
          scope: {
            type: "string",
            enum: ["merged", "workspace", "global"],
            optional: true,
          },
        },
        ({ scope }) =>
          context.exportState(scope === "workspace" || scope === "global" ? scope : undefined),
        {
          label: "Export State",
          description: "Export merged, workspace, or global meta-runtime state.",
          idempotent: true,
          estimate: "instant",
        },
      ),
      import_state: action(
        {
          scope: {
            type: "string",
            enum: ["session", "workspace", "global"],
          },
          mode: {
            type: "string",
            enum: ["merge", "replace"],
            optional: true,
          },
          state: {
            type: "object",
            description: "Meta-runtime state previously returned by export_state.",
          },
        },
        ({ scope, mode, state }) =>
          context.importState(
            asScope(scope),
            (state && typeof state === "object" ? state : {}) as PersistedState,
            mode === "replace" ? "replace" : "merge",
          ),
        {
          label: "Import State",
          description:
            "Import meta-runtime state. Persistent scopes require approval before writing.",
          dangerous: true,
          estimate: "fast",
        },
      ),
    },
    meta: {
      focus: true,
      salience: 0.85,
    },
  };
}

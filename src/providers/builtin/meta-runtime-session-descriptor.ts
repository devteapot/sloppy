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
  analyzeRuntimeTrace: (params: Record<string, unknown>) => unknown;
  prepareArchitectBrief: (params: Record<string, unknown>) => unknown;
  startArchitectCycle: (params: Record<string, unknown>) => unknown;
  deriveProposalsFromEvents: (params: Record<string, unknown>) => unknown;
  startEvolutionCycle: (params: Record<string, unknown>) => unknown;
  createExperiment: (params: Record<string, unknown>) => TopologyExperiment;
  recordEvaluation: (params: Record<string, unknown>) => unknown;
  recordExperimentEvidence: (params: Record<string, unknown>) => unknown;
  promoteExperiment: (experimentId: string) => unknown;
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
    },
    summary:
      "Meta-runtime topology: agent graph, channels, routes, skills, experiments, and proposals.",
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
      analyze_runtime_trace: action(
        {
          limit: {
            type: "number",
            optional: true,
          },
        },
        (params) => context.analyzeRuntimeTrace(params),
        {
          label: "Analyze Runtime Trace",
          description:
            "Summarize recent SLOP route, proposal, and experiment events into coordination smells.",
          estimate: "fast",
        },
      ),
      prepare_architect_brief: action(
        {
          objective: {
            type: "string",
            optional: true,
          },
          limit: {
            type: "number",
            optional: true,
          },
        },
        (params) => context.prepareArchitectBrief(params),
        {
          label: "Prepare Architect Brief",
          description:
            "Build a trace-backed prompt and affordance map for an agent-authored topology proposal.",
          estimate: "fast",
        },
      ),
      start_architect_cycle: action(
        {
          objective: {
            type: "string",
            optional: true,
          },
          name: {
            type: "string",
            optional: true,
          },
          limit: {
            type: "number",
            optional: true,
          },
          executor: {
            type: "object",
            optional: true,
          },
        },
        (params) => context.startArchitectCycle(params),
        {
          label: "Start Architect Cycle",
          description:
            "Spawn a runtime architect agent with a trace-backed SLOP brief; the agent authors proposals through normal affordances.",
          dangerous: true,
          estimate: "fast",
        },
      ),
      derive_proposals_from_events: action(
        {
          scope: {
            type: "string",
            enum: ["session", "workspace", "global"],
            optional: true,
          },
          min_events: {
            type: "number",
            optional: true,
          },
          limit: {
            type: "number",
            optional: true,
          },
        },
        (params) => context.deriveProposalsFromEvents(params),
        {
          label: "Derive Proposals",
          description:
            "Inspect recent meta-runtime events and create topology proposals for recognized failure patterns.",
          estimate: "fast",
        },
      ),
      start_evolution_cycle: action(
        {
          min_events: {
            type: "number",
            optional: true,
          },
          limit: {
            type: "number",
            optional: true,
          },
        },
        (params) => context.startEvolutionCycle(params),
        {
          label: "Start Evolution Cycle",
          description:
            "Derive trace-backed topology proposals from recent events and attach each proposal to a session experiment.",
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
      record_experiment_evidence: action(
        {
          experiment_id: "string",
          window_ms: {
            type: "number",
            optional: true,
          },
        },
        (params) => context.recordExperimentEvidence(params),
        {
          label: "Record Experiment Evidence",
          description:
            "Score a topology experiment from observed route events before and after its proposal pivot.",
          estimate: "fast",
        },
      ),
      promote_experiment: action(
        {
          experiment_id: "string",
        },
        ({ experiment_id }) => context.promoteExperiment(String(experiment_id)),
        {
          label: "Promote Experiment",
          description:
            "Promote an experiment whose evaluations satisfy its criteria, applying its proposal if needed.",
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
            optional: true,
          },
        },
        (params) => context.archiveTopologyPattern(params),
        {
          label: "Archive Topology Pattern",
          description:
            "Archive a promoted experiment's applied topology changes as a reusable pattern.",
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
        },
        (params) => context.proposeFromPattern(params),
        {
          label: "Propose From Pattern",
          description: "Create a normal topology proposal by instantiating an archived pattern.",
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

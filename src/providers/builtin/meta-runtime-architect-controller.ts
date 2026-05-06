import type { ProviderRuntimeHub } from "../../core/hub";
import {
  buildExperimentEvidenceEvaluation,
  buildRuntimeArchitectBrief,
  buildRuntimeTraceAnalysis,
} from "./meta-runtime-analysis";
import type {
  AgentChannel,
  AgentNode,
  ExperimentEvaluation,
  MetaEvent,
  Proposal,
  RouteRule,
  TopologyExperiment,
} from "./meta-runtime-model";
import { listById } from "./meta-runtime-model";
import { asString, optionalNonNegativeInteger } from "./meta-runtime-ops";

export type MetaRuntimeArchitectContext = {
  hub: ProviderRuntimeHub | null;
  events: MetaEvent[];
  routes: Map<string, RouteRule>;
  channels: Map<string, AgentChannel>;
  agents: Map<string, AgentNode>;
  proposals: Map<string, Proposal>;
  experiments: Map<string, TopologyExperiment>;
  evaluations: Map<string, ExperimentEvaluation>;
  recordEvaluation: (params: Record<string, unknown>, approved?: boolean) => ExperimentEvaluation;
  recordEvent: (event: Omit<MetaEvent, "id" | "createdAt">) => void;
  refresh: () => void;
};

export function analyzeRuntimeTrace(
  context: MetaRuntimeArchitectContext,
  params: Record<string, unknown>,
) {
  const limit = Math.max(optionalNonNegativeInteger(params.limit, "limit") ?? 100, 1);
  return buildRuntimeTraceAnalysis({
    events: context.events,
    routes: listById(context.routes),
    channels: listById(context.channels),
    agents: listById(context.agents),
    proposals: listById(context.proposals),
    experiments: listById(context.experiments),
    evaluations: listById(context.evaluations),
    limit,
  });
}

export function prepareArchitectBrief(
  context: MetaRuntimeArchitectContext,
  params: Record<string, unknown>,
) {
  return buildRuntimeArchitectBrief({
    objective: typeof params.objective === "string" ? params.objective : undefined,
    analysis: analyzeRuntimeTrace(context, params),
  });
}

export async function startRuntimeArchitectCycle(
  context: MetaRuntimeArchitectContext,
  params: Record<string, unknown>,
) {
  if (!context.hub) {
    throw new Error("start_architect_cycle requires the meta-runtime provider to be attached.");
  }
  const brief = prepareArchitectBrief(context, params);
  const result = await context.hub.invoke("delegation", "/session", "spawn_agent", {
    name:
      typeof params.name === "string" && params.name.trim() !== ""
        ? params.name
        : "Runtime Architect",
    goal: brief.prompt,
    ...(params.executor && typeof params.executor === "object"
      ? { executor: params.executor }
      : {}),
    routeEnvelope: {
      source: "meta-runtime",
      body: brief.objective,
      topic: "runtime-architecture",
      metadata: {
        analysis_generated_at: brief.analysis.generatedAt,
        smell_count: brief.analysis.smells.length,
      },
    },
  });
  if (result.status === "error") {
    throw new Error(result.error?.message ?? "Failed to spawn runtime architect.");
  }
  context.recordEvent({
    kind: "architect.spawned",
    scope: "session",
    summary: "Spawned a runtime architect agent for trace-backed topology evolution.",
    metadata: {
      objective: brief.objective,
      smell_count: brief.analysis.smells.length,
    },
  });
  context.refresh();
  return { spawn: result.data, brief };
}

export function recordExperimentEvidence(
  context: MetaRuntimeArchitectContext,
  params: Record<string, unknown>,
  approved = false,
): ExperimentEvaluation {
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
  const windowMs = Math.max(
    optionalNonNegativeInteger(params.window_ms, "window_ms") ?? 24 * 60 * 60 * 1000,
    1,
  );
  return context.recordEvaluation(
    buildExperimentEvidenceEvaluation({
      experiment,
      proposal,
      events: context.events,
      windowMs,
    }),
    approved,
  );
}

import type {
  AgentChannel,
  AgentNode,
  ExperimentEvaluation,
  MetaEvent,
  Proposal,
  RouteRule,
  TopologyExperiment,
} from "./meta-runtime-model";

export type CoordinationSmell = {
  id: string;
  kind:
    | "repeated_route_failure"
    | "unmatched_traffic"
    | "orphan_agent"
    | "pending_proposal_backlog"
    | "unevaluated_experiment";
  severity: "low" | "medium" | "high";
  summary: string;
  evidence: Record<string, unknown>;
  suggestedAction: string;
};

export type RuntimeTraceAnalysis = {
  generatedAt: string;
  window: {
    limit: number;
    eventCount: number;
  };
  metrics: {
    routeDispatched: number;
    routeFailed: number;
    routeUnmatched: number;
    proposalsCreated: number;
    proposalsApplied: number;
    experimentsCreated: number;
    byReasonCode: Record<string, number>;
    byRouteId: Record<string, number>;
  };
  smells: CoordinationSmell[];
  topology: {
    agents: number;
    activeAgents: number;
    channels: number;
    routes: number;
    enabledRoutes: number;
    proposals: number;
    pendingProposals: number;
    experiments: number;
    candidateExperiments: number;
  };
};

export type RuntimeArchitectBrief = {
  objective: string;
  prompt: string;
  analysis: RuntimeTraceAnalysis;
  affordances: string[];
  allowedTopologyChanges: string[];
};

function metadataString(event: MetaEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function increment(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function groupEvents(
  events: MetaEvent[],
  kind: string,
  keyFor: (event: MetaEvent) => string | undefined,
): Map<string, MetaEvent[]> {
  const groups = new Map<string, MetaEvent[]>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const key = keyFor(event);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return groups;
}

export function buildRuntimeTraceAnalysis(options: {
  events: MetaEvent[];
  routes: RouteRule[];
  channels: AgentChannel[];
  agents: AgentNode[];
  proposals: Proposal[];
  experiments: TopologyExperiment[];
  evaluations: ExperimentEvaluation[];
  limit: number;
}): RuntimeTraceAnalysis {
  const recentEvents = options.events.slice(-options.limit);
  const byReasonCode: Record<string, number> = {};
  const byRouteId: Record<string, number> = {};

  for (const event of recentEvents) {
    increment(byReasonCode, metadataString(event, "reason_code"));
    increment(byRouteId, event.routeId ?? metadataString(event, "route_id"));
  }

  const smells: CoordinationSmell[] = [];
  for (const [routeId, failures] of groupEvents(
    recentEvents,
    "route.failed",
    (event) => event.routeId ?? metadataString(event, "route_id"),
  )) {
    if (failures.length < 2) continue;
    smells.push({
      id: `smell-route-failure-${routeId}`,
      kind: "repeated_route_failure",
      severity: failures.length >= 4 ? "high" : "medium",
      summary: `Route ${routeId} failed ${failures.length} times in the recent trace window.`,
      evidence: {
        route_id: routeId,
        event_ids: failures.map((event) => event.id),
        reason_codes: failures.map((event) => metadataString(event, "reason_code")),
      },
      suggestedAction:
        "Inspect the route target and propose a narrow topology repair or canary replacement route.",
    });
  }

  for (const [source, unmatched] of groupEvents(recentEvents, "route.unmatched", (event) =>
    metadataString(event, "source"),
  )) {
    if (unmatched.length < 2) continue;
    smells.push({
      id: `smell-unmatched-${source}`,
      kind: "unmatched_traffic",
      severity: unmatched.length >= 4 ? "high" : "medium",
      summary: `${source} produced ${unmatched.length} unmatched messages.`,
      evidence: {
        source,
        event_ids: unmatched.map((event) => event.id),
        topics: unmatched.map((event) => metadataString(event, "topic")).filter(Boolean),
      },
      suggestedAction:
        "Propose a triage specialist or narrower route that handles the recurring unmatched traffic.",
    });
  }

  const routedAgentIds = new Set(
    options.routes
      .map((route) =>
        route.target.startsWith("agent:") ? route.target.slice("agent:".length) : "",
      )
      .filter(Boolean),
  );
  const channelParticipants = new Set(options.channels.flatMap((channel) => channel.participants));
  for (const agent of options.agents) {
    if (agent.status !== "active") continue;
    if (routedAgentIds.has(agent.id) || channelParticipants.has(agent.id)) continue;
    smells.push({
      id: `smell-orphan-agent-${agent.id}`,
      kind: "orphan_agent",
      severity: "low",
      summary: `Active agent ${agent.id} is not targeted by any route or channel.`,
      evidence: { agent_id: agent.id, profile_id: agent.profileId },
      suggestedAction:
        "Route useful traffic to the agent, attach it to a channel, or retire it if it is stale.",
    });
  }

  const pendingProposals = options.proposals.filter((proposal) => proposal.status === "proposed");
  if (pendingProposals.length >= 3) {
    smells.push({
      id: "smell-pending-proposal-backlog",
      kind: "pending_proposal_backlog",
      severity: "medium",
      summary: `${pendingProposals.length} topology proposals are still pending.`,
      evidence: { proposal_ids: pendingProposals.map((proposal) => proposal.id) },
      suggestedAction:
        "Evaluate, apply, or revert pending proposals before generating more topology churn.",
    });
  }

  const evaluatedExperimentIds = new Set(
    options.evaluations.map((evaluation) => evaluation.experimentId),
  );
  const unevaluated = options.experiments.filter(
    (experiment) => experiment.status === "candidate" && !evaluatedExperimentIds.has(experiment.id),
  );
  if (unevaluated.length > 0) {
    smells.push({
      id: "smell-unevaluated-experiments",
      kind: "unevaluated_experiment",
      severity: "low",
      summary: `${unevaluated.length} candidate experiments have no recorded evidence.`,
      evidence: { experiment_ids: unevaluated.map((experiment) => experiment.id) },
      suggestedAction:
        "Record evidence for candidates before promotion or archive the failed line of work.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    window: {
      limit: options.limit,
      eventCount: recentEvents.length,
    },
    metrics: {
      routeDispatched: recentEvents.filter((event) => event.kind === "route.dispatched").length,
      routeFailed: recentEvents.filter((event) => event.kind === "route.failed").length,
      routeUnmatched: recentEvents.filter((event) => event.kind === "route.unmatched").length,
      proposalsCreated: recentEvents.filter((event) => event.kind === "proposal.created").length,
      proposalsApplied: recentEvents.filter((event) => event.kind === "proposal.applied").length,
      experimentsCreated: recentEvents.filter((event) => event.kind === "experiment.created")
        .length,
      byReasonCode,
      byRouteId,
    },
    smells,
    topology: {
      agents: options.agents.length,
      activeAgents: options.agents.filter((agent) => agent.status === "active").length,
      channels: options.channels.length,
      routes: options.routes.length,
      enabledRoutes: options.routes.filter((route) => route.enabled).length,
      proposals: options.proposals.length,
      pendingProposals: pendingProposals.length,
      experiments: options.experiments.length,
      candidateExperiments: options.experiments.filter(
        (experiment) => experiment.status === "candidate",
      ).length,
    },
  };
}

export function buildRuntimeArchitectBrief(options: {
  objective?: string;
  analysis: RuntimeTraceAnalysis;
}): RuntimeArchitectBrief {
  const objective =
    options.objective ??
    "Improve the internal agent-to-agent communication topology using recent SLOP trace evidence.";
  const affordances = [
    "Query /events, /routes, /channels, /agents, /profiles, /experiments, and /proposals.",
    "Call /session propose_change with validated TopologyChange[] when a topology change is warranted.",
    "Call /session create_experiment for each proposal that should be trialed before promotion.",
    "Call /session record_experiment_evidence after a proposal has real trace evidence.",
    "Use route.traffic.sampleRate for canary routes instead of replacing all traffic at once.",
  ];
  const allowedTopologyChanges = [
    "upsertAgentProfile",
    "spawnAgent",
    "retireAgent",
    "upsertChannel",
    "rewireChannel",
    "upsertRoute",
    "setCapabilityMask",
    "setExecutorBinding",
    "activateSkillVersion",
    "deactivateSkillVersion",
  ];
  const smellSummary =
    options.analysis.smells.length === 0
      ? "No strong coordination smells were detected in the recent trace window."
      : options.analysis.smells.map((smell) => `- [${smell.severity}] ${smell.summary}`).join("\n");

  return {
    objective,
    analysis: options.analysis,
    affordances,
    allowedTopologyChanges,
    prompt: [
      "You are the runtime architect for this SLOP-native agent runtime.",
      objective,
      "",
      "Keep the kernel lean: use SLOP state and affordances instead of inventing orchestration in the runtime.",
      "Only propose topology changes backed by trace evidence. Prefer session-scoped canaries before persistent topology changes.",
      "",
      "Recent coordination smells:",
      smellSummary,
      "",
      "Available affordances:",
      ...affordances.map((entry) => `- ${entry}`),
      "",
      `Allowed topology change types: ${allowedTopologyChanges.join(", ")}.`,
      "If no topology change is justified, report that clearly instead of creating churn.",
    ].join("\n"),
  };
}

type RouteEventCounts = {
  total: number;
  dispatched: number;
  failed: number;
  unmatched: number;
};

function countRouteEvents(events: MetaEvent[]): RouteEventCounts {
  const dispatched = events.filter((event) => event.kind === "route.dispatched").length;
  const failed = events.filter((event) => event.kind === "route.failed").length;
  const unmatched = events.filter((event) => event.kind === "route.unmatched").length;
  return {
    total: dispatched + failed + unmatched,
    dispatched,
    failed,
    unmatched,
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

export function buildExperimentEvidenceEvaluation(options: {
  experiment: TopologyExperiment;
  proposal: Proposal;
  events: MetaEvent[];
  windowMs: number;
}): {
  experiment_id: string;
  score: number;
  summary: string;
  evaluator: string;
  evidence: Record<string, unknown>;
} {
  const appliedAt = options.proposal.appliedAt ?? options.experiment.createdAt;
  const pivot = Date.parse(appliedAt);
  if (!Number.isFinite(pivot)) {
    throw new Error(`Experiment ${options.experiment.id} has an invalid evidence pivot date.`);
  }
  const beforeStart = pivot - options.windowMs;
  const afterEnd = pivot + options.windowMs;
  const now = Date.now();
  const beforeEvents = options.events.filter((event) => {
    const time = Date.parse(event.createdAt);
    return Number.isFinite(time) && time >= beforeStart && time < pivot;
  });
  const afterEvents = options.events.filter((event) => {
    const time = Date.parse(event.createdAt);
    return Number.isFinite(time) && time >= pivot && time <= Math.min(afterEnd, now);
  });
  const before = countRouteEvents(beforeEvents);
  const after = countRouteEvents(afterEvents);
  const beforeBadRate = before.total > 0 ? (before.failed + before.unmatched) / before.total : 0.5;
  const afterBadRate = after.total > 0 ? (after.failed + after.unmatched) / after.total : 0.5;
  const afterSuccessRate = after.total > 0 ? after.dispatched / after.total : 0;
  const improvement = Math.max(0, beforeBadRate - afterBadRate);
  const score = after.total === 0 ? 0.5 : clampScore(afterSuccessRate * 0.65 + improvement * 0.35);

  return {
    experiment_id: options.experiment.id,
    score,
    evaluator: "meta-runtime",
    summary:
      after.total === 0
        ? "No route traffic was observed after the experiment pivot; recorded neutral evidence."
        : `Recorded ${after.dispatched}/${after.total} successful route deliveries after the experiment pivot.`,
    evidence: {
      proposal_id: options.proposal.id,
      pivot: appliedAt,
      window_ms: options.windowMs,
      before,
      after,
      before_bad_rate: beforeBadRate,
      after_bad_rate: afterBadRate,
      improvement,
    },
  };
}

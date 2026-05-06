import type {
  AgentChannel,
  AgentNode,
  MetaEvent,
  Proposal,
  RouteRule,
  TopologyChange,
} from "./meta-runtime-model";

export type DerivedEvolutionKind =
  | "repair_channel_participants"
  | "retarget_route_to_repair_agent"
  | "create_triage_agent_route"
  | "disable_failing_route";

export type DerivedTopologyProposal = {
  kind: DerivedEvolutionKind;
  summary: string;
  rationale: string;
  ops: TopologyChange[];
  sourceEventIds: string[];
  experiment: {
    name: string;
    objective: string;
    promotionCriteria: {
      min_score: number;
      required_evaluations: number;
    };
  };
};

function metadataString(event: MetaEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function routeIdFromEvent(event: MetaEvent): string | undefined {
  return event.routeId ?? metadataString(event, "route_id");
}

function slug(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "runtime";
}

function groupBy<T>(items: T[], keyFor: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function alreadyProposed(summary: string, proposals: Proposal[]): boolean {
  return proposals.some(
    (proposal) => proposal.status === "proposed" && proposal.summary === summary,
  );
}

function sourceFor(route: RouteRule, failure: MetaEvent): string | undefined {
  const source = metadataString(failure, "source");
  if (source) return source;
  return route.source !== "*" ? route.source : undefined;
}

function repairAgentOps(route: RouteRule, failures: MetaEvent[]): TopologyChange[] {
  const idBase = slug(route.id);
  const profileId = `evolution-${idBase}-handler`;
  const agentId = `agent-${profileId}`;
  return [
    {
      type: "upsertAgentProfile",
      profile: {
        id: profileId,
        name: `Evolution handler for ${route.id}`,
        instructions: [
          `Handle messages routed through ${route.id}.`,
          "Inspect the route envelope, answer the sender's immediate need, and propose a better long-term topology if this fallback keeps receiving traffic.",
          `Recent failure count: ${failures.length}.`,
        ].join(" "),
      },
    },
    {
      type: "spawnAgent",
      agent: {
        id: agentId,
        profileId,
        status: "active",
        channels: [],
        capabilityMaskIds: [],
      },
    },
    {
      type: "upsertRoute",
      route: {
        ...route,
        target: `agent:${agentId}`,
        enabled: true,
      },
    },
  ];
}

function triageRouteOps(
  source: string,
  topic: string | undefined,
  count: number,
): TopologyChange[] {
  const sourceSlug = slug(source);
  const topicSlug = slug(topic ?? "general");
  const profileId = `evolution-${sourceSlug}-${topicSlug}-triage`;
  const agentId = `agent-${profileId}`;
  return [
    {
      type: "upsertAgentProfile",
      profile: {
        id: profileId,
        name: `Triage for ${source}`,
        instructions: [
          `Handle previously unmatched messages from ${source}.`,
          topic ? `Prioritize topic "${topic}".` : "Infer the topic from each route envelope.",
          "If a recurring specialist emerges, propose a narrower route and specialist profile.",
          `Recent unmatched message count: ${count}.`,
        ].join(" "),
      },
    },
    {
      type: "spawnAgent",
      agent: {
        id: agentId,
        profileId,
        status: "active",
        channels: [],
        capabilityMaskIds: [],
      },
    },
    {
      type: "upsertRoute",
      route: {
        id: `evolution-${sourceSlug}-${topicSlug}-route`,
        source,
        match: "*",
        target: `agent:${agentId}`,
        enabled: true,
        priority: 0,
      },
    },
  ];
}

function deriveFailureProposal(options: {
  route: RouteRule;
  channel?: AgentChannel;
  failures: MetaEvent[];
  proposals: Proposal[];
}): DerivedTopologyProposal | null {
  const { route, failures, proposals } = options;
  const lastFailure = failures[failures.length - 1];
  if (!lastFailure) return null;
  const reasonCode = metadataString(lastFailure, "reason_code");

  if (reasonCode === "channel_missing_participant" && options.channel) {
    const source = sourceFor(route, lastFailure);
    if (source && !options.channel.participants.includes(source)) {
      const summary = `Add ${source} to channel ${options.channel.id} for route ${route.id}`;
      if (alreadyProposed(summary, proposals)) return null;
      return {
        kind: "repair_channel_participants",
        summary,
        rationale: [
          `Derived from ${failures.length} recent route.failed events.`,
          `Route ${route.id} targets channel ${options.channel.id}, but ${source} could not send there.`,
        ].join(" "),
        ops: [
          {
            type: "rewireChannel",
            channelId: options.channel.id,
            participants: [...new Set([...options.channel.participants, source])].sort(),
          },
        ],
        sourceEventIds: failures.map((event) => event.id),
        experiment: {
          name: `Repair channel ${options.channel.id}`,
          objective: `Verify that route ${route.id} can deliver messages from ${source} after channel membership changes.`,
          promotionCriteria: { min_score: 0.7, required_evaluations: 1 },
        },
      };
    }
  }

  if (
    reasonCode === "agent_inactive" ||
    reasonCode === "unknown_agent" ||
    reasonCode === "agent_missing_profile" ||
    reasonCode === "agent_missing_executor" ||
    (reasonCode === "target_invoke_error" &&
      metadataString(lastFailure, "provider") === "delegation")
  ) {
    const summary = `Retarget failing route ${route.id} to an evolution handler`;
    if (alreadyProposed(summary, proposals)) return null;
    return {
      kind: "retarget_route_to_repair_agent",
      summary,
      rationale: [
        `Derived from ${failures.length} recent route.failed events.`,
        `Route ${route.id} could not reach its agent target, so this creates a fallback specialist and retargets the route.`,
      ].join(" "),
      ops: repairAgentOps(route, failures),
      sourceEventIds: failures.map((event) => event.id),
      experiment: {
        name: `Fallback agent for ${route.id}`,
        objective: `Verify that the fallback specialist handles traffic for failing route ${route.id}.`,
        promotionCriteria: { min_score: 0.7, required_evaluations: 1 },
      },
    };
  }

  const summary = `Disable failing route ${route.id}`;
  if (alreadyProposed(summary, proposals)) return null;
  return {
    kind: "disable_failing_route",
    summary,
    rationale: [
      `Derived from ${failures.length} recent route.failed events.`,
      "No safe targeted repair was recognized, so disabling the route stops repeated failed dispatches while agents decide on a better topology.",
    ].join(" "),
    ops: [
      {
        type: "upsertRoute",
        route: {
          ...route,
          enabled: false,
        },
      },
    ],
    sourceEventIds: failures.map((event) => event.id),
    experiment: {
      name: `Quarantine ${route.id}`,
      objective: `Verify that disabling route ${route.id} reduces repeated dispatch failures without blocking required traffic.`,
      promotionCriteria: { min_score: 0.7, required_evaluations: 1 },
    },
  };
}

export function deriveRuntimeEvolutionProposals(options: {
  events: MetaEvent[];
  routes: RouteRule[];
  channels: AgentChannel[];
  agents: AgentNode[];
  proposals: Proposal[];
  minEvents: number;
  limit: number;
}): DerivedTopologyProposal[] {
  const routesById = new Map(options.routes.map((route) => [route.id, route]));
  const channelsById = new Map(options.channels.map((channel) => [channel.id, channel]));
  const recentEvents = options.events.slice(-options.limit);
  const failuresByRoute = groupBy(
    recentEvents.filter((event) => event.kind === "route.failed"),
    routeIdFromEvent,
  );
  const unmatchedBySource = groupBy(
    recentEvents.filter((event) => event.kind === "route.unmatched"),
    (event) => {
      const source = metadataString(event, "source");
      if (!source) return undefined;
      return `${source}:${metadataString(event, "topic") ?? "general"}`;
    },
  );

  const derived: DerivedTopologyProposal[] = [];
  for (const [routeId, failures] of failuresByRoute) {
    const route = routesById.get(routeId);
    if (!route?.enabled) continue;
    if (failures.length < options.minEvents) continue;
    const channelId = route.target.startsWith("channel:")
      ? route.target.slice("channel:".length)
      : undefined;
    const proposal = deriveFailureProposal({
      route,
      channel: channelId ? channelsById.get(channelId) : undefined,
      failures,
      proposals: [...options.proposals, ...derived.map((draft) => draftToProposal(draft))],
    });
    if (proposal) derived.push(proposal);
  }

  for (const [, unmatched] of unmatchedBySource) {
    if (unmatched.length < options.minEvents) continue;
    const first = unmatched[0];
    if (!first) continue;
    const source = metadataString(first, "source");
    if (!source) continue;
    const topic = metadataString(first, "topic");
    const summary = `Create triage route for unmatched ${source} messages`;
    if (
      alreadyProposed(summary, [
        ...options.proposals,
        ...derived.map((draft) => draftToProposal(draft)),
      ])
    ) {
      continue;
    }
    derived.push({
      kind: "create_triage_agent_route",
      summary,
      rationale: [
        `Derived from ${unmatched.length} recent route.unmatched events.`,
        `Messages from ${source} had no active route, so this creates a triage specialist and catch-all route.`,
      ].join(" "),
      ops: triageRouteOps(source, topic, unmatched.length),
      sourceEventIds: unmatched.map((event) => event.id),
      experiment: {
        name: `Triage unmatched ${source}`,
        objective: `Verify that unmatched messages from ${source} are handled by the generated triage specialist.`,
        promotionCriteria: { min_score: 0.7, required_evaluations: 1 },
      },
    });
  }

  return derived;
}

function draftToProposal(draft: DerivedTopologyProposal): Proposal {
  return {
    id: `derived-${slug(draft.summary)}`,
    scope: "session",
    summary: draft.summary,
    rationale: draft.rationale,
    status: "proposed",
    requiresApproval: true,
    createdAt: "",
    ops: draft.ops,
  };
}

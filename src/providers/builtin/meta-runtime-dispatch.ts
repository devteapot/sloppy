import type { ProviderRuntimeHub } from "../../core/hub";
import type {
  AgentChannel,
  AgentNode,
  AgentProfile,
  CapabilityMask,
  ExecutorBinding,
  MetaEvent,
  RouteDispatchResult,
  RouteMessageEnvelope,
  RouteRule,
} from "./meta-runtime-model";
import { matchingRoutes, normalizeRouteEnvelope } from "./meta-runtime-routing";

export type MetaRuntimeDispatchContext = {
  hub: ProviderRuntimeHub | null;
  routes: RouteRule[];
  agents: Map<string, AgentNode>;
  profiles: Map<string, AgentProfile>;
  channels: Map<string, AgentChannel>;
  capabilities: Map<string, CapabilityMask>;
  executorBindings: Map<string, ExecutorBinding>;
  recordEvent: (event: Omit<MetaEvent, "id" | "createdAt">) => void;
  refresh: () => void;
};

function routeFailure(
  context: MetaRuntimeDispatchContext,
  route: RouteRule,
  envelope: RouteMessageEnvelope,
  reason: string,
  metadata: Record<string, unknown> = {},
): RouteDispatchResult {
  context.recordEvent({
    kind: "route.failed",
    scope: "session",
    routeId: route.id,
    summary: `Route ${route.id} failed: ${reason}`,
    metadata: {
      route_id: route.id,
      target: route.target,
      source: envelope.source,
      topic: envelope.topic,
      reason,
      ...metadata,
    },
  });
  context.refresh();
  return { routed: false, reason };
}

function resolveAgentCapabilityMasks(
  context: MetaRuntimeDispatchContext,
  agent: AgentNode,
  profile: AgentProfile,
): CapabilityMask[] {
  const ids = [...(profile.defaultCapabilities ?? []), ...agent.capabilityMaskIds];
  return ids.map((id) => {
    const mask = context.capabilities.get(id);
    if (!mask) {
      throw new Error(`Agent ${agent.id} references unknown capability mask ${id}.`);
    }
    return mask;
  });
}

async function dispatchSingleRoute(
  context: MetaRuntimeDispatchContext,
  route: RouteRule,
  envelope: RouteMessageEnvelope,
): Promise<RouteDispatchResult> {
  if (!context.hub) {
    return routeFailure(
      context,
      route,
      envelope,
      "Meta-runtime provider is not attached to a hub.",
      {
        reason_code: "missing_hub",
      },
    );
  }

  if (route.target.startsWith("agent:")) {
    const agentId = route.target.slice("agent:".length);
    const agent = context.agents.get(agentId);
    if (!agent) {
      return routeFailure(context, route, envelope, `Unknown target agent: ${agentId}`, {
        reason_code: "unknown_agent",
        agent_id: agentId,
      });
    }
    if (agent.status !== "active") {
      return routeFailure(
        context,
        route,
        envelope,
        `Target agent ${agentId} is ${agent.status}, not active.`,
        {
          reason_code: "agent_inactive",
          agent_id: agentId,
          agent_status: agent.status,
        },
      );
    }
    const profile = context.profiles.get(agent.profileId);
    if (!profile) {
      return routeFailure(context, route, envelope, `Target agent ${agentId} has no profile.`, {
        reason_code: "agent_missing_profile",
        agent_id: agentId,
        profile_id: agent.profileId,
      });
    }
    const executor = agent.executorBindingId
      ? context.executorBindings.get(agent.executorBindingId)
      : undefined;
    if (agent.executorBindingId && !executor) {
      return routeFailure(
        context,
        route,
        envelope,
        `Target agent ${agentId} references unknown executor binding ${agent.executorBindingId}.`,
        {
          reason_code: "agent_missing_executor",
          agent_id: agentId,
          executor_binding_id: agent.executorBindingId,
        },
      );
    }
    const capabilityMasks = resolveAgentCapabilityMasks(context, agent, profile);
    const goal = [
      profile.instructions,
      `Route message ${envelope.id} from ${envelope.source}:`,
      envelope.body,
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await context.hub.invoke("delegation", "/session", "spawn_agent", {
      name: profile.name,
      goal,
      ...(executor ? { executor } : {}),
      capabilityMasks,
      routeEnvelope: envelope,
    });
    if (result.status === "error") {
      return routeFailure(
        context,
        route,
        envelope,
        `Dispatch to agent ${agent.id} failed: ${result.error?.message ?? "unknown error"}.`,
        {
          reason_code: "target_invoke_error",
          provider: "delegation",
          agent_id: agent.id,
        },
      );
    }
    context.recordEvent({
      kind: "route.dispatched",
      scope: "session",
      routeId: route.id,
      summary: `Dispatched route ${route.id} to agent ${agent.id}.`,
    });
    context.refresh();
    return {
      routed: true,
      route_id: route.id,
      target: route.target,
      provider: "delegation",
      result,
      envelope,
    };
  }

  if (route.target.startsWith("channel:")) {
    const channelId = route.target.slice("channel:".length);
    const channel = context.channels.get(channelId);
    if (!channel) {
      return routeFailure(context, route, envelope, `Unknown target channel: ${channelId}`, {
        reason_code: "unknown_channel",
        channel_id: channelId,
      });
    }
    if (!channel.participants.includes(envelope.source)) {
      return routeFailure(
        context,
        route,
        envelope,
        `Source ${envelope.source} is not a participant in channel ${channelId}.`,
        {
          reason_code: "channel_missing_participant",
          channel_id: channelId,
          source: envelope.source,
        },
      );
    }
    const result = await context.hub.invoke("messaging", `/channels/${channelId}`, "send", {
      message: envelope.body,
      envelope,
    });
    if (result.status === "error") {
      return routeFailure(
        context,
        route,
        envelope,
        `Dispatch to channel ${channel.id} failed: ${result.error?.message ?? "unknown error"}.`,
        {
          reason_code: "target_invoke_error",
          provider: "messaging",
          channel_id: channel.id,
        },
      );
    }
    context.recordEvent({
      kind: "route.dispatched",
      scope: "session",
      routeId: route.id,
      summary: `Dispatched route ${route.id} to channel ${channel.id}.`,
    });
    context.refresh();
    return {
      routed: true,
      route_id: route.id,
      target: route.target,
      provider: "messaging",
      result,
      envelope,
    };
  }

  return routeFailure(
    context,
    route,
    envelope,
    `Unsupported route target "${route.target}". Use agent:<id> or channel:<id>.`,
    {
      reason_code: "unsupported_target",
    },
  );
}

export async function dispatchMetaRuntimeRoute(
  context: MetaRuntimeDispatchContext,
  source: string,
  message: string | RouteMessageEnvelope,
  fanout = false,
): Promise<RouteDispatchResult | { routed: boolean; deliveries: RouteDispatchResult[] }> {
  const envelope = normalizeRouteEnvelope(source, message);
  const routes = matchingRoutes(context.routes, envelope, fanout);
  if (routes.length === 0) {
    context.recordEvent({
      kind: "route.unmatched",
      scope: "session",
      summary: `No enabled route matched source "${envelope.source}".`,
      metadata: { reason_code: "unmatched_route", source: envelope.source, topic: envelope.topic },
    });
    context.refresh();
    return { routed: false, reason: `No enabled route matched source "${envelope.source}".` };
  }

  const deliveries: RouteDispatchResult[] = [];
  for (const route of routes) {
    deliveries.push(await dispatchSingleRoute(context, route, envelope));
  }

  if (fanout) {
    return { routed: deliveries.some((delivery) => delivery.routed), deliveries };
  }

  return deliveries[0] ?? { routed: false, reason: "No route deliveries were attempted." };
}

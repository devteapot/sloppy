import type { RuntimeServiceRegistry } from "../../../runtime/services";
import { executorBindingSchema } from "../delegation/runtime/executor-binding";
import { DELEGATION_SERVICE, MESSAGING_SERVICE, SKILLS_SERVICE } from "../service-keys";
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
  SkillVersion,
} from "./meta-runtime-model";
import { matchingRoutes, normalizeRouteEnvelope } from "./meta-runtime-routing";

export type MetaRuntimeDispatchContext = {
  services: RuntimeServiceRegistry;
  routes: RouteRule[];
  agents: Map<string, AgentNode>;
  profiles: Map<string, AgentProfile>;
  channels: Map<string, AgentChannel>;
  capabilities: Map<string, CapabilityMask>;
  executorBindings: Map<string, ExecutorBinding>;
  skillVersions: Map<string, SkillVersion>;
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

function selectedSkillVersions(
  context: MetaRuntimeDispatchContext,
  agent: AgentNode,
  profile: AgentProfile,
): SkillVersion[] {
  const ids = [...(profile.defaultSkillVersionIds ?? []), ...(agent.skillVersionIds ?? [])];
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.map((id) => {
    const skillVersion = context.skillVersions.get(id);
    if (!skillVersion) {
      throw new Error(`Agent ${agent.id} references unknown skill version ${id}.`);
    }
    if (!skillVersion.active || skillVersion.activationStatus === "failed") {
      throw new Error(`Agent ${agent.id} references inactive skill version ${id}.`);
    }
    return skillVersion;
  });
}

async function buildActiveSkillContext(
  context: MetaRuntimeDispatchContext,
  agent: AgentNode,
  profile: AgentProfile,
): Promise<string> {
  const skillVersions = selectedSkillVersions(context, agent, profile);
  if (skillVersions.length === 0) return "";
  const skills = context.services.require(SKILLS_SERVICE, "Skills");

  const sections: string[] = [];
  for (const skillVersion of skillVersions) {
    const viewed = await skills.viewSkill(skillVersion.skillId);
    const content = viewed.content.trim();
    if (!content) {
      throw new Error(`Active skill ${skillVersion.skillId}@${skillVersion.version} is empty.`);
    }
    sections.push(
      [
        `### ${skillVersion.skillId}@${skillVersion.version}`,
        skillVersion.notes ? `Notes: ${skillVersion.notes}` : "",
        content,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return ["Active runtime skills are frozen into this routed child run.", ...sections].join("\n\n");
}

async function dispatchSingleRoute(
  context: MetaRuntimeDispatchContext,
  route: RouteRule,
  envelope: RouteMessageEnvelope,
): Promise<RouteDispatchResult> {
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
    if (capabilityMasks.length === 0) {
      return routeFailure(
        context,
        route,
        envelope,
        `Target agent ${agent.id} has no explicit capability masks.`,
        {
          reason_code: "missing_capability_mask",
          agent_id: agent.id,
        },
      );
    }
    let skillContext = "";
    try {
      skillContext = await buildActiveSkillContext(context, agent, profile);
    } catch (error) {
      return routeFailure(
        context,
        route,
        envelope,
        error instanceof Error ? error.message : String(error),
        {
          reason_code: "skill_context_failed",
          agent_id: agent.id,
        },
      );
    }
    const goal = [
      profile.instructions,
      skillContext,
      `Route message ${envelope.id} from ${envelope.source}:`,
      envelope.body,
    ]
      .filter(Boolean)
      .join("\n\n");
    let result: unknown;
    try {
      result = context.services.require(DELEGATION_SERVICE, "Delegation").spawnAgent({
        name: profile.name,
        goal,
        executor: executor ? executorBindingSchema.parse(executor) : undefined,
        capabilityMasks,
        routeEnvelope: envelope,
      });
    } catch (error) {
      return routeFailure(
        context,
        route,
        envelope,
        `Dispatch to agent ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}.`,
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
    let result: unknown;
    try {
      result = context.services
        .require(MESSAGING_SERVICE, "Messaging")
        .sendMessage(channelId, envelope.body, envelope);
    } catch (error) {
      return routeFailure(
        context,
        route,
        envelope,
        `Dispatch to channel ${channel.id} failed: ${error instanceof Error ? error.message : String(error)}.`,
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

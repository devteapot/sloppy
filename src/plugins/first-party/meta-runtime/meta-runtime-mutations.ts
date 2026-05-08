import type { MetaScope, MetaStateMaps, RouteRule, TopologyChange } from "./meta-runtime-model";
import { cloneMergedState } from "./meta-runtime-model";

export function validateTopologyChanges(ops: TopologyChange[], state: MetaStateMaps): void {
  const simulated = cloneMergedState(state);

  for (const op of ops) {
    switch (op.type) {
      case "upsertAgentProfile":
        simulated.profiles.set(op.profile.id, op.profile);
        break;
      case "spawnAgent":
        if (!simulated.profiles.has(op.agent.profileId)) {
          throw new Error(`Agent ${op.agent.id} references unknown profile ${op.agent.profileId}.`);
        }
        if (
          op.agent.executorBindingId &&
          !simulated.executorBindings.has(op.agent.executorBindingId)
        ) {
          throw new Error(
            `Agent ${op.agent.id} references unknown executor binding ${op.agent.executorBindingId}.`,
          );
        }
        for (const maskId of op.agent.capabilityMaskIds) {
          if (!simulated.capabilities.has(maskId)) {
            throw new Error(`Agent ${op.agent.id} references unknown capability mask ${maskId}.`);
          }
        }
        simulated.agents.set(op.agent.id, op.agent);
        break;
      case "retireAgent": {
        const existing = simulated.agents.get(op.agentId);
        if (!existing) throw new Error(`Cannot retire unknown agent ${op.agentId}.`);
        simulated.agents.set(op.agentId, { ...existing, status: "retired" });
        break;
      }
      case "upsertChannel":
        simulated.channels.set(op.channel.id, op.channel);
        break;
      case "rewireChannel": {
        const existing = simulated.channels.get(op.channelId);
        if (!existing) throw new Error(`Cannot rewire unknown channel ${op.channelId}.`);
        simulated.channels.set(op.channelId, { ...existing, participants: op.participants });
        break;
      }
      case "upsertRoute":
        validateRouteTarget(op.route, simulated);
        simulated.routes.set(op.route.id, op.route);
        break;
      case "setCapabilityMask":
        simulated.capabilities.set(op.mask.id, op.mask);
        break;
      case "setExecutorBinding":
        simulated.executorBindings.set(op.binding.id, op.binding);
        break;
      case "activateSkillVersion":
        simulated.skillVersions.set(op.skillVersion.id, op.skillVersion);
        break;
      case "deactivateSkillVersion": {
        const existing = simulated.skillVersions.get(op.skillVersionId);
        if (!existing) {
          throw new Error(`Cannot deactivate unknown skill version ${op.skillVersionId}.`);
        }
        simulated.skillVersions.set(op.skillVersionId, { ...existing, active: false });
        break;
      }
    }
  }
}

export function applyTopologyChange(
  layers: Record<MetaScope, MetaStateMaps>,
  effective: MetaStateMaps,
  scope: MetaScope,
  op: TopologyChange,
): void {
  const target = layers[scope];
  switch (op.type) {
    case "upsertAgentProfile":
      target.profiles.set(op.profile.id, op.profile);
      return;
    case "spawnAgent":
      target.agents.set(op.agent.id, op.agent);
      return;
    case "retireAgent": {
      const existing = effective.agents.get(op.agentId);
      if (existing) target.agents.set(op.agentId, { ...existing, status: "retired" });
      return;
    }
    case "upsertChannel":
      target.channels.set(op.channel.id, op.channel);
      return;
    case "rewireChannel": {
      const existing = effective.channels.get(op.channelId);
      if (existing)
        target.channels.set(op.channelId, { ...existing, participants: op.participants });
      return;
    }
    case "upsertRoute":
      target.routes.set(op.route.id, op.route);
      return;
    case "setCapabilityMask":
      target.capabilities.set(op.mask.id, op.mask);
      return;
    case "setExecutorBinding":
      target.executorBindings.set(op.binding.id, op.binding);
      return;
    case "activateSkillVersion":
      target.skillVersions.set(op.skillVersion.id, op.skillVersion);
      return;
    case "deactivateSkillVersion": {
      const existing = effective.skillVersions.get(op.skillVersionId);
      if (existing) target.skillVersions.set(op.skillVersionId, { ...existing, active: false });
      return;
    }
  }
}

function validateRouteTarget(route: RouteRule, state: MetaStateMaps): void {
  if (route.target.startsWith("agent:")) {
    const agentId = route.target.slice("agent:".length);
    if (!state.agents.has(agentId)) {
      throw new Error(`Route ${route.id} references unknown target agent ${agentId}.`);
    }
    return;
  }
  if (route.target.startsWith("channel:")) {
    const channelId = route.target.slice("channel:".length);
    if (!state.channels.has(channelId)) {
      throw new Error(`Route ${route.id} references unknown target channel ${channelId}.`);
    }
    return;
  }
  throw new Error(`Route ${route.id} has unsupported target ${route.target}.`);
}

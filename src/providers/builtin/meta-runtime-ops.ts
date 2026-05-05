import type { MetaScope, TopologyChange } from "./meta-runtime-model";

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return asStringArray(value, "actions");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asScope(value: unknown): MetaScope {
  if (value === "global" || value === "workspace" || value === "session") return value;
  return "session";
}

function requireScope(value: unknown, field: string): MetaScope {
  if (value === "global" || value === "workspace" || value === "session") return value;
  throw new Error(`${field} must be one of session, workspace, or global.`);
}

export function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

export function classifyApproval(scope: MetaScope, ops: TopologyChange[]): boolean {
  if (scope !== "session") return true;
  return ops.some((op) => {
    if (op.type === "setCapabilityMask") {
      return op.mask.mode === "allow";
    }
    return ["spawnAgent", "setExecutorBinding", "activateSkillVersion"].includes(op.type);
  });
}

export function parseChange(raw: unknown): TopologyChange {
  if (!raw || typeof raw !== "object") {
    throw new Error("Topology change must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const type = asString(record.type, "type");

  switch (type) {
    case "upsertAgentProfile": {
      const profile = record.profile as Record<string, unknown>;
      return {
        type,
        profile: {
          id: asString(profile?.id, "profile.id"),
          name: asString(profile?.name, "profile.name"),
          instructions: typeof profile.instructions === "string" ? profile.instructions : undefined,
          defaultCapabilities: optionalStringArray(profile.defaultCapabilities),
        },
      };
    }
    case "spawnAgent": {
      const agent = record.agent as Record<string, unknown>;
      return {
        type,
        agent: {
          id: asString(agent?.id, "agent.id"),
          profileId: asString(agent?.profileId, "agent.profileId"),
          status:
            agent.status === "active" || agent.status === "retired" ? agent.status : "planned",
          channels: Array.isArray(agent.channels)
            ? asStringArray(agent.channels, "agent.channels")
            : [],
          capabilityMaskIds: Array.isArray(agent.capabilityMaskIds)
            ? asStringArray(agent.capabilityMaskIds, "agent.capabilityMaskIds")
            : [],
          executorBindingId:
            typeof agent.executorBindingId === "string" ? agent.executorBindingId : undefined,
        },
      };
    }
    case "retireAgent":
      return { type, agentId: asString(record.agentId, "agentId") };
    case "upsertChannel": {
      const channel = record.channel as Record<string, unknown>;
      return {
        type,
        channel: {
          id: asString(channel?.id, "channel.id"),
          topic: asString(channel?.topic, "channel.topic"),
          participants: Array.isArray(channel.participants)
            ? asStringArray(channel.participants, "channel.participants")
            : [],
          visibility: channel.visibility === "shared" ? "shared" : "private",
        },
      };
    }
    case "rewireChannel":
      return {
        type,
        channelId: asString(record.channelId, "channelId"),
        participants: asStringArray(record.participants, "participants"),
      };
    case "upsertRoute": {
      const route = record.route as Record<string, unknown>;
      return {
        type,
        route: {
          id: asString(route?.id, "route.id"),
          source: asString(route?.source, "route.source"),
          match: asString(route?.match, "route.match"),
          target: asString(route?.target, "route.target"),
          enabled: route.enabled !== false,
          priority: optionalNonNegativeInteger(route.priority, "route.priority"),
        },
      };
    }
    case "setCapabilityMask": {
      const mask = record.mask as Record<string, unknown>;
      if (mask.mode !== "allow" && mask.mode !== "deny") {
        throw new Error("mask.mode must be either allow or deny.");
      }
      return {
        type,
        mask: {
          id: asString(mask?.id, "mask.id"),
          provider: typeof mask.provider === "string" ? mask.provider : undefined,
          path: typeof mask.path === "string" ? mask.path : undefined,
          actions: optionalStringArray(mask.actions),
          mode: mask.mode,
        },
      };
    }
    case "setExecutorBinding": {
      const binding = record.binding as Record<string, unknown>;
      return {
        type,
        binding: {
          id: asString(binding?.id, "binding.id"),
          kind: binding.kind === "acp" ? "acp" : "llm",
          profileId: typeof binding.profileId === "string" ? binding.profileId : undefined,
          adapterId: typeof binding.adapterId === "string" ? binding.adapterId : undefined,
          modelOverride:
            typeof binding.modelOverride === "string" ? binding.modelOverride : undefined,
        },
      };
    }
    case "activateSkillVersion": {
      const skillVersion = record.skillVersion as Record<string, unknown>;
      return {
        type,
        skillVersion: {
          id: asString(skillVersion?.id, "skillVersion.id"),
          skillId: asString(skillVersion?.skillId, "skillVersion.skillId"),
          version: asString(skillVersion?.version, "skillVersion.version"),
          scope: requireScope(skillVersion.scope, "skillVersion.scope"),
          active: skillVersion.active !== false,
          proposalId: optionalString(skillVersion.proposalId),
          activationStatus:
            skillVersion.activationStatus === "pending" ||
            skillVersion.activationStatus === "active" ||
            skillVersion.activationStatus === "failed"
              ? skillVersion.activationStatus
              : undefined,
          notes: optionalString(skillVersion.notes),
        },
      };
    }
    case "deactivateSkillVersion":
      return { type, skillVersionId: asString(record.skillVersionId, "skillVersionId") };
    default:
      throw new Error(`Unsupported topology change type: ${type}`);
  }
}

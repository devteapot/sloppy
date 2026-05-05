import type { RuntimeCapabilityMask } from "../../core/capability-policy";

export type MetaScope = "session" | "workspace" | "global";
export type ProposalStatus = "proposed" | "applied" | "reverted" | "expired";

export type CapabilityMask = RuntimeCapabilityMask;

export type AgentProfile = {
  id: string;
  name: string;
  instructions?: string;
  defaultCapabilities?: string[];
};

export type AgentNode = {
  id: string;
  profileId: string;
  status: "planned" | "active" | "retired";
  channels: string[];
  capabilityMaskIds: string[];
  executorBindingId?: string;
};

export type AgentChannel = {
  id: string;
  topic: string;
  participants: string[];
  visibility: "private" | "shared";
};

export type RouteRule = {
  id: string;
  source: string;
  match: string;
  target: string;
  enabled: boolean;
  priority?: number;
};

export type ExecutorBinding = {
  id: string;
  kind: "llm" | "acp";
  profileId?: string;
  adapterId?: string;
  modelOverride?: string;
};

export type SchedulerPolicy = {
  id: string;
  maxConcurrency?: number;
  debounceMs?: number;
  priority?: "low" | "normal" | "high";
};

export type SkillVersion = {
  id: string;
  skillId: string;
  version: string;
  scope: MetaScope;
  active: boolean;
  notes?: string;
};

export type TopologyChange =
  | { type: "upsertAgentProfile"; profile: AgentProfile }
  | { type: "spawnAgent"; agent: AgentNode }
  | { type: "retireAgent"; agentId: string }
  | { type: "upsertChannel"; channel: AgentChannel }
  | { type: "rewireChannel"; channelId: string; participants: string[] }
  | { type: "upsertRoute"; route: RouteRule }
  | { type: "setCapabilityMask"; mask: CapabilityMask }
  | { type: "setExecutorBinding"; binding: ExecutorBinding }
  | { type: "setSchedulerPolicy"; policy: SchedulerPolicy }
  | { type: "activateSkillVersion"; skillVersion: SkillVersion }
  | { type: "deactivateSkillVersion"; skillVersionId: string };

export type Proposal = {
  id: string;
  scope: MetaScope;
  summary: string;
  rationale?: string;
  status: ProposalStatus;
  requiresApproval: boolean;
  createdAt: string;
  appliedAt?: string;
  revertedAt?: string;
  ttlMs?: number;
  ops: TopologyChange[];
};

export type MetaEvent = {
  id: string;
  kind: string;
  scope: MetaScope;
  proposalId?: string;
  summary: string;
  createdAt: string;
};

export type PersistedState = {
  profiles?: AgentProfile[];
  agents?: AgentNode[];
  channels?: AgentChannel[];
  routes?: RouteRule[];
  capabilities?: CapabilityMask[];
  executorBindings?: ExecutorBinding[];
  schedulerPolicies?: SchedulerPolicy[];
  skillVersions?: SkillVersion[];
  proposals?: Proposal[];
  events?: MetaEvent[];
};

export type MetaStateMaps = {
  profiles: Map<string, AgentProfile>;
  agents: Map<string, AgentNode>;
  channels: Map<string, AgentChannel>;
  routes: Map<string, RouteRule>;
  capabilities: Map<string, CapabilityMask>;
  executorBindings: Map<string, ExecutorBinding>;
  schedulerPolicies: Map<string, SchedulerPolicy>;
  skillVersions: Map<string, SkillVersion>;
};

export type RouteDispatchResult =
  | {
      routed: false;
      reason: string;
    }
  | {
      routed: true;
      route_id: string;
      target: string;
      provider: string;
      result: unknown;
    };

export function putById<T extends { id: string }>(map: Map<string, T>, items?: T[]): void {
  for (const item of items ?? []) {
    map.set(item.id, item);
  }
}

export function listByName<T extends { id: string; name?: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

export function listById<T extends { id: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function createStateMaps(): MetaStateMaps {
  return {
    profiles: new Map(),
    agents: new Map(),
    channels: new Map(),
    routes: new Map(),
    capabilities: new Map(),
    executorBindings: new Map(),
    schedulerPolicies: new Map(),
    skillVersions: new Map(),
  };
}

export function clearStateMaps(state: MetaStateMaps): void {
  state.profiles.clear();
  state.agents.clear();
  state.channels.clear();
  state.routes.clear();
  state.capabilities.clear();
  state.executorBindings.clear();
  state.schedulerPolicies.clear();
  state.skillVersions.clear();
}

export function putState(state: MetaStateMaps, persisted: PersistedState): void {
  putById(state.profiles, persisted.profiles);
  putById(state.agents, persisted.agents);
  putById(state.channels, persisted.channels);
  putById(state.routes, persisted.routes);
  putById(state.capabilities, persisted.capabilities);
  putById(state.executorBindings, persisted.executorBindings);
  putById(state.schedulerPolicies, persisted.schedulerPolicies);
  putById(state.skillVersions, persisted.skillVersions);
}

export function snapshotStateMaps(state: MetaStateMaps): PersistedState {
  return {
    profiles: listByName(state.profiles),
    agents: listById(state.agents),
    channels: listById(state.channels),
    routes: listById(state.routes),
    capabilities: listById(state.capabilities),
    executorBindings: listById(state.executorBindings),
    schedulerPolicies: listById(state.schedulerPolicies),
    skillVersions: listById(state.skillVersions),
  };
}

export function cloneMergedState(state: MetaStateMaps): MetaStateMaps {
  const clone = createStateMaps();
  putState(clone, snapshotStateMaps(state));
  return clone;
}

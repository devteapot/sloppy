import { executorBindingSchema } from "../../runtime/delegation/executor-binding";
import type {
  AgentChannel,
  AgentNode,
  AgentProfile,
  CapabilityMask,
  ExecutorBinding,
  ExperimentEvaluation,
  ExperimentPromotionCriteria,
  MetaEvent,
  MetaScope,
  PersistedState,
  Proposal,
  ProposalStatus,
  RouteRule,
  SkillVersion,
  TopologyChange,
  TopologyExperiment,
  TopologyPattern,
} from "./meta-runtime-model";

type ObjectRecord = Record<string, unknown>;

const AGENT_STATUSES = ["planned", "active", "retired"] as const;
const PROPOSAL_STATUSES = ["proposed", "applied", "reverted", "expired"] as const;
const EXPERIMENT_STATUSES = ["candidate", "promoted", "rejected", "rolled_back"] as const;
const SKILL_ACTIVATION_STATUSES = ["pending", "active", "failed"] as const;

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function asRecord(value: unknown, field: string): ObjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as ObjectRecord;
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

function optionalStringArrayField(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  return asStringArray(value, field);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function optionalRouteMatchMode(value: unknown): RouteRule["matchMode"] {
  if (value === undefined) return undefined;
  if (
    value === "substring" ||
    value === "exact" ||
    value === "prefix" ||
    value === "regex" ||
    value === "exists"
  ) {
    return value;
  }
  throw new Error("route.matchMode must be one of substring, exact, prefix, regex, or exists.");
}

function optionalRouteMatchField(value: unknown): RouteRule["matchField"] {
  if (value === undefined) return undefined;
  if (value === "body" || value === "topic" || value === "channelId") {
    return value;
  }
  if (typeof value === "string" && /^metadata\.[A-Za-z0-9_.-]+$/.test(value)) {
    return value as RouteRule["matchField"];
  }
  throw new Error("route.matchField must be body, topic, channelId, or metadata.<path>.");
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): ObjectRecord | undefined {
  if (value === undefined) return undefined;
  return asRecord(value, field);
}

function validateRouteMatcher(route: RouteRule): void {
  if (route.matchMode === "regex") {
    try {
      new RegExp(route.match);
    } catch (error) {
      throw new Error(
        `route.match must be a valid regular expression when route.matchMode is regex: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function asScope(value: unknown): MetaScope {
  if (value === "global" || value === "workspace" || value === "session") return value;
  return "session";
}

function requireScope(value: unknown, field: string): MetaScope {
  if (value === "global" || value === "workspace" || value === "session") return value;
  throw new Error(`${field} must be one of session, workspace, or global.`);
}

function requiredEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
): T[number] {
  if (typeof value === "string" && values.includes(value)) {
    return value;
  }
  throw new Error(`${field} must be one of ${values.join(", ")}.`);
}

function optionalEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  return requiredEnum(value, field, values);
}

export function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function optionalFraction(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a number between 0 and 1.`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function optionalArrayField<T>(
  record: ObjectRecord,
  field: keyof PersistedState,
  parse: (value: unknown, field: string) => T,
): T[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`state.${field} must be an array.`);
  }
  return value.map((entry, index) => parse(entry, `state.${field}[${index}]`));
}

function parseAgentProfile(value: unknown, field: string): AgentProfile {
  const profile = asRecord(value, field);
  return {
    id: asString(profile.id, `${field}.id`),
    name: asString(profile.name, `${field}.name`),
    instructions: optionalStringField(profile.instructions, `${field}.instructions`),
    defaultCapabilities: optionalStringArrayField(
      profile.defaultCapabilities,
      `${field}.defaultCapabilities`,
    ),
    defaultSkillVersionIds: optionalStringArrayField(
      profile.defaultSkillVersionIds,
      `${field}.defaultSkillVersionIds`,
    ),
  };
}

function parseAgentNode(value: unknown, field: string): AgentNode {
  const agent = asRecord(value, field);
  return {
    id: asString(agent.id, `${field}.id`),
    profileId: asString(agent.profileId, `${field}.profileId`),
    status: requiredEnum(agent.status, `${field}.status`, AGENT_STATUSES),
    channels: asStringArray(agent.channels, `${field}.channels`),
    capabilityMaskIds: asStringArray(agent.capabilityMaskIds, `${field}.capabilityMaskIds`),
    skillVersionIds: optionalStringArrayField(agent.skillVersionIds, `${field}.skillVersionIds`),
    executorBindingId: optionalStringField(agent.executorBindingId, `${field}.executorBindingId`),
  };
}

function parseAgentChannel(value: unknown, field: string): AgentChannel {
  const channel = asRecord(value, field);
  return {
    id: asString(channel.id, `${field}.id`),
    topic: asString(channel.topic, `${field}.topic`),
    participants: asStringArray(channel.participants, `${field}.participants`),
    visibility: requiredEnum(channel.visibility, `${field}.visibility`, [
      "private",
      "shared",
    ] as const),
  };
}

function parseRouteRule(value: unknown, field: string): RouteRule {
  const route = asRecord(value, field);
  const traffic = optionalRecord(route.traffic, `${field}.traffic`);
  const parsedRoute: RouteRule = {
    id: asString(route.id, `${field}.id`),
    source: asString(route.source, `${field}.source`),
    match: asString(route.match, `${field}.match`),
    matchMode: optionalRouteMatchMode(route.matchMode),
    matchField: optionalRouteMatchField(route.matchField),
    caseSensitive: optionalBoolean(route.caseSensitive, `${field}.caseSensitive`),
    target: asString(route.target, `${field}.target`),
    enabled: asBoolean(route.enabled, `${field}.enabled`),
    priority: optionalNonNegativeInteger(route.priority, `${field}.priority`),
    traffic: traffic
      ? {
          sampleRate: optionalFraction(traffic.sampleRate, `${field}.traffic.sampleRate`),
          experimentId: optionalStringField(traffic.experimentId, `${field}.traffic.experimentId`),
        }
      : undefined,
  };
  validateRouteMatcher(parsedRoute);
  return parsedRoute;
}

function parseCapabilityMask(value: unknown, field: string): CapabilityMask {
  const mask = asRecord(value, field);
  return {
    id: asString(mask.id, `${field}.id`),
    provider: optionalStringField(mask.provider, `${field}.provider`),
    path: optionalStringField(mask.path, `${field}.path`),
    actions: optionalStringArrayField(mask.actions, `${field}.actions`),
    mode: requiredEnum(mask.mode, `${field}.mode`, ["allow", "deny"] as const),
  };
}

function parseExecutorBinding(value: unknown, field: string): ExecutorBinding {
  const binding = asRecord(value, field);
  const parsed = executorBindingSchema.parse({
    kind: binding.kind,
    profileId: binding.profileId,
    adapterId: binding.adapterId,
    modelOverride: binding.modelOverride,
    timeoutMs: binding.timeoutMs,
  });
  return {
    id: asString(binding.id, `${field}.id`),
    ...parsed,
  };
}

function parseSkillVersion(value: unknown, field: string): SkillVersion {
  const skillVersion = asRecord(value, field);
  return {
    id: asString(skillVersion.id, `${field}.id`),
    skillId: asString(skillVersion.skillId, `${field}.skillId`),
    version: asString(skillVersion.version, `${field}.version`),
    scope: requireScope(skillVersion.scope, `${field}.scope`),
    active: asBoolean(skillVersion.active, `${field}.active`),
    proposalId: optionalStringField(skillVersion.proposalId, `${field}.proposalId`),
    activationStatus: optionalEnum(
      skillVersion.activationStatus,
      `${field}.activationStatus`,
      SKILL_ACTIVATION_STATUSES,
    ),
    notes: optionalStringField(skillVersion.notes, `${field}.notes`),
  };
}

function parsePromotionCriteria(
  value: unknown,
  field: string,
): ExperimentPromotionCriteria | undefined {
  const criteria = optionalRecord(value, field);
  if (!criteria) return undefined;
  return {
    minScore:
      criteria.minScore === undefined
        ? undefined
        : asFiniteNumber(criteria.minScore, `${field}.minScore`),
    requiredEvaluations: optionalNonNegativeInteger(
      criteria.requiredEvaluations,
      `${field}.requiredEvaluations`,
    ),
  };
}

function parseTopologyExperiment(value: unknown, field: string): TopologyExperiment {
  const experiment = asRecord(value, field);
  return {
    id: asString(experiment.id, `${field}.id`),
    scope: requireScope(experiment.scope, `${field}.scope`),
    name: asString(experiment.name, `${field}.name`),
    proposalId: asString(experiment.proposalId, `${field}.proposalId`),
    objective: asString(experiment.objective, `${field}.objective`),
    status: requiredEnum(experiment.status, `${field}.status`, EXPERIMENT_STATUSES),
    createdAt: asString(experiment.createdAt, `${field}.createdAt`),
    promotedAt: optionalStringField(experiment.promotedAt, `${field}.promotedAt`),
    rolledBackAt: optionalStringField(experiment.rolledBackAt, `${field}.rolledBackAt`),
    parentExperimentId: optionalStringField(
      experiment.parentExperimentId,
      `${field}.parentExperimentId`,
    ),
    rollbackProposalId: optionalStringField(
      experiment.rollbackProposalId,
      `${field}.rollbackProposalId`,
    ),
    promotionEvaluationId: optionalStringField(
      experiment.promotionEvaluationId,
      `${field}.promotionEvaluationId`,
    ),
    promotionCriteria: parsePromotionCriteria(
      experiment.promotionCriteria,
      `${field}.promotionCriteria`,
    ),
  };
}

function parseExperimentEvaluation(value: unknown, field: string): ExperimentEvaluation {
  const evaluation = asRecord(value, field);
  return {
    id: asString(evaluation.id, `${field}.id`),
    experimentId: asString(evaluation.experimentId, `${field}.experimentId`),
    score: asFiniteNumber(evaluation.score, `${field}.score`),
    summary: asString(evaluation.summary, `${field}.summary`),
    evaluator: optionalStringField(evaluation.evaluator, `${field}.evaluator`),
    evidence: optionalRecord(evaluation.evidence, `${field}.evidence`),
    createdAt: asString(evaluation.createdAt, `${field}.createdAt`),
  };
}

function parseTopologyChangeArray(value: unknown, field: string): TopologyChange[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value.map((entry, index) => parseChangeWithField(entry, `${field}[${index}]`));
}

function parseProposal(value: unknown, field: string): Proposal {
  const proposal = asRecord(value, field);
  const scope = requireScope(proposal.scope, `${field}.scope`);
  const ops = parseTopologyChangeArray(proposal.ops, `${field}.ops`);
  const requiresApproval = asBoolean(proposal.requiresApproval, `${field}.requiresApproval`);
  const expectedRequiresApproval = classifyApproval(scope, ops);
  if (requiresApproval !== expectedRequiresApproval) {
    throw new Error(
      `${field}.requiresApproval must match the imported proposal scope and operations.`,
    );
  }
  return {
    id: asString(proposal.id, `${field}.id`),
    scope,
    summary: asString(proposal.summary, `${field}.summary`),
    rationale: optionalStringField(proposal.rationale, `${field}.rationale`),
    status: requiredEnum(proposal.status, `${field}.status`, PROPOSAL_STATUSES) as ProposalStatus,
    requiresApproval: expectedRequiresApproval,
    createdAt: asString(proposal.createdAt, `${field}.createdAt`),
    appliedAt: optionalStringField(proposal.appliedAt, `${field}.appliedAt`),
    revertedAt: optionalStringField(proposal.revertedAt, `${field}.revertedAt`),
    ttlMs: optionalNonNegativeInteger(proposal.ttlMs, `${field}.ttlMs`),
    ops,
  };
}

function parseTopologyPattern(value: unknown, field: string): TopologyPattern {
  const pattern = asRecord(value, field);
  return {
    id: asString(pattern.id, `${field}.id`),
    scope: requireScope(pattern.scope, `${field}.scope`),
    name: asString(pattern.name, `${field}.name`),
    summary: optionalStringField(pattern.summary, `${field}.summary`),
    sourceExperimentId: asString(pattern.sourceExperimentId, `${field}.sourceExperimentId`),
    sourceProposalId: asString(pattern.sourceProposalId, `${field}.sourceProposalId`),
    ops: parseTopologyChangeArray(pattern.ops, `${field}.ops`),
    tags: optionalStringArrayField(pattern.tags, `${field}.tags`),
    evidence: optionalRecord(pattern.evidence, `${field}.evidence`),
    createdAt: asString(pattern.createdAt, `${field}.createdAt`),
    usageCount: optionalNonNegativeInteger(pattern.usageCount, `${field}.usageCount`),
  };
}

function parseMetaEvent(value: unknown, field: string): MetaEvent {
  const event = asRecord(value, field);
  return {
    id: asString(event.id, `${field}.id`),
    kind: asString(event.kind, `${field}.kind`),
    scope: requireScope(event.scope, `${field}.scope`),
    proposalId: optionalStringField(event.proposalId, `${field}.proposalId`),
    routeId: optionalStringField(event.routeId, `${field}.routeId`),
    summary: asString(event.summary, `${field}.summary`),
    metadata: optionalRecord(event.metadata, `${field}.metadata`),
    createdAt: asString(event.createdAt, `${field}.createdAt`),
  };
}

function parseChangeWithField(value: unknown, field: string): TopologyChange {
  try {
    return parseChange(value);
  } catch (error) {
    throw new Error(`${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parsePersistedState(raw: unknown): PersistedState {
  const record = asRecord(raw, "state");
  return {
    profiles: optionalArrayField(record, "profiles", parseAgentProfile),
    agents: optionalArrayField(record, "agents", parseAgentNode),
    channels: optionalArrayField(record, "channels", parseAgentChannel),
    routes: optionalArrayField(record, "routes", parseRouteRule),
    capabilities: optionalArrayField(record, "capabilities", parseCapabilityMask),
    executorBindings: optionalArrayField(record, "executorBindings", parseExecutorBinding),
    skillVersions: optionalArrayField(record, "skillVersions", parseSkillVersion),
    experiments: optionalArrayField(record, "experiments", parseTopologyExperiment),
    evaluations: optionalArrayField(record, "evaluations", parseExperimentEvaluation),
    proposals: optionalArrayField(record, "proposals", parseProposal),
    patterns: optionalArrayField(record, "patterns", parseTopologyPattern),
    events: optionalArrayField(record, "events", parseMetaEvent),
  };
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
          defaultCapabilities: optionalStringArrayField(
            profile.defaultCapabilities,
            "profile.defaultCapabilities",
          ),
          defaultSkillVersionIds: optionalStringArrayField(
            profile.defaultSkillVersionIds,
            "profile.defaultSkillVersionIds",
          ),
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
          skillVersionIds: Array.isArray(agent.skillVersionIds)
            ? asStringArray(agent.skillVersionIds, "agent.skillVersionIds")
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
      const route =
        record.route && typeof record.route === "object" && !Array.isArray(record.route)
          ? (record.route as Record<string, unknown>)
          : {};
      const traffic =
        route?.traffic && typeof route.traffic === "object" && !Array.isArray(route.traffic)
          ? (route.traffic as Record<string, unknown>)
          : undefined;
      const parsedRoute: RouteRule = {
        id: asString(route?.id, "route.id"),
        source: asString(route?.source, "route.source"),
        match: asString(route?.match, "route.match"),
        matchMode: optionalRouteMatchMode(route.matchMode),
        matchField: optionalRouteMatchField(route.matchField),
        caseSensitive: optionalBoolean(route.caseSensitive, "route.caseSensitive"),
        target: asString(route?.target, "route.target"),
        enabled: route.enabled !== false,
        priority: optionalNonNegativeInteger(route.priority, "route.priority"),
        traffic: traffic
          ? {
              sampleRate: optionalFraction(traffic.sampleRate, "route.traffic.sampleRate"),
              experimentId: optionalString(traffic.experimentId),
            }
          : undefined,
      };
      validateRouteMatcher(parsedRoute);
      return {
        type,
        route: parsedRoute,
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
      const parsed = executorBindingSchema.parse({
        kind: binding.kind,
        profileId: binding.profileId,
        adapterId: binding.adapterId,
        modelOverride: binding.modelOverride,
        timeoutMs: binding.timeoutMs,
      });
      return {
        type,
        binding: {
          id: asString(binding?.id, "binding.id"),
          ...parsed,
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

import type { OrchestrationRepository } from "./repository";
import type { GatePolicy, GatePolicyScope, GateResolver, GateType } from "./types";

const GATE_TYPE_ALIASES: Record<string, GateType> = {
  goal_accept: "goal_accept",
  goalAccept: "goal_accept",
  spec_accept: "spec_accept",
  specAccept: "spec_accept",
  plan_accept: "plan_accept",
  planAccept: "plan_accept",
  slice_gate: "slice_gate",
  sliceGate: "slice_gate",
  irreversible_action: "irreversible_action",
  irreversibleAction: "irreversible_action",
  budget_exceeded: "budget_exceeded",
  budgetExceeded: "budget_exceeded",
  drift_escalation: "drift_escalation",
  driftEscalation: "drift_escalation",
};

type ScopeKeys = {
  goalId?: string;
  specId?: string;
  sliceId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeResolver(value: unknown): GateResolver | undefined {
  return value === "user" || value === "policy" ? value : undefined;
}

function normalizeGateResolvers(
  value: unknown,
): Partial<Record<GateType, GateResolver>> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const gates: Partial<Record<GateType, GateResolver>> = {};
  for (const [key, rawResolver] of Object.entries(record)) {
    const gateType = GATE_TYPE_ALIASES[key];
    const resolver = normalizeResolver(rawResolver);
    if (gateType && resolver) {
      gates[gateType] = resolver;
    }
  }
  return Object.keys(gates).length > 0 ? gates : undefined;
}

function normalizePolicyScope(value: unknown): GatePolicyScope | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const scope: GatePolicyScope = {};
  const defaultResolver = normalizeResolver(record.default_resolver ?? record.defaultResolver);
  if (defaultResolver) {
    scope.default_resolver = defaultResolver;
  }
  const gates = normalizeGateResolvers(record.gates);
  if (gates) {
    scope.gates = gates;
  }
  return scope.default_resolver || scope.gates ? scope : undefined;
}

function normalizeScopedPolicies(value: unknown): Record<string, GatePolicyScope> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const scopes: Record<string, GatePolicyScope> = {};
  for (const [id, rawScope] of Object.entries(record)) {
    const scope = normalizePolicyScope(rawScope);
    if (scope) {
      scopes[id] = scope;
    }
  }
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

export function normalizeGatePolicyInput(value: unknown): GatePolicy | undefined {
  const base = normalizePolicyScope(value);
  const record = asRecord(value);
  if (!record) {
    return base;
  }

  const policy: GatePolicy = {
    ...(base ?? {}),
  };
  const goals = normalizeScopedPolicies(record.goals);
  const specs = normalizeScopedPolicies(record.specs);
  const slices = normalizeScopedPolicies(record.slices);
  if (goals) policy.goals = goals;
  if (specs) policy.specs = specs;
  if (slices) policy.slices = slices;

  return policy.default_resolver || policy.gates || policy.goals || policy.specs || policy.slices
    ? policy
    : undefined;
}

export function describeGatePolicy(policy: GatePolicy | undefined): Record<string, unknown> {
  return {
    configured: policy !== undefined,
    default_resolver: policy?.default_resolver ?? "user",
    gate_resolvers: policy?.gates ?? {},
    goal_scope_count: Object.keys(policy?.goals ?? {}).length,
    spec_scope_count: Object.keys(policy?.specs ?? {}).length,
    slice_scope_count: Object.keys(policy?.slices ?? {}).length,
  };
}

export function resolveGatePolicy(params: {
  repo: OrchestrationRepository;
  policy: GatePolicy | undefined;
  gate_type: GateType;
  scope?: string;
  subject_ref: string;
}): GateResolver {
  const keys = inferScopeKeys(params.repo, params.scope, params.subject_ref);
  const scopes = [
    params.policy,
    keys.goalId ? params.policy?.goals?.[keys.goalId] : undefined,
    keys.specId ? params.policy?.specs?.[keys.specId] : undefined,
    keys.sliceId ? params.policy?.slices?.[keys.sliceId] : undefined,
  ].filter((scope): scope is GatePolicyScope => scope !== undefined);

  let resolver: GateResolver = "user";
  for (const scope of scopes) {
    resolver = scope.default_resolver ?? resolver;
    resolver = scope.gates?.[params.gate_type] ?? resolver;
  }
  return resolver;
}

function inferScopeKeys(
  repo: OrchestrationRepository,
  scope: string | undefined,
  subjectRef: string,
): ScopeKeys {
  const keys: ScopeKeys = {};
  applyScopeRef(keys, scope);
  applySubjectRef(repo, keys, subjectRef);
  return keys;
}

function applyScopeRef(keys: ScopeKeys, scope: string | undefined): void {
  if (!scope) {
    return;
  }
  const match = /^(goal|spec|slice):(.+)$/.exec(scope);
  if (!match?.[1] || !match[2]) {
    return;
  }
  if (match[1] === "goal") keys.goalId = match[2];
  if (match[1] === "spec") keys.specId = match[2];
  if (match[1] === "slice") keys.sliceId = match[2];
}

function applySubjectRef(repo: OrchestrationRepository, keys: ScopeKeys, subjectRef: string): void {
  const sliceMatch = /^slice:(.+)$/.exec(subjectRef);
  if (sliceMatch?.[1]) {
    keys.sliceId = sliceMatch[1];
    applyTaskPlanKeys(repo, keys, sliceMatch[1]);
    return;
  }

  const goalMatch = /^goal:([^:]+)(?::v\d+)?$/.exec(subjectRef);
  if (goalMatch?.[1]) {
    keys.goalId = goalMatch[1];
    return;
  }

  const specMatch = /^spec:([^:]+)(?::v\d+)?$/.exec(subjectRef);
  if (specMatch?.[1]) {
    keys.specId = specMatch[1];
    return;
  }

  const revisionMatch = /^plan_revision:(.+)$/.exec(subjectRef);
  if (revisionMatch?.[1]) {
    const revision = repo.loadPlanRevision(revisionMatch[1]);
    keys.goalId = keys.goalId ?? revision?.goal_id;
    keys.specId = keys.specId ?? revision?.spec_id;
  }
}

function applyTaskPlanKeys(repo: OrchestrationRepository, keys: ScopeKeys, taskId: string): void {
  const definition = repo.loadTaskDefinition(taskId);
  const plan = repo.loadPlan();
  if (plan && repo.taskBelongsToPlan(definition, plan)) {
    keys.goalId = keys.goalId ?? plan.goal_id;
    keys.specId = keys.specId ?? plan.spec_id;
  }
}

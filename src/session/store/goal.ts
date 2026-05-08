import type {
  JsonObject,
  JsonValue,
  SessionExtensionRecord,
  SessionGoalSnapshot,
  SessionGoalStatus,
  SessionGoalUpdateSource,
} from "../types";
import { clearExtension, createExtensionRecord, getExtension, patchExtension } from "./extensions";
import { buildId, now } from "./helpers";
import type { SessionStoreState } from "./state";

export const GOAL_EXTENSION_NAMESPACE = "goal";
export const GOAL_EXTENSION_SCHEMA_VERSION = 1;
export const GOAL_EXTENSION_OWNER = {
  kind: "skill" as const,
  id: "persistent-goal",
  version: "1.0.0",
};
export const GOAL_EXTENSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type GoalStatusUpdate = {
  message?: string;
  evidence?: string[];
  source?: SessionGoalUpdateSource;
};

export function selectGoalSnapshot(snapshot: {
  goal?: SessionGoalSnapshot | null;
  extensions?: Record<string, SessionExtensionRecord>;
}): SessionGoalSnapshot | null {
  const extension = getExtension(snapshot, GOAL_EXTENSION_NAMESPACE);
  if (extension) {
    return goalFromExtension(extension);
  }
  return snapshot.goal
    ? { ...snapshot.goal, evidence: snapshot.goal.evidence?.map((item) => item) }
    : null;
}

export function createGoal(
  state: SessionStoreState,
  options: {
    objective: string;
    tokenBudget?: number;
    message?: string;
  },
): string {
  const goalId = buildId("goal");
  const statePayload: JsonObject = {
    objective: options.objective,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    elapsedMs: 0,
    continuationCount: 0,
    message: options.message ?? "Goal active.",
  };
  if (options.tokenBudget !== undefined) {
    statePayload.tokenBudget = options.tokenBudget;
  }

  const record = createExtensionRecord({
    namespace: GOAL_EXTENSION_NAMESPACE,
    instanceId: goalId,
    schemaVersion: GOAL_EXTENSION_SCHEMA_VERSION,
    owner: GOAL_EXTENSION_OWNER,
    state: statePayload,
    cleanupPolicy: {
      mode: "ttl",
      ttlMs: GOAL_EXTENSION_RETENTION_MS,
      description:
        "clear_goal removes live state immediately; completed goals are retained briefly for audit.",
    },
  });
  record.state.createdAt = record.createdAt;
  record.state.updatedAt = record.updatedAt;
  state.snapshot.extensions[GOAL_EXTENSION_NAMESPACE] = record;
  state.snapshot.goal = null;
  state.snapshot.session.lastActivityAt = record.updatedAt;
  state.goalChanged = true;
  state.extensionsChanged = true;
  state.sessionChanged = true;
  return goalId;
}

export function updateGoalStatus(
  state: SessionStoreState,
  status: SessionGoalStatus,
  update?: string | GoalStatusUpdate,
  options?: { expectedGoalId?: string; expectedRevision?: number },
): void {
  const normalized = normalizeGoalStatusUpdate(update);
  patchExtension(
    state,
    GOAL_EXTENSION_NAMESPACE,
    (record) => {
      const updatedAt = now();
      record.state.status = status;
      record.state.updatedAt = updatedAt;
      record.state.message = normalized.message ?? defaultGoalMessage(status);
      if (normalized.evidence) {
        record.state.evidence = normalized.evidence;
      }
      if (normalized.source) {
        record.state.updateSource = normalized.source;
      }
      if (status === "complete") {
        record.state.completedAt = updatedAt;
        if (normalized.source) {
          record.state.completionSource = normalized.source;
        }
        record.lifecycle = "completed";
        record.retainUntil = new Date(
          Date.parse(updatedAt) + GOAL_EXTENSION_RETENTION_MS,
        ).toISOString();
      } else {
        delete record.state.completedAt;
        delete record.state.completionSource;
        record.lifecycle = "active";
        delete record.retainUntil;
      }
      return record;
    },
    {
      instanceId: options?.expectedGoalId,
      expectedRevision: options?.expectedRevision,
    },
  );
  state.goalChanged = true;
}

export function clearGoal(state: SessionStoreState): void {
  if (clearExtension(state, GOAL_EXTENSION_NAMESPACE)) {
    state.snapshot.goal = null;
    state.goalChanged = true;
  }
}

export function accountGoalTurn(
  state: SessionStoreState,
  options: {
    turnId: string;
    inputTokens?: number;
    outputTokens?: number;
    elapsedMs: number;
    continuation: boolean;
    usedTools: boolean;
  },
): void {
  const current = selectGoalSnapshot(state.snapshot);
  if (!current) {
    return;
  }

  patchExtension(state, GOAL_EXTENSION_NAMESPACE, (record) => {
    const goal = goalFromExtension(record);
    if (!goal) {
      return record;
    }
    const updatedAt = now();
    const inputTokens = goal.inputTokens + (options.inputTokens ?? 0);
    const outputTokens = goal.outputTokens + (options.outputTokens ?? 0);
    record.state.inputTokens = inputTokens;
    record.state.outputTokens = outputTokens;
    record.state.totalTokens = inputTokens + outputTokens;
    record.state.elapsedMs = goal.elapsedMs + Math.max(0, Math.round(options.elapsedMs));
    record.state.lastTurnId = options.turnId;
    record.state.updatedAt = updatedAt;
    if (options.continuation) {
      record.state.continuationCount = goal.continuationCount + 1;
    }

    if (
      goal.status === "active" &&
      goal.tokenBudget &&
      inputTokens + outputTokens >= goal.tokenBudget
    ) {
      record.state.status = "budget_limited";
      record.state.message = "Goal stopped after reaching its token budget.";
    } else if (goal.status === "active" && options.continuation && !options.usedTools) {
      record.state.status = "paused";
      record.state.message =
        "Goal paused after a continuation turn completed without tool activity.";
    }

    return record;
  });
  state.goalChanged = true;
}

export function goalFromExtension(
  record: SessionExtensionRecord | null,
): SessionGoalSnapshot | null {
  if (!record || record.namespace !== GOAL_EXTENSION_NAMESPACE) {
    return null;
  }
  const state = record.state;
  const objective = stringValue(state.objective);
  const status = goalStatusValue(state.status);
  const createdAt = stringValue(state.createdAt) ?? record.createdAt;
  const updatedAt = stringValue(state.updatedAt) ?? record.updatedAt;
  if (!objective || !status) {
    return null;
  }
  const goal: SessionGoalSnapshot = {
    goalId: record.instanceId,
    objective,
    status,
    createdAt,
    updatedAt,
    inputTokens: numberValue(state.inputTokens) ?? 0,
    outputTokens: numberValue(state.outputTokens) ?? 0,
    totalTokens: numberValue(state.totalTokens) ?? 0,
    elapsedMs: numberValue(state.elapsedMs) ?? 0,
    continuationCount: numberValue(state.continuationCount) ?? 0,
  };
  assignOptionalString(goal, "completedAt", state.completedAt);
  assignOptionalNumber(goal, "tokenBudget", state.tokenBudget);
  assignOptionalString(goal, "lastTurnId", state.lastTurnId);
  assignOptionalString(goal, "message", state.message);
  const evidence = stringArrayValue(state.evidence);
  if (evidence) {
    goal.evidence = evidence;
  }
  const updateSource = updateSourceValue(state.updateSource);
  if (updateSource) {
    goal.updateSource = updateSource;
  }
  const completionSource = updateSourceValue(state.completionSource);
  if (completionSource) {
    goal.completionSource = completionSource;
  }
  return goal;
}

function defaultGoalMessage(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "Goal active.";
    case "paused":
      return "Goal paused.";
    case "budget_limited":
      return "Goal stopped after reaching its token budget.";
    case "complete":
      return "Goal complete.";
  }
}

function normalizeGoalStatusUpdate(
  update: string | GoalStatusUpdate | undefined,
): GoalStatusUpdate {
  if (typeof update === "string") {
    return { message: update };
  }
  if (!update) {
    return {};
  }
  return {
    message: update.message,
    evidence: update.evidence?.filter((item) => item.trim().length > 0),
    source: update.source,
  };
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function goalStatusValue(value: JsonValue | undefined): SessionGoalStatus | undefined {
  return value === "active" ||
    value === "paused" ||
    value === "budget_limited" ||
    value === "complete"
    ? value
    : undefined;
}

function updateSourceValue(value: JsonValue | undefined): SessionGoalUpdateSource | undefined {
  return value === "user" || value === "model" || value === "runtime" ? value : undefined;
}

function assignOptionalString<K extends "completedAt" | "lastTurnId" | "message">(
  goal: SessionGoalSnapshot,
  key: K,
  value: JsonValue | undefined,
): void {
  const resolved = stringValue(value);
  if (resolved !== undefined) {
    goal[key] = resolved;
  }
}

function assignOptionalNumber<K extends "tokenBudget">(
  goal: SessionGoalSnapshot,
  key: K,
  value: JsonValue | undefined,
): void {
  const resolved = numberValue(value);
  if (resolved !== undefined) {
    goal[key] = resolved;
  }
}

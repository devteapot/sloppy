import type {
  JsonValue,
  SessionExtensionRecord,
  SessionGoalSnapshot,
  SessionGoalStatus,
  SessionGoalUpdateSource,
} from "../types";
import { getExtension } from "./extensions";

export const GOAL_EXTENSION_NAMESPACE = "goal";
export const GOAL_EXTENSION_SCHEMA_VERSION = 1;
export const GOAL_EXTENSION_OWNER = {
  kind: "skill" as const,
  id: "persistent-goal",
  version: "1.0.0",
};
export const GOAL_EXTENSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

export function goalSnapshotToExtension(goal: SessionGoalSnapshot): SessionExtensionRecord {
  const updatedAt = goal.updatedAt;
  const state: SessionExtensionRecord["state"] = {
    objective: goal.objective,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt,
    inputTokens: goal.inputTokens,
    outputTokens: goal.outputTokens,
    totalTokens: goal.totalTokens,
    elapsedMs: goal.elapsedMs,
    continuationCount: goal.continuationCount,
    message: goal.message ?? "",
  };
  if (goal.completedAt) state.completedAt = goal.completedAt;
  if (goal.tokenBudget !== undefined) state.tokenBudget = goal.tokenBudget;
  if (goal.lastTurnId) state.lastTurnId = goal.lastTurnId;
  if (goal.evidence) state.evidence = goal.evidence;
  if (goal.updateSource) state.updateSource = goal.updateSource;
  if (goal.completionSource) state.completionSource = goal.completionSource;

  return {
    namespace: GOAL_EXTENSION_NAMESPACE,
    instanceId: goal.goalId,
    schemaVersion: GOAL_EXTENSION_SCHEMA_VERSION,
    revision: 1,
    owner: GOAL_EXTENSION_OWNER,
    state,
    lifecycle: goal.status === "complete" ? "completed" : "active",
    cleanupPolicy: {
      mode: "ttl",
      ttlMs: GOAL_EXTENSION_RETENTION_MS,
      description:
        "clear_goal removes live state immediately; completed goals are retained briefly for audit.",
    },
    retainUntil:
      goal.status === "complete"
        ? new Date(Date.parse(updatedAt) + GOAL_EXTENSION_RETENTION_MS).toISOString()
        : undefined,
    createdAt: goal.createdAt,
    updatedAt,
    lastUsedAt: updatedAt,
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

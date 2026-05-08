import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentSessionSnapshot, SessionExtensionRecord, SessionGoalSnapshot } from "../types";
import {
  GOAL_EXTENSION_NAMESPACE,
  GOAL_EXTENSION_OWNER,
  GOAL_EXTENSION_RETENTION_MS,
  GOAL_EXTENSION_SCHEMA_VERSION,
} from "./goal";
import { cloneSnapshot } from "./state";

const RECOVERY_MESSAGE =
  "Session restored after process restart; the in-flight turn could not be resumed.";
const GOAL_RECOVERY_MESSAGE =
  "Goal paused after process restart because its in-flight turn could not be resumed.";
const SESSION_SNAPSHOT_KIND = "sloppy.session.snapshot";
const SESSION_SNAPSHOT_SCHEMA_VERSION = 2;
const SUPPORTED_SESSION_SNAPSHOT_SCHEMA_VERSIONS = new Set([1, 2]);

type PersistedSessionSnapshotEnvelope = {
  kind: typeof SESSION_SNAPSHOT_KIND;
  schema_version: number;
  saved_at: string;
  snapshot: AgentSessionSnapshot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is AgentSessionSnapshot {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.session) &&
    isRecord(value.llm) &&
    isRecord(value.turn) &&
    (value.goal === undefined || value.goal === null || isRecord(value.goal)) &&
    (value.extensions === undefined || isRecord(value.extensions)) &&
    Array.isArray(value.transcript) &&
    Array.isArray(value.activity) &&
    Array.isArray(value.approvals) &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.apps)
  );
}

function unwrapPersistedSessionSnapshot(parsed: unknown, path: string): AgentSessionSnapshot {
  if (isSnapshot(parsed)) {
    return migrateSessionSnapshot(parsed);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Persisted session snapshot at ${path} is malformed.`);
  }
  if (parsed.kind !== SESSION_SNAPSHOT_KIND) {
    throw new Error(`Persisted session snapshot at ${path} has unsupported kind.`);
  }
  if (
    typeof parsed.schema_version !== "number" ||
    !SUPPORTED_SESSION_SNAPSHOT_SCHEMA_VERSIONS.has(parsed.schema_version)
  ) {
    throw new Error(
      `Persisted session snapshot at ${path} has unsupported schema_version ${String(
        parsed.schema_version,
      )}.`,
    );
  }
  if (!isSnapshot(parsed.snapshot)) {
    throw new Error(`Persisted session snapshot at ${path} has malformed snapshot payload.`);
  }
  return migrateSessionSnapshot(parsed.snapshot);
}

export function loadPersistedSessionSnapshot(path: string): AgentSessionSnapshot | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return unwrapPersistedSessionSnapshot(parsed, path);
}

export function recoverPersistedSessionSnapshot(
  snapshot: AgentSessionSnapshot,
  path: string,
): AgentSessionSnapshot {
  const restored = cloneSnapshot(snapshot);
  const restoredAt = new Date().toISOString();
  const staleTurnId = restored.turn.turnId;
  const hadInFlightTurn =
    restored.turn.state === "running" || restored.turn.state === "waiting_approval";

  restored.session.status = "active";
  restored.session.clientCount = 0;
  restored.session.connectedClients = [];
  restored.session.restoredAt = restoredAt;
  restored.session.persistencePath = path;

  if (!hadInFlightTurn) {
    restored.goal = null;
    return restored;
  }

  restored.session.lastError = RECOVERY_MESSAGE;
  restored.session.recoveredAfterRestart = true;
  const goal = restored.goal;
  if (goal?.status === "active") {
    const extension = restored.extensions[GOAL_EXTENSION_NAMESPACE];
    if (extension) {
      extension.revision += 1;
      extension.updatedAt = restoredAt;
      extension.lastUsedAt = restoredAt;
      extension.state.status = "paused";
      extension.state.updatedAt = restoredAt;
      extension.state.message = GOAL_RECOVERY_MESSAGE;
      extension.state.updateSource = "runtime";
    }
  }
  restored.goal = null;
  restored.turn = {
    ...restored.turn,
    state: "error",
    phase: "complete",
    updatedAt: restoredAt,
    message: RECOVERY_MESSAGE,
    lastError: RECOVERY_MESSAGE,
    waitingOn: null,
  };

  for (const message of restored.transcript) {
    if (message.turnId === staleTurnId && message.state === "streaming") {
      message.state = "error";
      message.error = RECOVERY_MESSAGE;
    }
  }

  for (const item of restored.activity) {
    if (item.turnId === staleTurnId && item.status === "running") {
      item.status = "error";
      item.summary = RECOVERY_MESSAGE;
      item.updatedAt = restoredAt;
      item.completedAt = restoredAt;
    }
  }

  for (const approval of restored.approvals) {
    if (approval.status === "pending") {
      approval.status = "expired";
      approval.resolvedAt = restoredAt;
      approval.canApprove = false;
      approval.canReject = false;
    }
  }

  for (const task of restored.tasks) {
    if (task.status === "running") {
      task.status = "superseded";
      task.updatedAt = restoredAt;
      task.error = RECOVERY_MESSAGE;
      task.canCancel = false;
    }
  }

  return restored;
}

export function persistSessionSnapshot(path: string, snapshot: AgentSessionSnapshot): void {
  const serializable = cloneSnapshot(snapshot);
  serializable.session.clientCount = 0;
  serializable.session.connectedClients = [];
  serializable.session.persistencePath = path;
  serializable.goal = null;
  const envelope: PersistedSessionSnapshotEnvelope = {
    kind: SESSION_SNAPSHOT_KIND,
    schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    snapshot: serializable,
  };

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function migrateSessionSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  const migrated = cloneSnapshot({
    ...snapshot,
    extensions: snapshot.extensions ?? {},
  });
  if (migrated.goal && !migrated.extensions[GOAL_EXTENSION_NAMESPACE]) {
    migrated.extensions[GOAL_EXTENSION_NAMESPACE] = goalSnapshotToExtension(migrated.goal);
  }
  migrated.goal = null;
  return migrated;
}

function goalSnapshotToExtension(goal: SessionGoalSnapshot): SessionExtensionRecord {
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentSessionSnapshot } from "../types";
import { cloneSnapshot } from "./state";

const RECOVERY_MESSAGE =
  "Session restored after process restart; the in-flight turn could not be resumed.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is AgentSessionSnapshot {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.session) &&
    isRecord(value.llm) &&
    isRecord(value.turn) &&
    Array.isArray(value.transcript) &&
    Array.isArray(value.activity) &&
    Array.isArray(value.approvals) &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.apps)
  );
}

export function loadPersistedSessionSnapshot(path: string): AgentSessionSnapshot | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isSnapshot(parsed)) {
    throw new Error(`Persisted session snapshot at ${path} is malformed.`);
  }
  return parsed;
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
    return restored;
  }

  restored.session.lastError = RECOVERY_MESSAGE;
  restored.session.recoveredAfterRestart = true;
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
    }
  }

  return restored;
}

export function persistSessionSnapshot(path: string, snapshot: AgentSessionSnapshot): void {
  const serializable = cloneSnapshot(snapshot);
  serializable.session.clientCount = 0;
  serializable.session.connectedClients = [];
  serializable.session.persistencePath = path;

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

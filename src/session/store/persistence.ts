import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ConversationHistorySnapshot } from "../../llm/types";
import type { AgentSessionSnapshot } from "../types";
import { cloneSnapshot } from "./state";

const RECOVERY_MESSAGE =
  "Session restored after process restart; the in-flight turn could not be resumed.";
const SESSION_SNAPSHOT_KIND = "sloppy.session.snapshot";
const SESSION_SNAPSHOT_SCHEMA_VERSION = 2;

export type SessionSnapshotMigrator = (
  snapshot: AgentSessionSnapshot,
) => AgentSessionSnapshot | undefined;

export type SessionSnapshotRecoveryContext = {
  path: string;
  restoredAt: string;
  staleTurnId: string | null;
  hadInFlightTurn: boolean;
  recoveryMessage: string;
};

export type SessionSnapshotRecoverer = (
  snapshot: AgentSessionSnapshot,
  context: SessionSnapshotRecoveryContext,
) => AgentSessionSnapshot | undefined;

type SessionSnapshotHooks = {
  migrators?: readonly SessionSnapshotMigrator[];
  recoverers?: readonly SessionSnapshotRecoverer[];
};

type PersistedSessionSnapshotEnvelope = {
  kind: typeof SESSION_SNAPSHOT_KIND;
  schema_version: number;
  saved_at: string;
  snapshot: AgentSessionSnapshot;
  conversation?: ConversationHistorySnapshot;
};

export type PersistedSessionData = {
  snapshot: AgentSessionSnapshot;
  conversation?: ConversationHistorySnapshot;
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

function isConversationContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.mediaType === "string" && typeof value.data === "string";
    case "tool_use":
      return (
        typeof value.id === "string" && typeof value.name === "string" && isRecord(value.input)
      );
    case "tool_result":
      return (
        typeof value.toolUseId === "string" &&
        typeof value.content === "string" &&
        (value.isError === undefined || typeof value.isError === "boolean")
      );
    case "provider_continuation":
      return (
        ["reasoning", "assistant_message", "tool_call"].includes(String(value.purpose)) &&
        isRecord(value.issuer) &&
        typeof value.issuer.protocol === "string" &&
        typeof value.issuer.provider === "string" &&
        typeof value.issuer.model === "string" &&
        typeof value.issuer.scope === "string"
      );
    default:
      return false;
  }
}

function isConversationEntry(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.message)) return false;
  return (
    ["user", "assistant", "tool", "summary"].includes(String(value.kind)) &&
    ["user", "assistant"].includes(String(value.message.role)) &&
    Array.isArray(value.message.content) &&
    value.message.content.every(isConversationContentBlock)
  );
}

function isConversationHistorySnapshot(value: unknown): value is ConversationHistorySnapshot {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    Array.isArray(value.archive) &&
    value.archive.every(isConversationEntry) &&
    Array.isArray(value.active) &&
    value.active.every(isConversationEntry) &&
    Array.isArray(value.compactions) &&
    value.compactions.every(
      (compaction) =>
        isRecord(compaction) &&
        typeof compaction.compactedAt === "string" &&
        typeof compaction.summary === "string" &&
        typeof compaction.archivedEntryCount === "number" &&
        typeof compaction.retainedEntryCount === "number",
    )
  );
}

function applySnapshotMigrators(
  snapshot: AgentSessionSnapshot,
  migrators: readonly SessionSnapshotMigrator[] = [],
): AgentSessionSnapshot {
  let current = cloneSnapshot({
    ...snapshot,
    extensions: snapshot.extensions ?? {},
    queue: snapshot.queue ?? [],
  });
  for (const migrator of migrators) {
    const working = cloneSnapshot(current);
    current = cloneSnapshot(migrator(working) ?? working);
  }
  return current;
}

function applySnapshotRecoverers(
  snapshot: AgentSessionSnapshot,
  context: SessionSnapshotRecoveryContext,
  recoverers: readonly SessionSnapshotRecoverer[] = [],
): AgentSessionSnapshot {
  let current = cloneSnapshot(snapshot);
  for (const recoverer of recoverers) {
    const working = cloneSnapshot(current);
    current = cloneSnapshot(recoverer(working, context) ?? working);
  }
  return current;
}

function unwrapPersistedSessionData(
  parsed: unknown,
  path: string,
  hooks: SessionSnapshotHooks = {},
): PersistedSessionData {
  if (!isRecord(parsed)) {
    throw new Error(`Persisted session snapshot at ${path} is malformed.`);
  }
  if (parsed.kind !== SESSION_SNAPSHOT_KIND) {
    throw new Error(`Persisted session snapshot at ${path} has unsupported kind.`);
  }
  if (parsed.schema_version !== SESSION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Persisted session snapshot at ${path} has unsupported schema_version ${String(
        parsed.schema_version,
      )}.`,
    );
  }
  if (!isSnapshot(parsed.snapshot)) {
    throw new Error(`Persisted session snapshot at ${path} has malformed snapshot payload.`);
  }
  if (parsed.conversation !== undefined && !isConversationHistorySnapshot(parsed.conversation)) {
    throw new Error(`Persisted session snapshot at ${path} has malformed conversation payload.`);
  }
  const conversation = parsed.conversation ? structuredClone(parsed.conversation) : undefined;
  return {
    snapshot: applySnapshotMigrators(parsed.snapshot, hooks.migrators),
    conversation,
  };
}

export function loadPersistedSessionData(
  path: string,
  hooks: SessionSnapshotHooks = {},
): PersistedSessionData | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return unwrapPersistedSessionData(parsed, path, hooks);
}

export function loadPersistedSessionSnapshot(
  path: string,
  hooks: SessionSnapshotHooks = {},
): AgentSessionSnapshot | null {
  return loadPersistedSessionData(path, hooks)?.snapshot ?? null;
}

export function recoverPersistedSessionSnapshot(
  snapshot: AgentSessionSnapshot,
  path: string,
  hooks: SessionSnapshotHooks = {},
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

  const recoveryContext: SessionSnapshotRecoveryContext = {
    path,
    restoredAt,
    staleTurnId,
    hadInFlightTurn,
    recoveryMessage: RECOVERY_MESSAGE,
  };

  // goal is a projection recomputed from extensions["goal"]; never persisted.
  if (!hadInFlightTurn) {
    restored.goal = null;
    return applySnapshotRecoverers(restored, recoveryContext, hooks.recoverers);
  }

  restored.session.lastError = RECOVERY_MESSAGE;
  restored.session.recoveredAfterRestart = true;
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

  return applySnapshotRecoverers(restored, recoveryContext, hooks.recoverers);
}

export function persistSessionSnapshot(
  path: string,
  snapshot: AgentSessionSnapshot,
  conversation?: ConversationHistorySnapshot,
): void {
  const serializable = cloneSnapshot(snapshot);
  serializable.session.clientCount = 0;
  serializable.session.connectedClients = [];
  serializable.session.persistencePath = path;
  // goal is a projection recomputed from extensions["goal"]; never persisted.
  serializable.goal = null;
  const envelope: PersistedSessionSnapshotEnvelope = {
    kind: SESSION_SNAPSHOT_KIND,
    schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    snapshot: serializable,
    conversation: conversation ? structuredClone(conversation) : undefined,
  };

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

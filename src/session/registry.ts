import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { SloppyConfig } from "../config/schema";
import { loadPersistedSessionSnapshot } from "./store/persistence";
import type { AgentSessionSnapshot } from "./types";

export type SessionRegistryRecord = {
  sessionId: string;
  title?: string;
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  launchScopeKey?: string;
  launchRoot?: string;
  createdAt: string;
  lastActivityAt: string;
  snapshotPath?: string;
  archived?: boolean;
};

export type SessionRegistry = {
  kind: "sloppy.session.registry";
  schemaVersion: 1;
  launchScopeKey: string;
  launchRoot: string;
  resumeSessionId?: string;
  sessions: SessionRegistryRecord[];
};

type PersistedSessionRegistry = {
  kind: "sloppy.session.registry";
  schema_version: 1;
  launch_scope_key: string;
  launch_root: string;
  resume_session_id?: string | null;
  sessions: PersistedSessionRecord[];
};

type PersistedSessionRecord = {
  session_id: string;
  title?: string;
  workspace_root?: string;
  workspace_id?: string;
  project_id?: string;
  launch_scope_key?: string;
  launch_root?: string;
  created_at: string;
  last_activity_at: string;
  snapshot_path?: string;
  archived?: boolean;
};

export function sessionPersistenceDir(config: SloppyConfig): string | null {
  if (config.session?.persistSnapshots !== true) {
    return null;
  }
  return resolve(
    config.plugins.filesystem.root,
    config.session.persistenceDir ?? ".sloppy/sessions",
  );
}

export function sessionRegistryPath(config: SloppyConfig, launchScopeKey: string): string | null {
  const dir = sessionPersistenceDir(config);
  return dir ? join(dir, `index-${launchScopeKey}.json`) : null;
}

export function snapshotPathForSession(config: SloppyConfig, sessionId: string): string | null {
  const dir = sessionPersistenceDir(config);
  return dir ? join(dir, `${sanitizePathSegment(sessionId)}.json`) : null;
}

export function loadSessionRegistry(options: {
  config: SloppyConfig;
  launchScopeKey: string;
  launchRoot: string;
}): { path: string; registry: SessionRegistry } | null {
  const path = sessionRegistryPath(options.config, options.launchScopeKey);
  if (!path) {
    return null;
  }
  const loaded = existsSync(path)
    ? parseRegistry(readFileSync(path, "utf8"), path, options.launchScopeKey, options.launchRoot)
    : scanSessionSnapshots({
        config: options.config,
        launchScopeKey: options.launchScopeKey,
        launchRoot: options.launchRoot,
      });
  return { path, registry: loaded };
}

export function persistSessionRegistry(path: string, registry: SessionRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  const persisted: PersistedSessionRegistry = {
    kind: "sloppy.session.registry",
    schema_version: 1,
    launch_scope_key: registry.launchScopeKey,
    launch_root: registry.launchRoot,
    resume_session_id: registry.resumeSessionId ?? null,
    sessions: registry.sessions.map((record) => ({
      session_id: record.sessionId,
      title: record.title,
      workspace_root: record.workspaceRoot,
      workspace_id: record.workspaceId,
      project_id: record.projectId,
      launch_scope_key: record.launchScopeKey,
      launch_root: record.launchRoot,
      created_at: record.createdAt,
      last_activity_at: record.lastActivityAt,
      snapshot_path: record.snapshotPath,
      archived: record.archived,
    })),
  };
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

export function recordFromSnapshot(
  snapshot: AgentSessionSnapshot,
  snapshotPath?: string,
): SessionRegistryRecord {
  return {
    sessionId: snapshot.session.sessionId,
    title: snapshot.session.title,
    workspaceRoot: snapshot.session.workspaceRoot,
    workspaceId: snapshot.session.workspaceId,
    projectId: snapshot.session.projectId,
    launchScopeKey: snapshot.session.launchScope?.key,
    launchRoot: snapshot.session.launchScope?.root,
    createdAt: snapshot.session.startedAt,
    lastActivityAt: snapshot.session.lastActivityAt,
    snapshotPath: snapshotPath ?? snapshot.session.persistencePath,
    archived: false,
  };
}

function parseRegistry(
  content: string,
  path: string,
  launchScopeKey: string,
  launchRoot: string,
): SessionRegistry {
  const value = JSON.parse(content) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Session registry ${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "sloppy.session.registry" || record.schema_version !== 1) {
    throw new Error(`Unsupported session registry ${path}.`);
  }
  const sessions = Array.isArray(record.sessions)
    ? record.sessions.flatMap((item) => parseRecord(item))
    : [];
  return {
    kind: "sloppy.session.registry",
    schemaVersion: 1,
    launchScopeKey: asString(record.launch_scope_key) ?? launchScopeKey,
    launchRoot: asString(record.launch_root) ?? launchRoot,
    resumeSessionId: asString(record.resume_session_id) ?? undefined,
    sessions,
  };
}

function parseRecord(value: unknown): SessionRegistryRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const sessionId = asString(record.session_id);
  const createdAt = asString(record.created_at);
  const lastActivityAt = asString(record.last_activity_at) ?? createdAt;
  if (!sessionId || !createdAt || !lastActivityAt) {
    return [];
  }
  return [
    {
      sessionId,
      title: asString(record.title),
      workspaceRoot: asString(record.workspace_root),
      workspaceId: asString(record.workspace_id),
      projectId: asString(record.project_id),
      launchScopeKey: asString(record.launch_scope_key),
      launchRoot: asString(record.launch_root),
      createdAt,
      lastActivityAt,
      snapshotPath: asString(record.snapshot_path),
      archived: record.archived === true,
    },
  ];
}

function scanSessionSnapshots(options: {
  config: SloppyConfig;
  launchScopeKey: string;
  launchRoot: string;
}): SessionRegistry {
  const dir = sessionPersistenceDir(options.config);
  const sessions: SessionRegistryRecord[] = [];
  if (dir && existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json") || entry.startsWith("index-")) {
        continue;
      }
      const path = join(dir, entry);
      try {
        const snapshot = loadPersistedSessionSnapshot(path);
        if (!snapshot) {
          continue;
        }
        if (snapshot.session.launchScope?.key !== options.launchScopeKey) {
          continue;
        }
        sessions.push(recordFromSnapshot(snapshot, path));
      } catch {
        // Ignore non-session JSON files and corrupt snapshots during fallback scanning.
      }
    }
  }
  sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return {
    kind: "sloppy.session.registry",
    schemaVersion: 1,
    launchScopeKey: options.launchScopeKey,
    launchRoot: options.launchRoot,
    sessions,
    resumeSessionId: sessions.at(-1)?.sessionId,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "session";
}

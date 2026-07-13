import type { SloppyConfig } from "../config/schema";
import type { SessionRegistryRecord } from "./registry";
import type { SessionService } from "./service";
import type { ApprovalMode } from "./types";

export type SessionScopeInput = {
  workspace_id?: string;
  project_id?: string;
  title?: string;
  session_id?: string;
  approval_mode?: ApprovalMode;
};

export type SessionRecord = {
  sessionId: string;
  socketPath: string;
  runtimeStatus: "live" | "dormant";
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  launchScopeKey?: string;
  launchRoot?: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  snapshotPath?: string;
  archived?: boolean;
  service?: SessionService;
  unsubscribe?: () => void;
};

export type PublicSessionRecord = {
  sessionId: string;
  socketPath?: string;
  runtimeStatus: "live" | "dormant";
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  launchScopeKey?: string;
  launchRoot?: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  isResumeSession: boolean;
  turnState?: string;
  turnMessage?: string;
  queuedCount?: number;
  pendingApprovalCount?: number;
  runningTaskCount?: number;
  approvalMode?: ApprovalMode;
  goalStatus?: string;
  goalObjective?: string;
  goalTotalTokens?: number;
  [key: string]: unknown;
};

export type ScopeRecord = {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  root: string;
  configPath: string;
  description?: string;
};

export type ClientLease = {
  leaseId: string;
  selectedSessionId?: string;
  label?: string;
  connectedAt: string;
};

export function now(): string {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "session";
}

export function sessionSocketPath(sessionId: string): string {
  return `/tmp/slop/sloppy-session-${sanitizeSegment(sessionId)}.sock`;
}

export function defaultTitle(input: {
  workspaceId?: string;
  projectId?: string;
  fallback?: string;
}): string | undefined {
  if (input.fallback) {
    return input.fallback;
  }
  if (input.workspaceId && input.projectId) {
    return `${input.workspaceId}/${input.projectId}`;
  }
  return input.workspaceId;
}

export function recordFromRegistry(record: SessionRegistryRecord): SessionRecord {
  return {
    sessionId: record.sessionId,
    socketPath: "",
    runtimeStatus: "dormant",
    title: record.title,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    launchScopeKey: record.launchScopeKey,
    launchRoot: record.launchRoot,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    snapshotPath: record.snapshotPath,
    archived: record.archived,
  };
}

export function registryRecordFromSession(record: SessionRecord): SessionRegistryRecord {
  return {
    sessionId: record.sessionId,
    title: record.title,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    launchScopeKey: record.launchScopeKey,
    launchRoot: record.launchRoot,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    snapshotPath: record.snapshotPath,
    archived: record.archived,
  };
}

export function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function approvalModeParam(
  params: Record<string, unknown>,
  name: string,
): ApprovalMode | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === "normal" || value === "auto") {
    return value;
  }
  throw new Error(`${name} must be 'normal' or 'auto'.`);
}

export function sessionScopeInputFromParams(params: Record<string, unknown>): SessionScopeInput {
  return {
    workspace_id: stringParam(params, "workspace_id"),
    project_id: stringParam(params, "project_id"),
    title: stringParam(params, "title"),
    session_id: stringParam(params, "session_id"),
    approval_mode: approvalModeParam(params, "approval_mode"),
  };
}

export function scopesFromConfig(config: SloppyConfig): ScopeRecord[] {
  const registry = config.workspaces;
  if (!registry) {
    return [];
  }

  const scopes: ScopeRecord[] = [];
  for (const [workspaceId, workspace] of Object.entries(registry.items)) {
    scopes.push({
      id: workspaceId,
      workspaceId,
      name: workspace.name ?? workspaceId,
      description: workspace.description,
      root: workspace.root,
      configPath: workspace.configPath,
    });
    for (const [projectId, project] of Object.entries(workspace.projects)) {
      scopes.push({
        id: `${workspaceId}/${projectId}`,
        workspaceId,
        projectId,
        name: project.name ?? `${workspace.name ?? workspaceId}/${projectId}`,
        description: project.description,
        root: project.root,
        configPath: project.configPath,
      });
    }
  }
  return scopes.sort((left, right) => left.id.localeCompare(right.id));
}

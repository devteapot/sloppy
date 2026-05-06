import { resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import { getHomeConfigPath, getWorkspaceConfigPath, loadScopedConfig } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { SessionService } from "./service";
import { closeUnixListener, type UnixListener } from "./socket";

export type SessionScopeInput = {
  workspace_id?: string;
  project_id?: string;
  title?: string;
  session_id?: string;
};

export type SessionRecord = {
  sessionId: string;
  providerId: string;
  socketPath: string;
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  title?: string;
  createdAt: string;
  service: SessionService;
  unsubscribe: () => void;
};

type PublicSessionRecord = Omit<SessionRecord, "service" | "unsubscribe"> & {
  session_id: string;
  provider_id: string;
  socket_path: string;
  workspace_root?: string;
  workspace_id?: string;
  project_id?: string;
  created_at: string;
  turn_state: string;
  turn_message: string;
  goal_status: string;
  goal_objective?: string;
  goal_total_tokens: number;
  queued_count: number;
  pending_approval_count: number;
  running_task_count: number;
  last_activity_at: string;
};

type ScopeRecord = {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  root: string;
  configPath: string;
  description?: string;
};

function now(): string {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "session";
}

function sessionSocketPath(sessionId: string): string {
  return `/tmp/slop/sloppy-session-${sanitizeSegment(sessionId)}.sock`;
}

function defaultTitle(input: {
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

export class SessionSupervisorProvider {
  readonly server: SlopServer;
  private readonly sessions = new Map<string, SessionRecord>();
  private activeSessionId: string | null = null;
  private cachedConfig: SloppyConfig | null = null;
  private scopeError: string | null = null;

  constructor(
    private readonly options: {
      cwd?: string;
      homeConfigPath?: string;
      workspaceConfigPath?: string;
    } = {},
  ) {
    this.server = createSlopServer({
      id: "sloppy-session-supervisor",
      name: "Sloppy Session Supervisor",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("sessions", () => this.buildSessionsDescriptor());
    this.server.register("scopes", () => this.buildScopesDescriptor());
    void this.baseConfig()
      .then(() => this.server.refresh())
      .catch(() => this.server.refresh());
  }

  async startInitialSession(input: SessionScopeInput = {}): Promise<SessionRecord> {
    if (this.activeSessionId) {
      const active = this.sessions.get(this.activeSessionId);
      if (active) {
        return active;
      }
    }
    return this.createSession(input);
  }

  stop(): void {
    for (const record of this.sessions.values()) {
      record.unsubscribe();
      record.service.stop();
    }
    this.sessions.clear();
    this.activeSessionId = null;
    this.server.stop();
  }

  private async baseConfig(): Promise<SloppyConfig> {
    if (!this.cachedConfig) {
      try {
        this.cachedConfig = await loadScopedConfig({
          cwd: this.options.cwd,
          homeConfigPath: this.options.homeConfigPath,
          workspaceConfigPath: this.options.workspaceConfigPath,
        });
        this.scopeError = null;
      } catch (error) {
        this.scopeError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    return this.cachedConfig;
  }

  private async resolveConfig(input: SessionScopeInput): Promise<SloppyConfig> {
    return loadScopedConfig({
      cwd: this.options.cwd,
      homeConfigPath: this.options.homeConfigPath,
      workspaceConfigPath: this.options.workspaceConfigPath,
      workspaceId: input.workspace_id,
      projectId: input.project_id,
    });
  }

  private async createSession(input: SessionScopeInput): Promise<SessionRecord> {
    const config = await this.resolveConfig(input);
    const sessionId = input.session_id ?? crypto.randomUUID();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
    const title = defaultTitle({
      workspaceId: config.workspaces?.activeWorkspaceId,
      projectId: config.workspaces?.activeProjectId,
      fallback: input.title,
    });
    const service = new SessionService({
      config,
      sessionId,
      title,
      socketPath: sessionSocketPath(sessionId),
    });
    await service.start();
    const refresh = () => this.server.refresh();
    const unsubscribers = [
      service.runtime.store.onSessionChange(refresh),
      service.runtime.store.onTurnChange(refresh),
      service.runtime.store.onGoalChange(refresh),
      service.runtime.store.onQueueChange(refresh),
      service.runtime.store.onApprovalsChange(refresh),
      service.runtime.store.onTasksChange(refresh),
    ];

    const snapshot = service.runtime.store.getSnapshot();
    const record: SessionRecord = {
      sessionId,
      providerId: service.providerId,
      socketPath: service.socketPath,
      workspaceRoot: snapshot.session.workspaceRoot,
      workspaceId: snapshot.session.workspaceId,
      projectId: snapshot.session.projectId,
      title: snapshot.session.title,
      createdAt: now(),
      service,
      unsubscribe: () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      },
    };
    this.sessions.set(sessionId, record);
    this.activeSessionId = sessionId;
    this.server.refresh();
    return record;
  }

  private setActiveSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    this.activeSessionId = sessionId;
    this.server.refresh();
    return record;
  }

  private publicSessionRecord(record: SessionRecord): PublicSessionRecord {
    const snapshot = record.service.runtime.store.getSnapshot();
    const pendingApprovalCount = snapshot.approvals.filter(
      (approval) => approval.status === "pending",
    ).length;
    const runningTaskCount = snapshot.tasks.filter((task) => task.status === "running").length;
    return {
      sessionId: record.sessionId,
      providerId: record.providerId,
      socketPath: record.socketPath,
      workspaceRoot: snapshot.session.workspaceRoot,
      workspaceId: snapshot.session.workspaceId,
      projectId: snapshot.session.projectId,
      title: snapshot.session.title,
      createdAt: record.createdAt,
      session_id: record.sessionId,
      provider_id: record.providerId,
      socket_path: record.socketPath,
      workspace_root: snapshot.session.workspaceRoot,
      workspace_id: snapshot.session.workspaceId,
      project_id: snapshot.session.projectId,
      created_at: record.createdAt,
      turn_state: snapshot.turn.state,
      turn_message: snapshot.turn.message,
      goal_status: snapshot.goal?.status ?? "none",
      goal_objective: snapshot.goal?.objective,
      goal_total_tokens: snapshot.goal?.totalTokens ?? 0,
      queued_count: snapshot.queue.length,
      pending_approval_count: pendingApprovalCount,
      running_task_count: runningTaskCount,
      last_activity_at: snapshot.session.lastActivityAt,
    };
  }

  private stopSession(sessionId: string): { stopped: true; session_id: string } {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    record.unsubscribe();
    record.service.stop();
    this.sessions.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = [...this.sessions.keys()].sort()[0] ?? null;
    }
    this.server.refresh();
    return { stopped: true, session_id: sessionId };
  }

  private scopesFromConfig(config: SloppyConfig): ScopeRecord[] {
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

  private buildSessionDescriptor() {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    return {
      type: "context",
      props: {
        session_count: this.sessions.size,
        active_session_id: active?.sessionId ?? null,
        active_socket_path: active?.socketPath ?? null,
        home_config_path: this.options.homeConfigPath ?? getHomeConfigPath(),
        workspace_config_path:
          this.options.workspaceConfigPath ??
          getWorkspaceConfigPath(resolve(this.options.cwd ?? process.cwd())),
      },
      summary: "Supervisor for multiple Sloppy session providers.",
      actions: {
        create_session: action(
          {
            workspace_id: { type: "string", optional: true },
            project_id: { type: "string", optional: true },
            title: { type: "string", optional: true },
            session_id: { type: "string", optional: true },
          },
          async (input) => this.publicSessionRecord(await this.createSession(input)),
          {
            label: "Create Session",
            description: "Start a new scoped session provider and make it active.",
            estimate: "slow",
          },
        ),
        set_active_session: action(
          {
            session_id: "string",
          },
          async ({ session_id }) => this.publicSessionRecord(this.setActiveSession(session_id)),
          {
            label: "Set Active Session",
            description: "Mark an existing session as active for supervisor-aware clients.",
            idempotent: true,
            estimate: "instant",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 0.8,
      },
    };
  }

  private buildSessionsDescriptor() {
    const items: ItemDescriptor[] = [...this.sessions.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => this.buildSessionItem(record));
    return {
      type: "collection",
      props: {
        count: items.length,
        active_session_id: this.activeSessionId,
      },
      summary: "Running Sloppy sessions managed by this supervisor.",
      items,
    };
  }

  private buildSessionItem(record: SessionRecord): ItemDescriptor {
    const selected = record.sessionId === this.activeSessionId;
    const publicRecord = this.publicSessionRecord(record);
    return {
      id: encodeURIComponent(record.sessionId),
      props: {
        session_id: record.sessionId,
        provider_id: record.providerId,
        socket_path: record.socketPath,
        workspace_root: publicRecord.workspace_root ?? null,
        workspace_id: publicRecord.workspace_id ?? null,
        project_id: publicRecord.project_id ?? null,
        title: publicRecord.title ?? null,
        created_at: record.createdAt,
        turn_state: publicRecord.turn_state,
        turn_message: publicRecord.turn_message,
        goal_status: publicRecord.goal_status,
        goal_objective: publicRecord.goal_objective ?? null,
        goal_total_tokens: publicRecord.goal_total_tokens,
        queued_count: publicRecord.queued_count,
        pending_approval_count: publicRecord.pending_approval_count,
        running_task_count: publicRecord.running_task_count,
        last_activity_at: publicRecord.last_activity_at,
        selected,
      },
      summary: `${publicRecord.title ?? record.sessionId}: turn=${publicRecord.turn_state} goal=${publicRecord.goal_status} queued=${publicRecord.queued_count}`,
      actions: {
        set_active: action(
          async () => this.publicSessionRecord(this.setActiveSession(record.sessionId)),
          {
            label: "Switch",
            description: "Make this session active.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        stop: action(async () => this.stopSession(record.sessionId), {
          label: "Stop",
          description: "Stop this session provider.",
          dangerous: true,
          idempotent: true,
          estimate: "fast",
        }),
      },
      meta: {
        salience: selected ? 0.85 : 0.55,
      },
    };
  }

  private buildScopesDescriptor() {
    if (!this.cachedConfig && !this.scopeError) {
      void this.baseConfig()
        .then(() => this.server.refresh())
        .catch(() => this.server.refresh());
    }

    return {
      type: "collection",
      props: {
        ready: this.cachedConfig !== null,
        count: this.cachedConfig ? this.scopesFromConfig(this.cachedConfig).length : 0,
        error: this.scopeError,
      },
      summary: "Configured workspace/project scopes available for new sessions.",
      actions: {
        refresh: action(
          async () => {
            this.cachedConfig = null;
            this.scopeError = null;
            const config = await this.baseConfig();
            this.server.refresh();
            return { count: this.scopesFromConfig(config).length };
          },
          {
            label: "Refresh Scopes",
            description: "Reload configured workspace/project scopes.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
      items: this.cachedConfig
        ? this.scopesFromConfig(this.cachedConfig).map((scope) => this.buildScopeItem(scope))
        : [],
      meta: {
        salience: 0.55,
      },
    };
  }

  private buildScopeItem(scope: ScopeRecord): ItemDescriptor {
    return {
      id: encodeURIComponent(scope.id),
      props: {
        id: scope.id,
        workspace_id: scope.workspaceId,
        project_id: scope.projectId ?? null,
        name: scope.name,
        description: scope.description ?? null,
        root: scope.root,
        config_path: scope.configPath,
      },
      summary: scope.description ?? `${scope.name}: ${scope.root}`,
      actions: {
        create_session: action(
          {
            title: { type: "string", optional: true },
            session_id: { type: "string", optional: true },
          },
          async ({ title, session_id }) =>
            this.publicSessionRecord(
              await this.createSession({
                workspace_id: scope.workspaceId,
                project_id: scope.projectId,
                title,
                session_id,
              }),
            ),
          {
            label: "New Session",
            description: "Start a new session in this scope.",
            estimate: "slow",
          },
        ),
      },
      meta: {
        salience: 0.6,
      },
    };
  }
}

export async function startSessionSupervisor(options: {
  socketPath: string;
  initial?: SessionScopeInput;
  cwd?: string;
  register?: boolean;
}): Promise<{
  provider: SessionSupervisorProvider;
  listener: UnixListener;
  initialSession: SessionRecord;
}> {
  const provider = new SessionSupervisorProvider({
    cwd: options.cwd,
  });
  const listener = listenUnix(provider.server, options.socketPath, {
    register: options.register ?? true,
  });
  let initialSession: SessionRecord;
  try {
    initialSession = await provider.startInitialSession(options.initial ?? {});
  } catch (error) {
    closeUnixListener(listener, options.socketPath);
    provider.stop();
    throw error;
  }
  return {
    provider,
    listener: {
      close: () => closeUnixListener(listener, options.socketPath),
    },
    initialSession,
  };
}

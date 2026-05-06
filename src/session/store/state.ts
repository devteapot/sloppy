import type { AgentSessionSnapshot, SessionStoreEventType } from "../types";

export interface SessionStoreState {
  snapshot: AgentSessionSnapshot;
  activeAssistantMessageId: string | null;
  activeModelActivityId: string | null;
  activeApprovalActivityId: string | null;
  toolActivityIds: Map<string, string>;
  turnChanged: boolean;
  queueChanged: boolean;
  transcriptChanged: boolean;
  activityChanged: boolean;
  approvalsChanged: boolean;
  tasksChanged: boolean;
  appsChanged: boolean;
  llmChanged: boolean;
  sessionChanged: boolean;
}

export type EmitEvent = { kind: "change" } | { kind: "granular"; type: SessionStoreEventType };

export function createInitialState(options: {
  sessionId: string;
  modelProvider: string;
  model: string;
  title?: string;
  workspaceRoot?: string;
  startedAt: string;
}): SessionStoreState {
  const { startedAt } = options;
  return {
    snapshot: {
      session: {
        sessionId: options.sessionId,
        status: "active",
        modelProvider: options.modelProvider,
        model: options.model,
        startedAt,
        updatedAt: startedAt,
        lastActivityAt: startedAt,
        clientCount: 0,
        connectedClients: [],
        title: options.title,
        workspaceRoot: options.workspaceRoot,
      },
      llm: {
        status: "needs_credentials",
        message: "Add an API key to start the agent.",
        activeProfileId: "default",
        selectedProvider: options.modelProvider,
        selectedModel: options.model,
        secureStoreKind: "none",
        secureStoreStatus: "unsupported",
        profiles: [],
      },
      turn: {
        turnId: null,
        state: "idle",
        phase: "none",
        iteration: 0,
        startedAt: null,
        updatedAt: startedAt,
        message: "Idle",
      },
      queue: [],
      transcript: [],
      activity: [],
      approvals: [],
      tasks: [],
      apps: [],
    },
    activeAssistantMessageId: null,
    activeModelActivityId: null,
    activeApprovalActivityId: null,
    toolActivityIds: new Map(),
    turnChanged: false,
    queueChanged: false,
    transcriptChanged: false,
    activityChanged: false,
    approvalsChanged: false,
    tasksChanged: false,
    appsChanged: false,
    llmChanged: false,
    sessionChanged: false,
  };
}

export function cloneSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  return {
    session: {
      ...snapshot.session,
      connectedClients: snapshot.session.connectedClients.map((client) => ({ ...client })),
    },
    llm: {
      ...snapshot.llm,
      profiles: snapshot.llm.profiles.map((profile) => ({ ...profile })),
    },
    turn: { ...snapshot.turn },
    queue: (snapshot.queue ?? []).map((message) => ({ ...message })),
    transcript: snapshot.transcript.map((message) => ({
      ...message,
      content: message.content.map((block) => ({ ...block })),
    })),
    activity: snapshot.activity.map((item) => ({ ...item })),
    approvals: snapshot.approvals.map((item) => ({ ...item })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    apps: snapshot.apps.map((app) => ({ ...app })),
  };
}

export function createStateFromSnapshot(snapshot: AgentSessionSnapshot): SessionStoreState {
  return {
    snapshot: cloneSnapshot(snapshot),
    activeAssistantMessageId: null,
    activeModelActivityId: null,
    activeApprovalActivityId: null,
    toolActivityIds: new Map(),
    turnChanged: false,
    queueChanged: false,
    transcriptChanged: false,
    activityChanged: false,
    approvalsChanged: false,
    tasksChanged: false,
    appsChanged: false,
    llmChanged: false,
    sessionChanged: false,
  };
}

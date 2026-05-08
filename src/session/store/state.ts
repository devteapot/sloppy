import type { AgentSessionSnapshot, SessionStoreEventType } from "../types";
import { cloneExtensions } from "./extensions";
import { selectGoalSnapshot } from "./goal";
import { emptyUsage, normalizeUsage } from "./usage";

export interface SessionStoreState {
  snapshot: AgentSessionSnapshot;
  activeAssistantMessageId: string | null;
  activeModelActivityId: string | null;
  activeApprovalActivityId: string | null;
  toolActivityIds: Map<string, string>;
  turnChanged: boolean;
  goalChanged: boolean;
  queueChanged: boolean;
  transcriptChanged: boolean;
  activityChanged: boolean;
  approvalsChanged: boolean;
  tasksChanged: boolean;
  appsChanged: boolean;
  extensionsChanged: boolean;
  llmChanged: boolean;
  usageChanged: boolean;
  sessionChanged: boolean;
}

export type EmitEvent = { kind: "change" } | { kind: "granular"; type: SessionStoreEventType };

export function createInitialState(options: {
  sessionId: string;
  modelProvider: string;
  model: string;
  title?: string;
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  startedAt: string;
}): SessionStoreState {
  const { startedAt } = options;
  const usage = emptyUsage();
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
        workspaceId: options.workspaceId,
        projectId: options.projectId,
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
      usage,
      turn: {
        turnId: null,
        state: "idle",
        phase: "none",
        iteration: 0,
        startedAt: null,
        updatedAt: startedAt,
        message: "Idle",
      },
      goal: null,
      extensions: {},
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
    goalChanged: false,
    queueChanged: false,
    transcriptChanged: false,
    activityChanged: false,
    approvalsChanged: false,
    tasksChanged: false,
    appsChanged: false,
    extensionsChanged: false,
    llmChanged: false,
    usageChanged: false,
    sessionChanged: false,
  };
}

export function cloneSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  const { usage: _legacyUsage, ...llmSnapshot } = snapshot.llm as typeof snapshot.llm & {
    usage?: unknown;
  };
  return {
    session: {
      ...snapshot.session,
      connectedClients: snapshot.session.connectedClients.map((client) => ({ ...client })),
    },
    usage: normalizeUsage(snapshot.usage),
    llm: {
      ...llmSnapshot,
      profiles: snapshot.llm.profiles.map((profile) => ({ ...profile })),
    },
    turn: { ...snapshot.turn },
    goal: selectGoalSnapshot(snapshot),
    extensions: cloneExtensions(snapshot.extensions),
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
    goalChanged: false,
    queueChanged: false,
    transcriptChanged: false,
    activityChanged: false,
    approvalsChanged: false,
    tasksChanged: false,
    appsChanged: false,
    extensionsChanged: false,
    llmChanged: false,
    usageChanged: false,
    sessionChanged: false,
  };
}

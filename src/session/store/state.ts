import type { AgentSessionSnapshot, SessionStoreEventType } from "../types";

export interface SessionStoreState {
  snapshot: AgentSessionSnapshot;
  activeAssistantMessageId: string | null;
  activeModelActivityId: string | null;
  activeApprovalActivityId: string | null;
  toolActivityIds: Map<string, string>;
  turnChanged: boolean;
  transcriptChanged: boolean;
  activityChanged: boolean;
  approvalsChanged: boolean;
  tasksChanged: boolean;
  appsChanged: boolean;
  orchestrationChanged: boolean;
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
      transcript: [],
      activity: [],
      approvals: [],
      tasks: [],
      apps: [],
      orchestration: {
        available: false,
        pendingGateCount: 0,
        pendingGates: [],
        latestDigestActions: [],
        activeSliceCount: 0,
        completedSliceCount: 0,
        failedSliceCount: 0,
        finalAuditStatus: "none",
        updatedAt: startedAt,
      },
    },
    activeAssistantMessageId: null,
    activeModelActivityId: null,
    activeApprovalActivityId: null,
    toolActivityIds: new Map(),
    turnChanged: false,
    transcriptChanged: false,
    activityChanged: false,
    approvalsChanged: false,
    tasksChanged: false,
    appsChanged: false,
    orchestrationChanged: false,
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
    transcript: snapshot.transcript.map((message) => ({
      ...message,
      content: message.content.map((block) => ({ ...block })),
    })),
    activity: snapshot.activity.map((item) => ({ ...item })),
    approvals: snapshot.approvals.map((item) => ({ ...item })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    apps: snapshot.apps.map((app) => ({ ...app })),
    orchestration: {
      ...snapshot.orchestration,
      coherenceBreaches: [...(snapshot.orchestration.coherenceBreaches ?? [])],
      coherenceThresholds: { ...(snapshot.orchestration.coherenceThresholds ?? {}) },
      pendingGates: snapshot.orchestration.pendingGates.map((gate) => ({
        ...gate,
        evidenceRefs: [...gate.evidenceRefs],
      })),
      latestDigestActions: snapshot.orchestration.latestDigestActions.map((action) => ({
        ...action,
        params: { ...action.params },
      })),
    },
  };
}

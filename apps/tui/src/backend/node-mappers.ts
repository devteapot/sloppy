import type { ResultMessage } from "@slop-ai/consumer";
import type { SessionClientSnapshot } from "sloppy/session";

import type { GoalState, InspectState, SessionViewSnapshot, UsageState } from "./slop-types";

const EMPTY_INSPECT: InspectState = {
  targetId: "session",
  targetName: "Session",
  path: "/",
  depth: 2,
  tree: null,
  result: null,
};

const EMPTY_GOAL: GoalState = {
  exists: false,
  status: "none",
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  totalTokens: 0,
  elapsedMs: 0,
  continuationCount: 0,
  evidence: [],
  canCreate: false,
  canPause: false,
  canResume: false,
  canComplete: false,
  canClear: false,
};

const EMPTY_USAGE: UsageState = {
  lastModelCallInputSource: "unavailable",
  lastModelCallOutputSource: "unavailable",
  lastModelCallThinkingSource: "unavailable",
  currentTurnModelCalls: 0,
  lastStateContextTokenSource: "unavailable",
};

export const EMPTY_SESSION_VIEW: SessionViewSnapshot = {
  connection: { status: "idle" },
  session: { sessionId: null, status: "unknown" },
  llm: {
    status: "unknown",
    message: "LLM state has not loaded yet.",
    profiles: [],
    actions: [],
  },
  usage: EMPTY_USAGE,
  turn: {
    turnId: null,
    state: "unknown",
    phase: "none",
    iteration: 0,
    message: "Not connected.",
    waitingOn: null,
    canCancel: false,
  },
  goal: EMPTY_GOAL,
  composer: {
    ready: false,
    acceptsAttachments: false,
    maxAttachments: 0,
    canSend: false,
    disabledReason: "Session client is not connected.",
  },
  approvalMode: "normal",
  transcript: [],
  activity: [],
  approvals: [],
  tasks: [],
  apps: [],
  plugins: [],
  queue: [],
  inspect: EMPTY_INSPECT,
};

export function mapClientSnapshot(
  input: SessionClientSnapshot,
  previous: SessionViewSnapshot = EMPTY_SESSION_VIEW,
): SessionViewSnapshot {
  const state = input.session;
  const goalActions = new Map(
    input.plugins
      .find((plugin) => plugin.id === "persistent-goal")
      ?.contributions.actions.map((action) => [action.command, action.available]) ?? [],
  );
  const totalTokens =
    state.usage.totalInputTokens !== undefined ||
    state.usage.totalOutputTokens !== undefined ||
    state.usage.totalThinkingTokens !== undefined
      ? (state.usage.totalInputTokens ?? 0) +
        (state.usage.totalOutputTokens ?? 0) +
        (state.usage.totalThinkingTokens ?? 0)
      : undefined;

  return {
    ...previous,
    session: {
      sessionId: state.session.sessionId,
      status: state.session.status,
      title: state.session.title,
      workspaceRoot: state.session.workspaceRoot,
      workspaceId: state.session.workspaceId,
      projectId: state.session.projectId,
      launchScopeKey: state.session.launchScope?.key,
      launchRoot: state.session.launchScope?.root,
      modelProvider: state.session.modelProvider,
      model: state.session.model,
      startedAt: state.session.startedAt,
      updatedAt: state.session.updatedAt,
      clientCount: state.session.clientCount,
      lastError: state.session.lastError,
    },
    llm: {
      status: state.llm.status,
      message: state.llm.message,
      activeProfileId: state.llm.activeProfileId,
      selectedEndpointId: state.llm.selectedEndpointId,
      selectedProtocol: state.llm.selectedProtocol,
      selectedModel: state.llm.selectedModel,
      selectedContextWindowTokens: state.llm.selectedContextWindowTokens,
      secureStoreKind: state.llm.secureStoreKind,
      secureStoreStatus: state.llm.secureStoreStatus,
      profiles: state.llm.profiles.map((profile) => ({ ...profile })),
      actions: ["saveProfile", "setDefaultProfile", "deleteProfile", "deleteApiKey"],
    },
    usage: { ...state.usage, totalTokens },
    turn: {
      ...state.turn,
      waitingOn: state.turn.waitingOn ?? null,
      canCancel: input.controls.canCancelTurn,
    },
    goal: state.goal
      ? {
          exists: true,
          ...state.goal,
          thinkingTokens: state.goal.thinkingTokens ?? 0,
          evidence: state.goal.evidence ?? [],
          canCreate: goalActions.get("create") === true,
          canPause: goalActions.get("pause") === true,
          canResume: goalActions.get("resume") === true,
          canComplete: goalActions.get("complete") === true,
          canClear: goalActions.get("clear") === true,
        }
      : {
          ...EMPTY_GOAL,
          canCreate: goalActions.get("create") === true,
        },
    composer: {
      ready: input.controls.canSendMessage,
      acceptsAttachments: false,
      maxAttachments: 0,
      canSend: input.controls.canSendMessage,
      disabledReason: input.controls.canSendMessage ? undefined : state.llm.message,
    },
    approvalMode: state.approvalPolicy.mode,
    transcript: state.transcript.map((message) => ({
      id: message.id,
      seq: message.seq,
      role: message.role,
      state: message.state,
      turnId: message.turnId,
      author: message.author,
      createdAt: message.createdAt,
      error: message.error,
      blocks: message.content.map((block) => ({ ...block })),
    })),
    activity: state.activity.map((item) => ({ ...item })),
    approvals: state.approvals.map((approval) => ({
      id: approval.id,
      status: approval.status,
      provider: approval.provider,
      path: approval.path,
      action: approval.action,
      reason: approval.reason,
      paramsPreview: approval.paramsPreview,
      dangerous: approval.dangerous === true,
      canApprove: approval.canApprove === true,
      canReject: approval.canReject === true,
      createdAt: approval.createdAt,
      resolvedAt: approval.resolvedAt,
    })),
    tasks: state.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      provider: task.provider,
      providerTaskId: task.providerTaskId,
      message: task.message,
      progress: task.progress,
      linkedActivityId: task.linkedActivityId,
      error: task.error,
      canCancel: task.canCancel === true,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
    })),
    apps: state.apps.map((app) => ({
      id: app.id,
      providerId: app.id,
      name: app.name,
      transport: app.transport,
      status: app.status,
      lastError: app.lastError,
    })),
    plugins: input.plugins.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      status: plugin.status,
      description: plugin.description,
      ui: {
        actions: plugin.contributions.actions,
        indicators: plugin.contributions.indicators.map((indicator) => ({
          ...indicator,
          source: tuiClientSource(indicator.source),
        })),
        notifications: plugin.contributions.notifications.map((notification) => ({
          ...notification,
          source: tuiClientSource(notification.source),
        })),
      },
    })),
    queue: state.queue.map((message, index) => ({
      id: message.id,
      text: message.text,
      status: message.status,
      position: index + 1,
      summary: message.text.length > 96 ? `${message.text.slice(0, 93)}...` : message.text,
      author: message.author,
      createdAt: message.createdAt,
      canCancel: true,
    })),
  };
}

function tuiClientSource(source: string): string {
  return source.startsWith("session.") ? source.slice("session.".length) : source;
}

export function withConnectionState(
  snapshot: SessionViewSnapshot,
  connection: Partial<SessionViewSnapshot["connection"]>,
): SessionViewSnapshot {
  return {
    ...snapshot,
    connection: { ...snapshot.connection, ...connection },
  };
}

export function withInspectTree(
  snapshot: SessionViewSnapshot,
  inspect: Partial<InspectState>,
): SessionViewSnapshot {
  return {
    ...snapshot,
    inspect: { ...snapshot.inspect, ...inspect },
  };
}

export function withInspectResult(
  snapshot: SessionViewSnapshot,
  result: ResultMessage,
): SessionViewSnapshot {
  return withInspectTree(snapshot, {
    result,
    error: result.status === "error" ? result.error?.message : undefined,
  });
}

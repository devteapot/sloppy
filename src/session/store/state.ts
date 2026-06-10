import type {
  AgentSessionSnapshot,
  SessionSnapshotProjector,
  SessionStoreEventType,
} from "../types";
import { normalizeApprovalPolicy } from "./approval-policy";
import { cloneExtensions } from "./extensions";
import { emptyUsage, normalizeUsage } from "./usage";

export interface SessionStoreState {
  snapshot: AgentSessionSnapshot;
  nextSeq: number;
  activeAssistantMessageId: string | null;
  activeModelActivityId: string | null;
  activeApprovalActivityId: string | null;
  activeThinkingBlockIds: Map<string, string>;
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
  launchScope?: {
    key: string;
    root: string;
  };
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
        launchScope: options.launchScope,
      },
      llm: {
        status: "needs_credentials",
        message: "Add an endpoint credential to start the agent.",
        activeProfileId: "default",
        selectedEndpointId: options.modelProvider,
        selectedProtocol: undefined,
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
      approvalPolicy: {
        mode: "normal",
        updatedAt: startedAt,
      },
      extensions: {},
      queue: [],
      transcript: [],
      activity: [],
      approvals: [],
      tasks: [],
      apps: [],
    },
    nextSeq: 1,
    activeAssistantMessageId: null,
    activeModelActivityId: null,
    activeApprovalActivityId: null,
    activeThinkingBlockIds: new Map(),
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

export function cloneSnapshot(
  snapshot: AgentSessionSnapshot,
  projections?: readonly SessionSnapshotProjector[],
): AgentSessionSnapshot {
  const clone: AgentSessionSnapshot = {
    session: {
      ...snapshot.session,
      connectedClients: snapshot.session.connectedClients.map((client) => ({ ...client })),
    },
    usage: normalizeUsage(snapshot.usage),
    llm: {
      ...snapshot.llm,
      profiles: snapshot.llm.profiles.map((profile) => ({ ...profile })),
    },
    turn: { ...snapshot.turn },
    goal: snapshot.goal
      ? { ...snapshot.goal, evidence: snapshot.goal.evidence?.map((item) => item) }
      : null,
    approvalPolicy: normalizeApprovalPolicy(
      snapshot.approvalPolicy,
      snapshot.session.updatedAt ?? snapshot.session.startedAt,
    ),
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
  for (const project of projections ?? []) {
    Object.assign(clone, project(clone));
  }
  return clone;
}

export function createStateFromSnapshot(
  snapshot: AgentSessionSnapshot,
  projections?: readonly SessionSnapshotProjector[],
): SessionStoreState {
  const restored = cloneSnapshot(snapshot, projections);
  const nextSeq = normalizeSnapshotSeqs(restored);
  return {
    snapshot: restored,
    nextSeq,
    activeAssistantMessageId: null,
    activeModelActivityId: null,
    activeApprovalActivityId: null,
    activeThinkingBlockIds: new Map(),
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

function normalizeSnapshotSeqs(snapshot: AgentSessionSnapshot): number {
  let maxSeq = 0;
  for (const message of snapshot.transcript) {
    if (Number.isInteger(message.seq) && message.seq > 0) {
      maxSeq = Math.max(maxSeq, message.seq);
    }
    for (const block of message.content) {
      if (Number.isInteger(block.seq) && (block.seq ?? 0) > 0) {
        maxSeq = Math.max(maxSeq, block.seq ?? 0);
      }
    }
  }
  for (const item of snapshot.activity) {
    if (Number.isInteger(item.seq) && item.seq > 0) {
      maxSeq = Math.max(maxSeq, item.seq);
    }
  }

  const missing = [
    ...snapshot.transcript
      .filter((message) => !Number.isInteger(message.seq) || message.seq <= 0)
      .map((message, index) => ({
        kind: "transcript" as const,
        time: message.createdAt,
        index,
        value: message,
      })),
    ...snapshot.activity
      .filter((item) => !Number.isInteger(item.seq) || item.seq <= 0)
      .map((item, index) => ({
        kind: "activity" as const,
        time: item.startedAt,
        index,
        value: item,
      })),
  ].sort((left, right) => {
    const timeDiff = Date.parse(left.time) - Date.parse(right.time);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) {
      return timeDiff;
    }
    const priorityDiff =
      (left.kind === "transcript" ? 0 : 1) - (right.kind === "transcript" ? 0 : 1);
    return priorityDiff || left.index - right.index;
  });

  for (const entry of missing) {
    maxSeq += 1;
    entry.value.seq = maxSeq;
  }
  return maxSeq + 1;
}

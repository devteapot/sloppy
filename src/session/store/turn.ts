import type { TranscriptMessage, TranscriptMessageRole } from "../types";
import { buildId, deriveTitle, now, updateActivity, updateTurn } from "./helpers";
import { trimResolvedApprovals, trimResolvedTasks } from "./mirrors";
import type { SessionStoreState } from "./state";

export function beginTurn(
  state: SessionStoreState,
  userText: string,
  options?: {
    role?: TranscriptMessageRole;
    author?: string;
  },
): string {
  if (state.snapshot.turn.state !== "idle" && state.snapshot.turn.state !== "error") {
    throw new Error("A turn is already running for this session.");
  }

  const time = now();
  const turnId = buildId("turn");
  const role = options?.role ?? "user";
  const userMessage: TranscriptMessage = {
    id: buildId("msg"),
    role,
    state: "complete",
    turnId,
    createdAt: time,
    author: options?.author ?? role,
    content: [
      {
        id: buildId("block"),
        type: "text",
        mime: "text/plain",
        text: userText,
      },
    ],
  };

  if (state.snapshot.session.title === undefined && role === "user") {
    state.snapshot.session.title = deriveTitle(userText);
  }

  const modelActivityId = buildId("activity");
  state.snapshot.transcript.push(userMessage);
  state.snapshot.activity.push({
    id: modelActivityId,
    kind: "model_call",
    status: "running",
    summary: "Running model turn",
    startedAt: time,
    updatedAt: time,
    turnId,
  });
  state.activeModelActivityId = modelActivityId;
  state.activeAssistantMessageId = null;
  updateTurn(state, {
    turnId,
    state: "running",
    phase: "model",
    iteration: 1,
    startedAt: time,
    updatedAt: time,
    message: "Generating response",
    lastError: undefined,
    waitingOn: "model",
  });
  state.snapshot.session.lastError = undefined;
  state.snapshot.session.lastActivityAt = time;
  trimResolvedApprovals(state);
  trimResolvedTasks(state);
  state.turnChanged = true;
  state.transcriptChanged = true;
  state.activityChanged = true;
  state.sessionChanged = true;
  return turnId;
}

export function completeTurn(
  state: SessionStoreState,
  turnId: string,
  finalText: string,
  getOrCreateAssistantMessage: (turnId: string, createdAt: string) => TranscriptMessage,
): void {
  const time = now();
  const message = getOrCreateAssistantMessage(turnId, time);
  const [firstBlock] = message.content;
  if (firstBlock && firstBlock.type === "text") {
    firstBlock.text = finalText;
  }
  message.state = "complete";
  message.error = undefined;

  if (state.activeModelActivityId) {
    updateActivity(state, state.activeModelActivityId, {
      status: "ok",
      summary: "Completed model turn",
      updatedAt: time,
      completedAt: time,
    });
  }

  state.activeAssistantMessageId = null;
  state.activeModelActivityId = null;
  state.activeApprovalActivityId = null;
  updateTurn(state, {
    turnId: null,
    state: "idle",
    phase: "none",
    iteration: state.snapshot.turn.iteration,
    startedAt: null,
    updatedAt: time,
    message: "Idle",
    lastError: undefined,
    waitingOn: null,
  });
  state.activityChanged = true;
  state.turnChanged = true;
  state.transcriptChanged = true;
}

export function failTurn(state: SessionStoreState, turnId: string, message: string): void {
  const time = now();
  if (state.activeModelActivityId) {
    updateActivity(state, state.activeModelActivityId, {
      status: "error",
      summary: message,
      updatedAt: time,
      completedAt: time,
    });
  }

  state.snapshot.activity.push({
    id: buildId("activity"),
    kind: "error",
    status: "error",
    summary: message,
    startedAt: time,
    updatedAt: time,
    completedAt: time,
    turnId,
  });

  const assistantMessage =
    state.activeAssistantMessageId === null
      ? undefined
      : state.snapshot.transcript.find((entry) => entry.id === state.activeAssistantMessageId);
  if (assistantMessage) {
    assistantMessage.state = "error";
    assistantMessage.error = message;
  }

  state.snapshot.session.lastError = message;
  state.activeAssistantMessageId = null;
  state.activeModelActivityId = null;
  state.activeApprovalActivityId = null;
  updateTurn(state, {
    turnId,
    state: "error",
    phase: "complete",
    iteration: state.snapshot.turn.iteration,
    startedAt: state.snapshot.turn.startedAt,
    updatedAt: time,
    message,
    lastError: message,
    waitingOn: null,
  });
  state.activityChanged = true;
  state.turnChanged = true;
  state.transcriptChanged = true;
  state.sessionChanged = true;
}

export function cancelTurn(
  state: SessionStoreState,
  _turnId: string,
  options?: {
    message?: string;
    toolUseId?: string;
    approvalId?: string;
    approvalStatus?: "approved" | "rejected" | "expired";
  },
): void {
  const time = now();
  const message = options?.message ?? "Turn cancelled by user.";

  if (state.activeModelActivityId) {
    updateActivity(state, state.activeModelActivityId, {
      status: "cancelled",
      summary: message,
      updatedAt: time,
      completedAt: time,
    });
  }

  if (options?.toolUseId) {
    const toolActivityId = state.toolActivityIds.get(options.toolUseId);
    if (toolActivityId) {
      updateActivity(state, toolActivityId, {
        status: "cancelled",
        summary: message,
        updatedAt: time,
        completedAt: time,
      });
      state.toolActivityIds.delete(options.toolUseId);
    }
  }

  if (state.activeApprovalActivityId) {
    updateActivity(state, state.activeApprovalActivityId, {
      status: "cancelled",
      summary: message,
      updatedAt: time,
      completedAt: time,
      approvalId: options?.approvalId,
    });
    state.activeApprovalActivityId = null;
  }

  if (options?.approvalId && options.approvalStatus) {
    const approval = state.snapshot.approvals.find((item) => item.id === options.approvalId);
    if (approval && approval.status === "pending") {
      approval.status = options.approvalStatus;
      approval.resolvedAt = time;
      approval.canApprove = false;
      approval.canReject = false;
    }
  }

  const assistantMessage =
    state.activeAssistantMessageId === null
      ? undefined
      : state.snapshot.transcript.find((entry) => entry.id === state.activeAssistantMessageId);
  if (assistantMessage) {
    assistantMessage.state = "complete";
    assistantMessage.error = undefined;
  }

  state.activeAssistantMessageId = null;
  state.activeModelActivityId = null;
  state.snapshot.session.lastError = undefined;
  updateTurn(state, {
    turnId: null,
    state: "idle",
    phase: "none",
    iteration: state.snapshot.turn.iteration,
    startedAt: null,
    updatedAt: time,
    message,
    lastError: undefined,
    waitingOn: null,
  });
  state.activityChanged = true;
  state.turnChanged = true;
  state.transcriptChanged = true;
}

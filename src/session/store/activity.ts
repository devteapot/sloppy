import type { ActivityStatus, SessionTask } from "../types";
import {
  buildId,
  buildMirroredItemId,
  now,
  updateActivity,
  updateTurn,
  updateTurnPhase,
} from "./helpers";
import { upsertTask } from "./mirrors";
import type { SessionStoreState } from "./state";

export function recordToolStart(
  state: SessionStoreState,
  turnId: string,
  options: {
    toolUseId: string;
    summary: string;
    provider?: string;
    path?: string;
    action?: string;
    paramsPreview?: string;
  },
): void {
  const time = now();
  const activityId = buildId("activity");
  state.snapshot.activity.push({
    id: activityId,
    kind: "tool_call",
    status: "running",
    summary: options.summary,
    startedAt: time,
    updatedAt: time,
    turnId,
    provider: options.provider,
    path: options.path,
    action: options.action,
    toolUseId: options.toolUseId,
    paramsPreview: options.paramsPreview,
  });
  state.toolActivityIds.set(options.toolUseId, activityId);
  updateTurnPhase(state, "tool_use", options.summary, "tool", time);
  state.activityChanged = true;
  state.turnChanged = true;
}

export function recordToolCompletion(
  state: SessionStoreState,
  turnId: string,
  options: {
    toolUseId: string;
    summary: string;
    status: ActivityStatus;
    provider?: string;
    path?: string;
    action?: string;
    taskId?: string;
    errorMessage?: string;
  },
): void {
  const time = now();
  const linkedActivityId = state.toolActivityIds.get(options.toolUseId);
  if (linkedActivityId) {
    updateActivity(state, linkedActivityId, {
      status: options.status,
      updatedAt: time,
      completedAt: time,
      taskId: options.taskId,
    });
  }

  state.snapshot.activity.push({
    id: buildId("activity"),
    kind: "tool_result",
    status: options.status,
    summary: options.summary,
    startedAt: time,
    updatedAt: time,
    completedAt: time,
    turnId,
    provider: options.provider,
    path: options.path,
    action: options.action,
    taskId: options.taskId,
    toolUseId: options.toolUseId,
  });

  if (options.status === "accepted" && options.provider && options.taskId) {
    const taskItemId = buildMirroredItemId("task", options.provider, options.taskId);
    const existingTask = state.snapshot.tasks.find((task) => task.id === taskItemId);
    const task: SessionTask = {
      id: taskItemId,
      status: existingTask?.status ?? "running",
      provider: options.provider,
      providerTaskId: options.taskId,
      startedAt: existingTask?.startedAt ?? time,
      updatedAt: time,
      message: existingTask?.message ?? "Waiting for provider task update",
      linkedActivityId: linkedActivityId ?? existingTask?.linkedActivityId,
      error: existingTask?.error,
      sourceTaskId: options.taskId,
      sourcePath: existingTask?.sourcePath ?? `/tasks/${options.taskId}`,
      canCancel: existingTask?.canCancel,
      turnId,
    };
    upsertTask(state, task);
  }

  updateTurnPhase(state, "model", "Continuing after tool result", "model", time);
  state.activityChanged = true;
  state.tasksChanged = options.status === "accepted";
  state.turnChanged = true;
}

export function recordApprovalRequested(
  state: SessionStoreState,
  turnId: string,
  options: {
    toolUseId: string;
    summary: string;
    provider?: string;
    path?: string;
    action?: string;
    reason: string;
  },
): void {
  const time = now();
  const activityId = buildId("activity");
  state.snapshot.activity.push({
    id: activityId,
    kind: "approval",
    status: "running",
    summary: options.reason,
    startedAt: time,
    updatedAt: time,
    turnId,
    provider: options.provider,
    path: options.path,
    action: options.action,
    toolUseId: options.toolUseId,
  });
  state.activeApprovalActivityId = activityId;
  updateTurn(state, {
    ...state.snapshot.turn,
    turnId,
    state: "waiting_approval",
    phase: "awaiting_result",
    updatedAt: time,
    message: options.reason,
    waitingOn: "approval",
  });
  state.activityChanged = true;
  state.approvalsChanged = true;
  state.turnChanged = true;
}

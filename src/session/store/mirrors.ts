import type { ApprovalItem, SessionTask } from "../types";
import { buildId, now, updateActivity } from "./helpers";
import type { SessionStoreState } from "./state";

export function syncProviderApprovals(
  state: SessionStoreState,
  providerId: string,
  approvals: ApprovalItem[],
): void {
  const time = now();
  const currentById = new Map(
    state.snapshot.approvals
      .filter((item) => item.provider === providerId)
      .map((item) => [item.id, item] as const),
  );
  for (const approval of approvals) {
    const previous = currentById.get(approval.id);
    if (previous?.status === approval.status || approval.status === "pending") {
      continue;
    }

    state.snapshot.activity.push({
      id: buildId("activity"),
      kind: "approval",
      status:
        approval.status === "approved"
          ? "ok"
          : approval.status === "rejected"
            ? "cancelled"
            : "error",
      summary: approval.reason,
      startedAt: approval.createdAt,
      updatedAt: approval.resolvedAt ?? time,
      completedAt: approval.resolvedAt ?? time,
      turnId: approval.turnId,
      provider: approval.provider,
      path: approval.path,
      action: approval.action,
      approvalId: approval.id,
    });

    if (state.activeApprovalActivityId) {
      updateActivity(state, state.activeApprovalActivityId, {
        status:
          approval.status === "approved"
            ? "ok"
            : approval.status === "rejected"
              ? "cancelled"
              : "error",
        updatedAt: approval.resolvedAt ?? time,
        completedAt: approval.resolvedAt ?? time,
        approvalId: approval.id,
      });
      state.activeApprovalActivityId = null;
    }
  }

  state.snapshot.approvals = [
    ...state.snapshot.approvals.filter((item) => item.provider !== providerId),
    ...approvals,
  ];
  state.snapshot.session.updatedAt = time;
  state.approvalsChanged = true;
}

export function syncProviderTasks(
  state: SessionStoreState,
  providerId: string,
  tasks: SessionTask[],
): void {
  const time = now();
  const currentById = new Map(
    state.snapshot.tasks
      .filter((item) => item.provider === providerId)
      .map((item) => [item.id, item] as const),
  );
  const mergedTasks = tasks.map((task) => {
    const previous = currentById.get(task.id);
    return {
      ...previous,
      ...task,
      linkedActivityId: task.linkedActivityId ?? previous?.linkedActivityId,
      turnId: task.turnId ?? previous?.turnId,
    } satisfies SessionTask;
  });

  state.snapshot.tasks = [
    ...state.snapshot.tasks.filter((item) => item.provider !== providerId),
    ...mergedTasks,
  ];
  state.snapshot.session.updatedAt = time;
  state.tasksChanged = true;
}

export function clearProviderMirrors(state: SessionStoreState, providerId: string): boolean {
  const nextApprovals = state.snapshot.approvals.filter((item) => item.provider !== providerId);
  const nextTasks = state.snapshot.tasks.filter((item) => item.provider !== providerId);
  if (
    nextApprovals.length === state.snapshot.approvals.length &&
    nextTasks.length === state.snapshot.tasks.length
  ) {
    return false;
  }

  state.snapshot.approvals = nextApprovals;
  state.snapshot.tasks = nextTasks;
  state.snapshot.session.updatedAt = now();
  state.approvalsChanged = true;
  state.tasksChanged = true;
  return true;
}

export function upsertTask(state: SessionStoreState, task: SessionTask): void {
  const existingIndex = state.snapshot.tasks.findIndex((entry) => entry.id === task.id);
  if (existingIndex === -1) {
    state.snapshot.tasks.push(task);
    return;
  }

  state.snapshot.tasks[existingIndex] = {
    ...state.snapshot.tasks[existingIndex],
    ...task,
  };
}

export function trimResolvedApprovals(state: SessionStoreState, limit?: number): boolean {
  const maxResolved = limit ?? state.snapshot.session.maxResolvedApprovals ?? 50;
  const pending = state.snapshot.approvals.filter((item) => item.status === "pending");
  const resolved = state.snapshot.approvals
    .filter((item) => item.status !== "pending")
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  if (resolved.length <= maxResolved) {
    return false;
  }
  const toKeep = resolved.slice(0, maxResolved);
  state.snapshot.approvals = [...toKeep, ...pending];
  state.approvalsChanged = true;
  return true;
}

export function trimResolvedTasks(state: SessionStoreState, limit?: number): boolean {
  const maxResolved = limit ?? state.snapshot.session.maxResolvedTasks ?? 50;
  const running = state.snapshot.tasks.filter((item) => item.status === "running");
  const resolved = state.snapshot.tasks
    .filter((item) => item.status !== "running")
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  if (resolved.length <= maxResolved) {
    return false;
  }
  const toKeep = resolved.slice(0, maxResolved);
  state.snapshot.tasks = [...toKeep, ...running];
  state.tasksChanged = true;
  return true;
}

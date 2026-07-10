import type { ApprovalItem, ApprovalStatus } from "../types";
import { buildId, nextSeq, now } from "./helpers";
import type { SessionStoreState } from "./state";

export type SessionApprovalInput = {
  pluginId: string;
  path: string;
  action: string;
  reason: string;
  paramsPreview?: string;
  dangerous?: boolean;
  autoApprovable?: boolean;
};

export function requestSessionApproval(
  state: SessionStoreState,
  input: SessionApprovalInput,
): ApprovalItem {
  const time = now();
  const approval: ApprovalItem = {
    id: buildId("approval-plugin"),
    status: "pending",
    provider: `session-plugin:${input.pluginId}`,
    path: input.path,
    action: input.action,
    reason: input.reason,
    createdAt: time,
    paramsPreview: input.paramsPreview,
    dangerous: input.dangerous,
    autoApprovable: input.autoApprovable ?? true,
    canApprove: true,
    canReject: true,
  };
  state.snapshot.approvals.push(approval);
  state.snapshot.session.updatedAt = time;
  state.snapshot.session.lastActivityAt = time;
  state.approvalsChanged = true;
  state.sessionChanged = true;
  return { ...approval };
}

export function resolveSessionApproval(
  state: SessionStoreState,
  approvalId: string,
  status: Extract<ApprovalStatus, "approved" | "rejected" | "expired">,
  reason?: string,
): ApprovalItem {
  const approval = state.snapshot.approvals.find((item) => item.id === approvalId);
  if (!approval) {
    throw new Error(`Unknown approval: ${approvalId}`);
  }
  if (approval.status !== "pending") {
    throw new Error(`Approval is already resolved: ${approvalId}`);
  }

  const time = now();
  approval.status = status;
  approval.resolvedAt = time;
  approval.canApprove = false;
  approval.canReject = false;
  state.snapshot.activity.push({
    id: buildId("activity"),
    seq: nextSeq(state),
    kind: "approval",
    status: status === "approved" ? "ok" : status === "rejected" ? "cancelled" : "error",
    summary: reason ?? approval.reason,
    startedAt: approval.createdAt,
    updatedAt: time,
    completedAt: time,
    provider: approval.provider,
    path: approval.path,
    action: approval.action,
    approvalId: approval.id,
  });
  state.snapshot.session.updatedAt = time;
  state.snapshot.session.lastActivityAt = time;
  state.approvalsChanged = true;
  state.activityChanged = true;
  state.sessionChanged = true;
  return { ...approval };
}

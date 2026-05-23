import type { ApprovalMode, ApprovalPolicySnapshot } from "../types";
import { now } from "./helpers";
import type { SessionStoreState } from "./state";

export function normalizeApprovalPolicy(
  policy: Partial<ApprovalPolicySnapshot> | null | undefined,
  fallbackTime: string,
): ApprovalPolicySnapshot {
  return {
    mode: policy?.mode === "auto" ? "auto" : "normal",
    updatedAt: policy?.updatedAt ?? fallbackTime,
  };
}

export function setApprovalMode(state: SessionStoreState, mode: ApprovalMode): void {
  if (state.snapshot.approvalPolicy.mode === mode) {
    return;
  }
  const time = now();
  state.snapshot.approvalPolicy = {
    mode,
    updatedAt: time,
  };
  state.snapshot.session.updatedAt = time;
  state.approvalsChanged = true;
}

// Approval suspension/resume state machine for the run loop.
//
// Tool invocations that hit a hub policy gate return `approval_required`.
// The loop persists the in-flight tool batch as a `PendingApprovalContinuation`
// and unwinds; once the user approves/rejects, the resolved tool result is
// fed back via `runLoop({ resume })`. The states modelled here are:
//
//   idle      — no suspension in flight; iterate normally.
//   resuming  — a prior suspension has been resolved; the next matching
//               iteration replays the saved tool batch with the resolved
//               result and then transitions back to `idle`.
//
// The "suspended" state is not stored locally — it is the return value of
// `runLoop` (status: "waiting_approval") which the caller reifies into
// pending state on `Agent`. This module is the single place that knows how
// to interpret that resume payload and how to decide what each iteration
// should do.

import type { ToolResultContentBlock } from "../../llm/types";
import type { PendingApprovalContinuation, RunLoopResult } from "../loop";
import { PolicyDeniedError } from "../policy";
import { toolErrorCode } from "./result-format";

export type ApprovalState =
  | { kind: "idle" }
  | {
      kind: "resuming";
      continuation: PendingApprovalContinuation;
      resolvedToolResult: ToolResultContentBlock;
    };

export const idleApproval: ApprovalState = { kind: "idle" };

export function resumingApproval(
  continuation: PendingApprovalContinuation,
  resolvedToolResult: ToolResultContentBlock,
): ApprovalState {
  return { kind: "resuming", continuation, resolvedToolResult };
}

export type IterationPlan =
  | { kind: "skip" }
  | {
      kind: "resume";
      continuation: PendingApprovalContinuation;
      resolvedToolResult: ToolResultContentBlock;
    }
  | { kind: "advance" };

export function planIteration(state: ApprovalState, iteration: number): IterationPlan {
  if (state.kind === "resuming") {
    if (iteration < state.continuation.iteration) return { kind: "skip" };
    if (iteration === state.continuation.iteration) {
      return {
        kind: "resume",
        continuation: state.continuation,
        resolvedToolResult: state.resolvedToolResult,
      };
    }
  }
  return { kind: "advance" };
}

export function suspendedResult(pending: PendingApprovalContinuation): RunLoopResult {
  return { status: "waiting_approval", pending };
}

/**
 * Read the approvalId out of a hub.invoke result.data when the tool returned
 * `approval_required`. Approval ids are owned by the hub; the loop forwards
 * them so the session runtime can resolve approvals strictly by id rather
 * than tuple-matching the mirrored `/approvals` tree.
 */
export function extractApprovalId(data: unknown): string | undefined {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as { approvalId?: unknown }).approvalId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * Map errors thrown during tool invocation to a stable error code. Hub
 * policy `deny` decisions surface as PolicyDeniedError; map them to
 * `tool_policy_rejected` so user-visible behavior matches the legacy
 * in-loop policy hook.
 */
export function classifyToolInvocationError(error: unknown): string | undefined {
  if (error instanceof PolicyDeniedError) return "tool_policy_rejected";
  return toolErrorCode(error);
}

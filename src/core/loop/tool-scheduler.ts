import type { ToolResultContentBlock, ToolUseContentBlock } from "../../llm/types";
import { LlmAbortError } from "../../llm/types";
import type { RuntimeToolSet } from "../tools";
import type {
  ExecuteToolCallResult,
  ExecuteToolCallsOptions,
  PendingApprovalContinuation,
} from "./contracts";
import { executeToolCall } from "./tool-executor";

const PARALLEL_SAFE_TOOL_CONCURRENCY = 4;

export type ExecuteToolCallsResult =
  | { status: "completed"; toolResults: ToolResultContentBlock[] }
  | { status: "waiting_approval"; pending: PendingApprovalContinuation };

function isParallelSafeToolCall(toolUse: ToolUseContentBlock, toolSet: RuntimeToolSet): boolean {
  if (toolUse.inputError) return false;
  const resolution = toolSet.resolve(toolUse.name);
  if (!resolution) return false;
  if (resolution.kind === "observation") {
    return resolution.action === "query_state";
  }
  return resolution.idempotent && !resolution.dangerous;
}

function emitCompletedToolCall(
  result: Extract<ExecuteToolCallResult, { kind: "completed" }>,
  options: ExecuteToolCallsOptions,
): void {
  options.onToolResult?.(result.result.summary);
  if (result.invocation) {
    options.onToolEvent?.({
      kind: "completed",
      invocation: result.invocation,
      summary: result.result.summary,
      status: result.status,
      taskId: result.taskId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      result: result.activityResult,
    });
  }
}

function emitApprovalRequestedToolCall(
  result: Extract<ExecuteToolCallResult, { kind: "approval_requested" }>,
  options: ExecuteToolCallsOptions,
): void {
  options.onToolEvent?.({
    kind: "approval_requested",
    invocation: result.invocation,
    summary: result.summary,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    approvalId: result.approvalId,
  });
}

function buildPendingApproval(
  result: Extract<ExecuteToolCallResult, { kind: "approval_requested" }>,
  options: ExecuteToolCallsOptions,
  nextToolCallIndex: number,
  toolResults: ToolResultContentBlock[],
  deferredToolResults?: PendingApprovalContinuation["deferredToolResults"],
): PendingApprovalContinuation {
  return {
    blockedInvocation: result.invocation,
    iteration: options.iteration,
    toolCalls: options.toolCalls,
    nextToolCallIndex,
    toolResults,
    ...(deferredToolResults && deferredToolResults.length > 0 ? { deferredToolResults } : {}),
  };
}

export function resumeToolExecutionState(
  continuation: PendingApprovalContinuation,
  resolvedToolResult: ToolResultContentBlock,
): { startIndex: number; toolResults: ToolResultContentBlock[] } {
  const toolResults = [...continuation.toolResults, resolvedToolResult];
  let startIndex = continuation.nextToolCallIndex;
  const deferredToolResults = [...(continuation.deferredToolResults ?? [])].sort(
    (left, right) => left.toolCallIndex - right.toolCallIndex,
  );

  // Deferred results only cover calls after the approval barrier. Reinsert the
  // contiguous prefix; calls after a gap have not run and must be scheduled.
  for (const deferred of deferredToolResults) {
    if (deferred.toolCallIndex !== startIndex) break;
    toolResults.push(deferred.result);
    startIndex += 1;
  }

  return { startIndex, toolResults };
}

export async function executeToolCalls(
  options: ExecuteToolCallsOptions,
): Promise<ExecuteToolCallsResult> {
  const toolResults = [...options.toolResults];

  let index = options.startIndex;
  while (index < options.toolCalls.length) {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const toolCall = options.toolCalls[index];
    if (isParallelSafeToolCall(toolCall, options.toolSet)) {
      const chunkStart = index;
      const chunkCalls: ToolUseContentBlock[] = [];
      while (
        index < options.toolCalls.length &&
        chunkCalls.length < PARALLEL_SAFE_TOOL_CONCURRENCY &&
        isParallelSafeToolCall(options.toolCalls[index], options.toolSet)
      ) {
        chunkCalls.push(options.toolCalls[index]);
        index += 1;
      }

      for (const chunkToolCall of chunkCalls) {
        options.onToolCall?.(`${chunkToolCall.name} ${JSON.stringify(chunkToolCall.input)}`);
      }

      const chunkResults = await Promise.all(
        chunkCalls.map((chunkToolCall) =>
          executeToolCall(
            chunkToolCall,
            options.toolSet,
            options.localTools,
            options.hub,
            options.config,
            options.onToolEvent,
            options.toolPolicy,
            options.transformInvoke,
            options.roleId,
            options.signal,
          ),
        ),
      );

      const approvalOffset = chunkResults.findIndex(
        (result) => result.kind === "approval_requested",
      );
      if (approvalOffset >= 0) {
        return suspendParallelChunk(chunkStart, approvalOffset, chunkResults, toolResults, options);
      }

      for (const result of chunkResults) {
        if (result.kind === "approval_requested") continue;
        emitCompletedToolCall(result, options);
        toolResults.push(result.result.block);
      }
      continue;
    }

    options.onToolCall?.(`${toolCall.name} ${JSON.stringify(toolCall.input)}`);
    const result = await executeToolCall(
      toolCall,
      options.toolSet,
      options.localTools,
      options.hub,
      options.config,
      options.onToolEvent,
      options.toolPolicy,
      options.transformInvoke,
      options.roleId,
      options.signal,
    );

    if (result.kind === "approval_requested") {
      emitApprovalRequestedToolCall(result, options);
      return {
        status: "waiting_approval",
        pending: buildPendingApproval(result, options, index + 1, toolResults),
      };
    }

    emitCompletedToolCall(result, options);
    toolResults.push(result.result.block);
    index += 1;
  }

  return { status: "completed", toolResults };
}

function suspendParallelChunk(
  chunkStart: number,
  approvalOffset: number,
  chunkResults: ExecuteToolCallResult[],
  toolResults: ToolResultContentBlock[],
  options: ExecuteToolCallsOptions,
): Extract<ExecuteToolCallsResult, { status: "waiting_approval" }> {
  const approvalResult = chunkResults[approvalOffset] as Extract<
    ExecuteToolCallResult,
    { kind: "approval_requested" }
  >;
  const deferredToolResults: NonNullable<PendingApprovalContinuation["deferredToolResults"]> = [];

  for (let offset = 0; offset < chunkResults.length; offset += 1) {
    const result = chunkResults[offset];
    const toolCallIndex = chunkStart + offset;
    if (result.kind === "approval_requested") {
      if (offset === approvalOffset) {
        emitApprovalRequestedToolCall(result, options);
      }
      continue;
    }

    emitCompletedToolCall(result, options);
    if (offset < approvalOffset) {
      toolResults.push(result.result.block);
    } else {
      deferredToolResults.push({ toolCallIndex, result: result.result.block });
    }
  }

  return {
    status: "waiting_approval",
    pending: buildPendingApproval(
      approvalResult,
      options,
      chunkStart + approvalOffset + 1,
      toolResults,
      deferredToolResults,
    ),
  };
}

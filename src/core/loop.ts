import { formatTree, type LlmTool } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { LlmAdapter, ToolResultContentBlock, ToolUseContentBlock } from "../llm/types";
import { LlmAbortError } from "../llm/types";
import { buildStateContext, buildSystemPrompt } from "./context";
import { debug } from "./debug";
import type { ConversationHistory } from "./history";
import type { ProviderRuntimeHub } from "./hub";
import {
  type ApprovalState,
  classifyToolInvocationError,
  extractApprovalId,
  idleApproval,
  planIteration,
  resumingApproval,
  suspendedResult,
} from "./loop/approval-suspension";
import { stringifyResult, truncateToolResult } from "./loop/result-format";
import type { ToolPolicyDecision } from "./role";
import type { RuntimeToolResolution, RuntimeToolSet } from "./tools";

const PARALLEL_SAFE_TOOL_CONCURRENCY = 4;

export interface RunLoopHooks {
  toolPolicy?: (
    resolution: RuntimeToolResolution,
    params: Record<string, unknown>,
    config: SloppyConfig,
  ) => ToolPolicyDecision;
  transformInvoke?: (
    resolution: RuntimeToolResolution,
    params: Record<string, unknown>,
    config: SloppyConfig,
  ) => Record<string, unknown>;
  beforeNextTurn?: (hub: ProviderRuntimeHub, signal?: AbortSignal) => Promise<void>;
  /**
   * Optional id of the role driving this loop iteration. When set, the loop
   * passes this id as per-call metadata to `hub.invoke` so hub policy rules
   * can scope themselves by role. The metadata
   * is per-invocation; it does NOT leak to other callers (scheduler, UI).
   */
  roleId?: string;
  /**
   * Runtime-local tools that are not provider affordances. These are for
   * session-owned control surfaces such as goal progress reporting; reusable
   * capabilities should still be providers or skills.
   */
  localTools?: () => LocalRuntimeTool[];
}

type ToolResult = {
  block: ToolResultContentBlock;
  summary: string;
};

export type LocalRuntimeToolResult = {
  status: "ok" | "error";
  summary: string;
  content: unknown;
  isError?: boolean;
};

export type LocalRuntimeToolContext = {
  hub: ProviderRuntimeHub;
  config: SloppyConfig;
  signal?: AbortSignal;
};

export type LocalRuntimeTool = {
  tool: LlmTool;
  providerId?: string;
  path?: string;
  execute: (
    params: Record<string, unknown>,
    context: LocalRuntimeToolContext,
  ) => LocalRuntimeToolResult | Promise<LocalRuntimeToolResult>;
};

export type AgentToolInvocation = {
  toolUseId: string;
  toolName: string;
  kind: "observation" | "affordance" | "local";
  providerId?: string;
  path?: string;
  action: string;
  params: Record<string, unknown>;
};

export type AgentToolEvent =
  | {
      kind: "started";
      invocation: AgentToolInvocation;
      summary: string;
    }
  | {
      kind: "completed";
      invocation: AgentToolInvocation;
      summary: string;
      status: "ok" | "error" | "accepted" | "cancelled";
      taskId?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | {
      kind: "approval_requested";
      invocation: AgentToolInvocation;
      summary: string;
      errorCode: string;
      errorMessage: string;
      /**
       * Hub-owned approval id (e.g. `approval-…`). Plumbed through directly
       * so the session runtime can resolve / cancel / resume strictly by id
       * instead of tuple-matching the mirrored `/approvals` tree.
       */
      approvalId?: string;
    };

export type PendingApprovalContinuation = {
  blockedInvocation: AgentToolInvocation;
  iteration: number;
  toolCalls: ToolUseContentBlock[];
  nextToolCallIndex: number;
  toolResults: ToolResultContentBlock[];
  deferredToolResults?: {
    toolCallIndex: number;
    result: ToolResultContentBlock;
  }[];
};

export type RunLoopResult =
  | {
      status: "completed";
      response: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
      };
    }
  | {
      status: "waiting_approval";
      pending: PendingApprovalContinuation;
      usage?: {
        inputTokens: number;
        outputTokens: number;
      };
    };

type ExecuteToolCallResult =
  | {
      kind: "completed";
      invocation?: AgentToolInvocation;
      result: ToolResult;
      status: "ok" | "error" | "accepted";
      taskId?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | {
      kind: "approval_requested";
      invocation: AgentToolInvocation;
      summary: string;
      errorCode: string;
      errorMessage: string;
      /**
       * Hub-owned approval id (e.g. `approval-…`). Plumbed through directly
       * so the session runtime can resolve / cancel / resume strictly by id
       * instead of tuple-matching the mirrored `/approvals` tree.
       */
      approvalId?: string;
    };

type ExecuteToolCallsOptions = {
  toolCalls: ToolUseContentBlock[];
  startIndex: number;
  toolResults: ToolResultContentBlock[];
  iteration: number;
  toolSet: RuntimeToolSet;
  localTools: LocalRuntimeTool[];
  hub: ProviderRuntimeHub;
  config: SloppyConfig;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
  onToolEvent?: (event: AgentToolEvent) => void;
  toolPolicy?: RunLoopHooks["toolPolicy"];
  transformInvoke?: RunLoopHooks["transformInvoke"];
  roleId?: string;
  signal?: AbortSignal;
};

export { truncateToolResult };

function invalidToolArgumentsResult(
  toolUse: ToolUseContentBlock,
  resolution:
    | RuntimeToolResolution
    | {
        kind: "local";
        action: string;
      },
  onToolEvent?: (event: AgentToolEvent) => void,
): ExecuteToolCallResult {
  const error = toolUse.inputError;
  const message =
    error?.message ??
    "Tool arguments were invalid and could not be parsed before provider invocation.";
  const rawPreview = error?.raw
    ? error.raw.length > 500
      ? `${error.raw.slice(0, 484)}...[truncated]`
      : error.raw
    : undefined;
  const invocation: AgentToolInvocation = {
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    kind:
      resolution.kind === "observation"
        ? "observation"
        : resolution.kind === "local"
          ? "local"
          : "affordance",
    providerId: resolution.kind === "affordance" ? resolution.providerId : undefined,
    path: resolution.kind === "affordance" ? (resolution.path ?? undefined) : undefined,
    action: resolution.action,
    params: {
      invalid_tool_arguments: {
        code: error?.code ?? "invalid_json",
        message,
        raw: rawPreview,
      },
    },
  };
  const summary =
    resolution.kind === "affordance"
      ? `${resolution.providerId}:${resolution.action} ${resolution.path ?? ""}`.trim()
      : `${resolution.action} invalid arguments`;

  onToolEvent?.({ kind: "started", invocation, summary });

  return {
    kind: "completed",
    invocation,
    result: {
      block: {
        type: "tool_result",
        toolUseId: toolUse.id,
        isError: true,
        content: stringifyResult({
          status: "error",
          error: {
            code: "invalid_tool_arguments",
            message:
              "The model emitted malformed JSON for this tool call. Re-emit the same tool call with valid JSON arguments that match the tool schema.",
            detail: message,
            raw_preview: rawPreview,
          },
        }),
      },
      summary,
    },
    status: "error",
    errorCode: "invalid_tool_arguments",
    errorMessage: message,
  };
}

async function executeLocalToolCall(
  toolUse: ToolUseContentBlock,
  localTool: LocalRuntimeTool,
  hub: ProviderRuntimeHub,
  config: SloppyConfig,
  onToolEvent?: (event: AgentToolEvent) => void,
  signal?: AbortSignal,
): Promise<ExecuteToolCallResult> {
  const action = localTool.tool.function.name;
  if (toolUse.inputError) {
    return invalidToolArgumentsResult(toolUse, { kind: "local", action }, onToolEvent);
  }

  const invocation: AgentToolInvocation = {
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    kind: "local",
    providerId: localTool.providerId ?? "session",
    path: localTool.path ?? "/runtime",
    action,
    params: { ...toolUse.input },
  };
  const summary = `${invocation.providerId}:${action} ${invocation.path}`;
  onToolEvent?.({
    kind: "started",
    invocation,
    summary,
  });

  try {
    const result = await localTool.execute(
      { ...toolUse.input },
      {
        hub,
        config,
        signal,
      },
    );
    const content =
      typeof result.content === "string" ? result.content : stringifyResult(result.content);
    return {
      kind: "completed",
      invocation,
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: result.isError ?? result.status === "error",
          content,
        },
        summary: result.summary,
      },
      status: result.status,
      errorMessage: result.status === "error" ? result.summary : undefined,
    };
  } catch (error) {
    if (error instanceof LlmAbortError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "completed",
      invocation,
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: true,
          content: message,
        },
        summary: message,
      },
      status: "error",
      errorMessage: message,
    };
  }
}

async function executeToolCall(
  toolUse: ToolUseContentBlock,
  toolSet: RuntimeToolSet,
  localTools: LocalRuntimeTool[],
  hub: ProviderRuntimeHub,
  config: SloppyConfig,
  onToolEvent?: (event: AgentToolEvent) => void,
  toolPolicy?: RunLoopHooks["toolPolicy"],
  transformInvoke?: RunLoopHooks["transformInvoke"],
  roleId?: string,
  signal?: AbortSignal,
): Promise<ExecuteToolCallResult> {
  const resolution = toolSet.resolve(toolUse.name);
  if (!resolution) {
    const localTool = localTools.find((item) => item.tool.function.name === toolUse.name);
    if (localTool) {
      return executeLocalToolCall(toolUse, localTool, hub, config, onToolEvent, signal);
    }
    return {
      kind: "completed",
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: true,
          content: `Unknown tool: ${toolUse.name}`,
        },
        summary: `unknown ${toolUse.name}`,
      },
      status: "error",
      errorMessage: `Unknown tool: ${toolUse.name}`,
    };
  }

  if (toolUse.inputError) {
    return invalidToolArgumentsResult(toolUse, resolution, onToolEvent);
  }

  let activeInvocation: AgentToolInvocation | undefined;
  let activeSummary: string | undefined;

  try {
    if (resolution.kind === "observation") {
      const providerId = String(toolUse.input.provider ?? "");
      const path = String(toolUse.input.path ?? "/");
      const invocation: AgentToolInvocation = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        kind: "observation",
        providerId,
        path,
        action: resolution.action,
        params: { ...toolUse.input },
      };
      const summary = `${resolution.action} ${providerId}${path}`;
      onToolEvent?.({
        kind: "started",
        invocation,
        summary,
      });

      if (resolution.action === "query_state") {
        const depth = typeof toolUse.input.depth === "number" ? toolUse.input.depth : 2;
        const maxNodes =
          typeof toolUse.input.max_nodes === "number" ? toolUse.input.max_nodes : undefined;
        const minSalience =
          typeof toolUse.input.min_salience === "number" ? toolUse.input.min_salience : undefined;
        const windowOffset =
          typeof toolUse.input.window_offset === "number" ? toolUse.input.window_offset : undefined;
        const windowCount =
          typeof toolUse.input.window_count === "number" ? toolUse.input.window_count : undefined;
        const tree = await hub.queryState({
          providerId,
          path,
          depth,
          maxNodes,
          minSalience,
          window:
            windowOffset != null && windowCount != null ? [windowOffset, windowCount] : undefined,
        });

        return {
          kind: "completed",
          invocation,
          result: {
            block: {
              type: "tool_result",
              toolUseId: toolUse.id,
              content: `Queried ${providerId}${path}\n\n${formatTree(tree)}`,
            },
            summary,
          },
          status: "ok",
        };
      }

      const depth =
        typeof toolUse.input.depth === "number" ? toolUse.input.depth : config.agent.detailDepth;
      const maxNodes =
        typeof toolUse.input.max_nodes === "number"
          ? toolUse.input.max_nodes
          : config.agent.detailMaxNodes;
      const tree = await hub.focusState({
        providerId,
        path,
        depth,
        maxNodes,
      });

      return {
        kind: "completed",
        invocation,
        result: {
          block: {
            type: "tool_result",
            toolUseId: toolUse.id,
            content: `Focused ${providerId}${path}\n\n${formatTree(tree)}`,
          },
          summary,
        },
        status: "ok",
      };
    }

    const rawInput = { ...toolUse.input };
    let path = resolution.path;
    if (path == null) {
      const target = rawInput.target;
      if (typeof target !== "string" || target.length === 0) {
        throw new Error(`Grouped affordance ${toolUse.name} requires a target path.`);
      }
      path = target;
      delete rawInput.target;
    }

    const invocation: AgentToolInvocation = {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      kind: "affordance",
      providerId: resolution.providerId,
      path,
      action: resolution.action,
      params: rawInput,
    };
    const summary = `${resolution.providerId}:${resolution.action} ${path}`;
    activeInvocation = invocation;
    activeSummary = summary;
    onToolEvent?.({
      kind: "started",
      invocation,
      summary,
    });

    const policyDecision = toolPolicy?.(resolution, rawInput, config) ?? null;
    if (policyDecision) {
      return {
        kind: "completed",
        invocation,
        result: {
          block: {
            type: "tool_result",
            toolUseId: toolUse.id,
            isError: true,
            content: policyDecision.reject,
          },
          summary,
        },
        status: "error",
        errorCode: "tool_policy_rejected",
        errorMessage: policyDecision.reject,
      };
    }

    const finalInput = transformInvoke ? transformInvoke(resolution, rawInput, config) : rawInput;
    invocation.params = finalInput;
    const result = await hub.invoke(resolution.providerId, path, resolution.action, finalInput, {
      roleId,
    });
    if (result.status === "accepted") {
      await hub
        .focusState({
          providerId: resolution.providerId,
          path: "/tasks",
          depth: 2,
          maxNodes: config.agent.detailMaxNodes,
        })
        .catch(() => undefined);
    }

    if (result.status === "error" && result.error?.code === "approval_required") {
      return {
        kind: "approval_requested",
        invocation,
        summary,
        errorCode: result.error.code,
        errorMessage: result.error.message,
        approvalId: extractApprovalId(result.data),
      };
    }

    const taskId =
      result.status === "accepted" &&
      result.data &&
      typeof result.data === "object" &&
      !Array.isArray(result.data) &&
      typeof (result.data as { taskId?: unknown }).taskId === "string"
        ? (result.data as { taskId: string }).taskId
        : undefined;

    return {
      kind: "completed",
      invocation,
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: result.status === "error",
          content: stringifyResult(result),
        },
        summary,
      },
      status: result.status,
      taskId,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = classifyToolInvocationError(error);
    return {
      kind: "completed",
      invocation: activeInvocation,
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: true,
          content: message,
        },
        summary: activeSummary ?? `error ${toolUse.name}`,
      },
      status: "error",
      errorCode,
      errorMessage: message,
    };
  }
}

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

function resumeToolExecutionState(
  continuation: PendingApprovalContinuation,
  resolvedToolResult: ToolResultContentBlock,
): {
  startIndex: number;
  toolResults: ToolResultContentBlock[];
} {
  const toolResults = [...continuation.toolResults, resolvedToolResult];
  let startIndex = continuation.nextToolCallIndex;
  const deferredToolResults = [...(continuation.deferredToolResults ?? [])].sort(
    (left, right) => left.toolCallIndex - right.toolCallIndex,
  );

  for (const deferred of deferredToolResults) {
    if (deferred.toolCallIndex !== startIndex) break;
    toolResults.push(deferred.result);
    startIndex += 1;
  }

  return { startIndex, toolResults };
}

async function executeToolCalls(options: ExecuteToolCallsOptions): Promise<
  | {
      status: "completed";
      toolResults: ToolResultContentBlock[];
    }
  | {
      status: "waiting_approval";
      pending: PendingApprovalContinuation;
    }
> {
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
        const approvalResult = chunkResults[approvalOffset] as Extract<
          ExecuteToolCallResult,
          { kind: "approval_requested" }
        >;
        const deferredToolResults: NonNullable<PendingApprovalContinuation["deferredToolResults"]> =
          [];

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
            deferredToolResults.push({
              toolCallIndex,
              result: result.result.block,
            });
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

  return {
    status: "completed",
    toolResults,
  };
}

export async function runLoop(options: {
  config: SloppyConfig;
  hub: ProviderRuntimeHub;
  history: ConversationHistory;
  llm: LlmAdapter;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
  onToolEvent?: (event: AgentToolEvent) => void;
  resume?: {
    continuation: PendingApprovalContinuation;
    resolvedToolResult: ToolResultContentBlock;
  };
  systemPrompt?: string;
  hooks?: RunLoopHooks;
}): Promise<RunLoopResult> {
  const system = options.systemPrompt ?? buildSystemPrompt(options.config);
  let approval: ApprovalState = options.resume
    ? resumingApproval(options.resume.continuation, options.resume.resolvedToolResult)
    : idleApproval;
  const toolPolicy = options.hooks?.toolPolicy;
  const transformInvoke = options.hooks?.transformInvoke;
  const beforeNextTurn = options.hooks?.beforeNextTurn;
  const roleId = options.hooks?.roleId;
  const localTools = options.hooks?.localTools;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  for (let iteration = 0; iteration < options.config.agent.maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const plan = planIteration(approval, iteration);

    if (plan.kind === "skip") continue;

    if (plan.kind === "resume") {
      const resumeState = resumeToolExecutionState(plan.continuation, plan.resolvedToolResult);
      const resumedExecution = await executeToolCalls({
        toolCalls: plan.continuation.toolCalls,
        startIndex: resumeState.startIndex,
        toolResults: resumeState.toolResults,
        iteration,
        toolSet: options.hub.getRuntimeToolSet(),
        localTools: localTools?.() ?? [],
        hub: options.hub,
        config: options.config,
        onToolCall: options.onToolCall,
        onToolResult: options.onToolResult,
        onToolEvent: options.onToolEvent,
        toolPolicy,
        transformInvoke,
        roleId,
        signal: options.signal,
      });

      if (resumedExecution.status === "waiting_approval") {
        return {
          ...suspendedResult(resumedExecution.pending),
          usage: { ...usage },
        };
      }

      options.history.addToolResults(resumedExecution.toolResults);
      approval = idleApproval;
      if (beforeNextTurn) {
        await beforeNextTurn(options.hub, options.signal);
      }
      continue;
    }

    const stateContext = buildStateContext(options.hub.getProviderViews(), options.config);
    const toolSet = options.hub.getRuntimeToolSet();
    const activeLocalTools = localTools?.() ?? [];
    const response = await options.llm.chat({
      system,
      messages: options.history.buildRequestMessages(stateContext),
      tools: [...toolSet.tools, ...activeLocalTools.map((item) => item.tool)],
      maxTokens: options.config.llm.maxTokens,
      onText: options.onText,
      signal: options.signal,
    });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    options.history.addAssistantContent(response.content);

    const toolCalls = response.content.filter(
      (block): block is ToolUseContentBlock => block.type === "tool_use",
    );
    debug("loop", "turn", {
      iteration,
      stop_reason: response.stopReason,
      tool_calls: toolCalls.length,
    });
    if (toolCalls.length === 0 || response.stopReason !== "tool_use") {
      return {
        status: "completed",
        response: options.history.latestAssistantText(),
        usage: { ...usage },
      };
    }

    const execution = await executeToolCalls({
      toolCalls,
      startIndex: 0,
      toolResults: [],
      iteration,
      toolSet,
      localTools: activeLocalTools,
      hub: options.hub,
      config: options.config,
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
      onToolEvent: options.onToolEvent,
      toolPolicy,
      transformInvoke,
      roleId,
      signal: options.signal,
    });
    if (execution.status === "waiting_approval") {
      return {
        ...suspendedResult(execution.pending),
        usage: { ...usage },
      };
    }

    options.history.addToolResults(execution.toolResults);
    if (beforeNextTurn) {
      await beforeNextTurn(options.hub, options.signal);
    }
  }

  throw new Error(
    `Exceeded max iterations (${options.config.agent.maxIterations}). Increase agent.maxIterations in config or set SLOPPY_MAX_ITERATIONS for this run.`,
  );
}

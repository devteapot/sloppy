import { formatTree } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { LlmAdapter, ToolResultContentBlock, ToolUseContentBlock } from "../llm/types";
import { LlmAbortError } from "../llm/types";
import type { ConsumerHub } from "./consumer";
import { buildStateContext, buildSystemPrompt } from "./context";
import { debug } from "./debug";
import type { ConversationHistory } from "./history";
import type { RuntimeToolSet } from "./tools";

type ToolResult = {
  block: ToolResultContentBlock;
  summary: string;
};

export type AgentToolInvocation = {
  toolUseId: string;
  toolName: string;
  kind: "observation" | "affordance";
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
    };

export type PendingApprovalContinuation = {
  blockedInvocation: AgentToolInvocation;
  iteration: number;
  toolCalls: ToolUseContentBlock[];
  nextToolCallIndex: number;
  toolResults: ToolResultContentBlock[];
};

export type RunLoopResult =
  | {
      status: "completed";
      response: string;
    }
  | {
      status: "waiting_approval";
      pending: PendingApprovalContinuation;
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
    };

function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

export function truncateToolResult(result: unknown, maxSize: number): string {
  const content = stringifyResult(result);
  const contentLength = content.length;

  if (contentLength <= maxSize) {
    return content;
  }

  const truncationMessage =
    "[truncated: $removed chars removed, use slop_query_state for full details]";
  const reservedForMessage = 100;
  const keep = maxSize - reservedForMessage;

  return (
    content.slice(0, keep) + truncationMessage.replace("$removed", String(contentLength - keep))
  );
}

async function executeToolCall(
  toolUse: ToolUseContentBlock,
  toolSet: RuntimeToolSet,
  hub: ConsumerHub,
  config: SloppyConfig,
  onToolEvent?: (event: AgentToolEvent) => void,
): Promise<ExecuteToolCallResult> {
  const resolution = toolSet.resolve(toolUse.name);
  if (!resolution) {
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
    onToolEvent?.({
      kind: "started",
      invocation,
      summary,
    });

    const result = await hub.invoke(resolution.providerId, path, resolution.action, rawInput);
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
    return {
      kind: "completed",
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: true,
          content: error instanceof Error ? error.message : String(error),
        },
        summary: `error ${toolUse.name}`,
      },
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeToolCalls(options: {
  toolCalls: ToolUseContentBlock[];
  startIndex: number;
  toolResults: ToolResultContentBlock[];
  iteration: number;
  toolSet: RuntimeToolSet;
  hub: ConsumerHub;
  config: SloppyConfig;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
  onToolEvent?: (event: AgentToolEvent) => void;
}): Promise<
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

  for (let index = options.startIndex; index < options.toolCalls.length; index += 1) {
    const toolCall = options.toolCalls[index];
    options.onToolCall?.(`${toolCall.name} ${JSON.stringify(toolCall.input)}`);
    const result = await executeToolCall(
      toolCall,
      options.toolSet,
      options.hub,
      options.config,
      options.onToolEvent,
    );

    if (result.kind === "approval_requested") {
      options.onToolEvent?.({
        kind: "approval_requested",
        invocation: result.invocation,
        summary: result.summary,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      return {
        status: "waiting_approval",
        pending: {
          blockedInvocation: result.invocation,
          iteration: options.iteration,
          toolCalls: options.toolCalls,
          nextToolCallIndex: index + 1,
          toolResults,
        },
      };
    }

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
    toolResults.push(result.result.block);
  }

  return {
    status: "completed",
    toolResults,
  };
}

export async function runLoop(options: {
  config: SloppyConfig;
  hub: ConsumerHub;
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
}): Promise<RunLoopResult> {
  const system = buildSystemPrompt(options.config);
  let pendingResume = options.resume;

  for (let iteration = 0; iteration < options.config.agent.maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    if (pendingResume && iteration < pendingResume.continuation.iteration) {
      continue;
    }

    if (pendingResume && iteration === pendingResume.continuation.iteration) {
      const resumedExecution = await executeToolCalls({
        toolCalls: pendingResume.continuation.toolCalls,
        startIndex: pendingResume.continuation.nextToolCallIndex,
        toolResults: [...pendingResume.continuation.toolResults, pendingResume.resolvedToolResult],
        iteration,
        toolSet: options.hub.getRuntimeToolSet(),
        hub: options.hub,
        config: options.config,
        onToolCall: options.onToolCall,
        onToolResult: options.onToolResult,
        onToolEvent: options.onToolEvent,
      });

      if (resumedExecution.status === "waiting_approval") {
        return {
          status: "waiting_approval",
          pending: resumedExecution.pending,
        };
      }

      options.history.addToolResults(resumedExecution.toolResults);
      pendingResume = undefined;
      continue;
    }

    const stateContext = buildStateContext(options.hub.getProviderViews(), options.config);
    const toolSet = options.hub.getRuntimeToolSet();
    const response = await options.llm.chat({
      system,
      messages: options.history.buildRequestMessages(stateContext),
      tools: toolSet.tools,
      maxTokens: options.config.llm.maxTokens,
      onText: options.onText,
      signal: options.signal,
    });

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
      };
    }

    const execution = await executeToolCalls({
      toolCalls,
      startIndex: 0,
      toolResults: [],
      iteration,
      toolSet,
      hub: options.hub,
      config: options.config,
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
      onToolEvent: options.onToolEvent,
    });
    if (execution.status === "waiting_approval") {
      return {
        status: "waiting_approval",
        pending: execution.pending,
      };
    }

    options.history.addToolResults(execution.toolResults);
  }

  throw new Error(`Exceeded max iterations (${options.config.agent.maxIterations}).`);
}

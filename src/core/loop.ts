import { formatTree, type SlopNode } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { LlmAdapter, ToolResultContentBlock, ToolUseContentBlock } from "../llm/types";
import { LlmAbortError } from "../llm/types";
import type { ConsumerHub } from "./consumer";
import { buildStateContext, buildSystemPrompt } from "./context";
import { debug } from "./debug";
import type { ConversationHistory } from "./history";
import type { ProviderTreeView } from "./subscriptions";
import type { RuntimeToolResolution, RuntimeToolSet } from "./tools";

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

const DELEGATED_WORK_SUSPEND_TIMEOUT_MS = 5 * 60_000;
const STATE_CHANGE_WAIT_SLICE_MS = 30_000;
const ACTIVE_AGENT_STATUSES = new Set(["pending", "running"]);
const ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS = new Set([
  "write",
  "edit",
  "mkdir",
  "delete",
  "remove",
  "move",
  "copy",
]);

const ORCHESTRATOR_SAFE_TERMINAL_COMMANDS = [
  /^npm run (build|lint|test|typecheck)$/,
  /^npm test$/,
  /^bun run (build|lint|test|typecheck)$/,
  /^bun test(?: .*)?$/,
  /^tsc(?: -b| --noEmit)?$/,
  /^vite build$/,
];

function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function orchestratorToolPolicyViolation(
  config: SloppyConfig,
  resolution: RuntimeToolResolution,
  params: Record<string, unknown>,
): string | null {
  if (!config.agent.orchestratorMode || resolution.kind !== "affordance") {
    return null;
  }

  if (
    resolution.providerId === "filesystem" &&
    ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS.has(resolution.action)
  ) {
    return `Orchestrator mode cannot call filesystem.${resolution.action} directly. Create or retry a delegated task with spawn_agent so a sub-agent performs file mutations.`;
  }

  if (resolution.providerId === "delegation" && resolution.action === "spawn_agent") {
    return `Orchestrator mode does not spawn delegation agents directly. Create or retry orchestration tasks; the runtime scheduler starts ready tasks when dependencies and capacity allow.`;
  }

  if (resolution.providerId === "terminal" && resolution.action === "execute") {
    const command = typeof params.command === "string" ? params.command.trim() : "";
    const isSafeVerification = ORCHESTRATOR_SAFE_TERMINAL_COMMANDS.some((pattern) =>
      pattern.test(command),
    );
    if (!isSafeVerification) {
      return `Orchestrator mode can only run simple verification commands directly (build, lint, test, typecheck). Delegate setup, install, repair, and shell-composed commands to a sub-agent.`;
    }
  }

  return null;
}

function toolErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return typeof candidate.code === "string" ? candidate.code : undefined;
  }
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown };
    return typeof candidate.code === "string" ? candidate.code : undefined;
  }
  return undefined;
}

function getNodeProperties(node: SlopNode): Record<string, unknown> {
  const properties = node.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }
  return properties as Record<string, unknown>;
}

function walkTree(node: SlopNode, visit: (node: SlopNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walkTree(child, visit);
  }
}

function hasPendingChildApproval(view: ProviderTreeView): boolean {
  let found = false;
  walkTree(view.overviewTree, (node) => {
    const properties = getNodeProperties(node);
    const pendingApprovals = properties.pending_approvals;
    if (Array.isArray(pendingApprovals) && pendingApprovals.length > 0) {
      found = true;
    }
    if (properties.state === "waiting_approval") {
      found = true;
    }
  });
  if (view.detailTree) {
    walkTree(view.detailTree, (node) => {
      const properties = getNodeProperties(node);
      if (properties.state === "waiting_approval") {
        found = true;
      }
    });
  }
  return found;
}

function hasSuspensibleDelegatedWork(views: ProviderTreeView[]): boolean {
  const delegationView = views.find((view) => view.providerId === "delegation");
  if (!delegationView || hasPendingChildApproval(delegationView)) {
    return false;
  }

  let activeAgent = false;
  walkTree(delegationView.overviewTree, (node) => {
    const properties = getNodeProperties(node);
    if (typeof properties.status === "string" && ACTIVE_AGENT_STATUSES.has(properties.status)) {
      activeAgent = true;
    }
  });

  return activeAgent;
}

async function suspendForDelegatedWork(hub: ConsumerHub, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let logged = false;

  while (hasSuspensibleDelegatedWork(hub.getProviderViews())) {
    if (signal?.aborted) {
      throw new LlmAbortError();
    }

    const elapsed = Date.now() - startedAt;
    const remaining = DELEGATED_WORK_SUSPEND_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      debug("loop", "delegated_work_suspend_timeout", {
        timeout_ms: DELEGATED_WORK_SUSPEND_TIMEOUT_MS,
      });
      return;
    }

    if (!logged) {
      debug("loop", "delegated_work_suspend", {
        timeout_ms: DELEGATED_WORK_SUSPEND_TIMEOUT_MS,
      });
      logged = true;
    }

    const revision = hub.getStateRevision();
    await hub.waitForStateChange(revision, {
      timeoutMs: Math.min(STATE_CHANGE_WAIT_SLICE_MS, remaining),
      signal,
    });
  }
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

function invalidToolArgumentsResult(
  toolUse: ToolUseContentBlock,
  resolution: RuntimeToolResolution,
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
    kind: resolution.kind === "observation" ? "observation" : "affordance",
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

  if (toolUse.inputError) {
    return invalidToolArgumentsResult(toolUse, resolution, onToolEvent);
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

    const policyViolation = orchestratorToolPolicyViolation(config, resolution, rawInput);
    if (policyViolation) {
      return {
        kind: "completed",
        invocation,
        result: {
          block: {
            type: "tool_result",
            toolUseId: toolUse.id,
            isError: true,
            content: policyViolation,
          },
          summary,
        },
        status: "error",
        errorCode: "orchestrator_tool_restricted",
        errorMessage: policyViolation,
      };
    }

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
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "completed",
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: true,
          content: message,
        },
        summary: `error ${toolUse.name}`,
      },
      status: "error",
      errorCode: toolErrorCode(error),
      errorMessage: message,
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
      await suspendForDelegatedWork(options.hub, options.signal);
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
    await suspendForDelegatedWork(options.hub, options.signal);
  }

  throw new Error(
    `Exceeded max iterations (${options.config.agent.maxIterations}). Increase agent.maxIterations in config or set SLOPPY_MAX_ITERATIONS for this run.`,
  );
}

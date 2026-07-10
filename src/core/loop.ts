import type { SloppyConfig } from "../config/schema";
import type {
  LlmAdapter,
  LlmChatOptions,
  LlmTokenCount,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../llm/types";
import { isLlmAbortError, LlmAbortError } from "../llm/types";
import { buildStateContext, buildSystemPrompt } from "./context";
import { debug } from "./debug";
import type { ConversationHistory } from "./history";
import type { ProviderRuntimeHub } from "./hub";
import {
  type ApprovalState,
  idleApproval,
  planIteration,
  resumingApproval,
  suspendedResult,
} from "./loop/approval-suspension";
import type {
  AgentToolEvent,
  PendingApprovalContinuation,
  RunLoopHooks,
  RunLoopResult,
} from "./loop/contracts";
import { executeToolCalls, resumeToolExecutionState } from "./loop/tool-scheduler";

export type {
  AgentToolEvent,
  AgentToolInvocation,
  AgentToolResult,
  LocalRuntimeTool,
  LocalRuntimeToolContext,
  LocalRuntimeToolResult,
  PendingApprovalContinuation,
  RunLoopHooks,
  RunLoopResult,
} from "./loop/contracts";

export { truncateToolResult } from "./loop/result-format";

export async function countStateContextTokens(
  llm: LlmAdapter,
  stateContext: string,
  signal?: AbortSignal,
): Promise<LlmTokenCount> {
  if (!llm.countTextTokens) {
    return { source: "unavailable" };
  }

  try {
    return await llm.countTextTokens(stateContext, { signal });
  } catch (error) {
    if (signal?.aborted || isLlmAbortError(error)) {
      throw error;
    }
    debug("loop", "state token count unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { source: "unavailable" };
  }
}

export async function runLoop(options: {
  config: SloppyConfig;
  hub: ProviderRuntimeHub;
  history: ConversationHistory;
  llm: LlmAdapter;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onThinking?: LlmChatOptions["onThinking"];
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
  onToolEvent?: (event: AgentToolEvent) => void;
  onTurnUsage?: (usage: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    inputTokenSource: "reported" | "unavailable";
    outputTokenSource: "reported" | "unavailable";
    thinkingTokenSource?: "reported" | "unavailable";
    stateContextTokens?: number;
    stateContextTokenSource: "provider" | "local" | "unavailable";
  }) => void;
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
  const usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

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
        return { ...suspendedResult(resumedExecution.pending), usage: { ...usage } };
      }

      options.history.addToolResults(resumedExecution.toolResults);
      approval = idleApproval;
      if (beforeNextTurn) {
        await beforeNextTurn(options.hub, options.signal);
      }
      continue;
    }

    const stateContext = buildStateContext(options.hub.getProviderViews(), options.config);
    const stateContextTokenCount = await countStateContextTokens(
      options.llm,
      stateContext,
      options.signal,
    );
    const toolSet = options.hub.getRuntimeToolSet();
    const activeLocalTools = localTools?.() ?? [];
    const response = await options.llm.chat({
      system,
      messages: options.history.buildRequestMessages(stateContext),
      tools: [...toolSet.tools, ...activeLocalTools.map((item) => item.tool)],
      maxTokens: options.config.llm.maxTokens,
      onText: options.onText,
      onThinking: options.onThinking,
      signal: options.signal,
    });
    const reportedInput = response.usage.inputTokens;
    const reportedOutput = response.usage.outputTokens;
    const reportedThinking = response.usage.thinkingTokens;
    usage.inputTokens += reportedInput ?? 0;
    usage.outputTokens += reportedOutput ?? 0;
    usage.thinkingTokens += reportedThinking ?? 0;
    options.onTurnUsage?.({
      inputTokens: reportedInput,
      outputTokens: reportedOutput,
      thinkingTokens: reportedThinking,
      inputTokenSource: reportedInput === undefined ? "unavailable" : "reported",
      outputTokenSource: reportedOutput === undefined ? "unavailable" : "reported",
      thinkingTokenSource: reportedThinking === undefined ? "unavailable" : "reported",
      stateContextTokens: stateContextTokenCount.tokens,
      stateContextTokenSource: stateContextTokenCount.source,
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
      return { ...suspendedResult(execution.pending), usage: { ...usage } };
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

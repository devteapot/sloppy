import type { SloppyConfig } from "../config/schema";
import type {
  ConversationMessage,
  LlmAdapter,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../llm/types";
import {
  getLlmRuntimeDescriptor,
  isLlmAbortError,
  isLlmContextOverflowError,
  LlmAbortError,
  LlmContextOverflowError,
  LlmRequestError,
  normalizeLlmError,
  resolveLlmMaxTokens,
} from "../llm/types";
import {
  buildContextBudget,
  compactConversationHistory,
  estimateRequestTokens,
} from "./compaction";
import { buildStateContext, buildSystemPrompt } from "./context";
import { debug } from "./debug";
import { CANCELLED_TOOL_BATCH_RESULT, type ConversationHistory } from "./history";
import type { ProviderRuntimeHub } from "./hub";
import type { ImageRegistry } from "./images";
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

export function buildToolFreeRequestHistory(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.flatMap((block) => {
      if (block.type === "tool_use") {
        return [
          {
            type: "text" as const,
            text: `[Previous tool call '${block.name}': ${JSON.stringify(block.input)}]`,
          },
        ];
      }
      if (block.type === "tool_result") {
        return [
          {
            type: "text" as const,
            text: `[Previous tool result for '${block.toolUseId}': ${block.content}]`,
          },
        ];
      }
      if (block.type === "provider_continuation" && block.purpose === "tool_call") {
        return [];
      }
      return [block];
    }),
  }));
}

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
  contextWindowTokens?: number;
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
  imageRegistry?: ImageRegistry;
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
  const recordUsage = (
    response: LlmResponse,
    stateContextTokenCount?: LlmTokenCount,
    additionalStateTokens = 0,
  ): void => {
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
      stateContextTokens:
        stateContextTokenCount?.tokens !== undefined
          ? stateContextTokenCount.tokens + additionalStateTokens
          : additionalStateTokens > 0
            ? additionalStateTokens
            : undefined,
      stateContextTokenSource:
        stateContextTokenCount?.tokens !== undefined
          ? stateContextTokenCount.source
          : additionalStateTokens > 0
            ? "local"
            : (stateContextTokenCount?.source ?? "unavailable"),
    });
  };

  for (let iteration = 0; iteration < options.config.agent.maxIterations; iteration += 1) {
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
        imageRegistry: options.imageRegistry,
      });

      if (resumedExecution.status === "waiting_approval") {
        return { ...suspendedResult(resumedExecution.pending), usage: { ...usage } };
      }
      if (resumedExecution.status === "cancelled") {
        options.history.addToolBatchResults(
          plan.continuation.toolCalls,
          resumedExecution.toolResults,
          CANCELLED_TOOL_BATCH_RESULT,
        );
        throw new LlmAbortError();
      }

      options.history.addToolResults(resumedExecution.toolResults);
      approval = idleApproval;
      if (beforeNextTurn) {
        await beforeNextTurn(options.hub, options.signal);
      }
      continue;
    }

    if (options.signal?.aborted) {
      throw new LlmAbortError();
    }

    const stateContext = buildStateContext(options.hub.getProviderViews(), options.config);
    const stateContextTokenCount = await countStateContextTokens(
      options.llm,
      stateContext,
      options.signal,
    );
    const runtime = getLlmRuntimeDescriptor(options.llm);
    const toolSet = options.hub.getRuntimeToolSet();
    const activeLocalTools = localTools?.() ?? [];
    const trailImages = options.imageRegistry?.collectTrailImages() ?? [];
    const imageTokenEstimate = options.imageRegistry?.estimateLoadedImageTokens() ?? 0;
    const tools =
      runtime?.capabilities.tools === false
        ? []
        : [...toolSet.tools, ...activeLocalTools.map((item) => item.tool)];
    const maxTokens = resolveLlmMaxTokens(options.llm, options.config.llm.maxTokens);
    const buildMessages = (): ConversationMessage[] => {
      const portableMessages = options.history.buildRequestMessages(stateContext, trailImages);
      return runtime?.capabilities.tools === false
        ? buildToolFreeRequestHistory(portableMessages)
        : portableMessages;
    };
    const requestTokens = () =>
      estimateRequestTokens({
        system,
        messages: buildMessages(),
        tools,
      });
    const compact = async (force = false) =>
      compactConversationHistory({
        history: options.history,
        llm: options.llm,
        config: options.config,
        contextWindowTokens: options.contextWindowTokens,
        estimatedTokensBefore: requestTokens(),
        maxOutputTokens: maxTokens,
        force,
        signal: options.signal,
        onSummaryCall: (summaryResponse) => recordUsage(summaryResponse),
      });

    await compact();
    const messages = buildMessages();
    if (
      runtime?.capabilities.images === false &&
      messages.some((message) => message.content.some((block) => block.type === "image"))
    ) {
      throw new LlmRequestError(
        `LLM model '${runtime.model}' on endpoint '${runtime.endpointId}' does not support image input.`,
        {
          code: "invalid_request",
          retryable: false,
        },
      );
    }
    const assertRequestFits = (): void => {
      const estimatedInputTokens = requestTokens();
      const budget = buildContextBudget({
        config: options.config,
        contextWindowTokens: options.contextWindowTokens,
        estimatedInputTokens,
        outputReserveTokens: maxTokens,
      });
      if (
        budget.usableInputTokens !== undefined &&
        estimatedInputTokens > budget.usableInputTokens
      ) {
        throw new LlmContextOverflowError(
          `The request still needs approximately ${estimatedInputTokens} input tokens after compaction, but only ${budget.usableInputTokens} are available after reserving model output. Unfocus or unload provider state, close large filesystem views, or use a model with a larger context window.`,
        );
      }
    };
    assertRequestFits();

    let emittedOutput = false;
    const chat = () =>
      options.llm.chat({
        system,
        messages: buildMessages(),
        tools,
        maxTokens,
        onText: options.onText
          ? (chunk) => {
              emittedOutput ||= chunk.length > 0;
              options.onText?.(chunk);
            }
          : undefined,
        onThinking: options.onThinking
          ? (delta) => {
              emittedOutput ||= delta.delta.length > 0;
              options.onThinking?.(delta);
            }
          : undefined,
        signal: options.signal,
      });
    let response: LlmResponse;
    try {
      response = await chat();
    } catch (error) {
      const normalized = normalizeLlmError(error, options.signal);
      if (
        !options.config.agent.contextCompaction.retryOnOverflow ||
        !isLlmContextOverflowError(normalized) ||
        emittedOutput ||
        (error instanceof LlmRequestError && error.partialOutput)
      ) {
        throw normalized;
      }
      const recovery = await compact(true);
      if (!recovery.compacted) {
        throw normalized;
      }
      assertRequestFits();
      try {
        response = await chat();
      } catch (retryError) {
        throw normalizeLlmError(retryError, options.signal);
      }
    }
    // Tick after a completed request so each loaded image gets exactly its TTL
    // worth of appearances; aborted requests and resume iterations do not age.
    options.imageRegistry?.onTurn();
    recordUsage(response, stateContextTokenCount, imageTokenEstimate);

    const toolCalls = response.content.filter(
      (block): block is ToolUseContentBlock => block.type === "tool_use",
    );
    if (runtime?.capabilities.tools === false && toolCalls.length > 0) {
      throw new LlmRequestError(
        `LLM model '${runtime.model}' on endpoint '${runtime.endpointId}' returned a tool call even though tools are disabled for that model.`,
        {
          code: "provider",
          retryable: false,
          partialOutput: emittedOutput,
        },
      );
    }
    options.history.addAssistantContent(response.content);
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
      imageRegistry: options.imageRegistry,
    });
    if (execution.status === "waiting_approval") {
      return { ...suspendedResult(execution.pending), usage: { ...usage } };
    }
    if (execution.status === "cancelled") {
      options.history.addToolBatchResults(
        toolCalls,
        execution.toolResults,
        CANCELLED_TOOL_BATCH_RESULT,
      );
      throw new LlmAbortError();
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

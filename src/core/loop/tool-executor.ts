import type { SloppyConfig } from "../../config/schema";
import type { ToolUseContentBlock } from "../../llm/types";
import { LlmAbortError } from "../../llm/types";
import type { ProviderRuntimeHub } from "../hub";
import type { ImageRegistry } from "../images";
import type { RuntimeToolResolution, RuntimeToolSet } from "../tools";
import { formatStateTree } from "../tree-format";
import { classifyToolInvocationError, extractApprovalId } from "./approval-suspension";
import { loadContentRefImageRecords } from "./content-ref-images";
import type {
  AgentToolEvent,
  AgentToolInvocation,
  ExecuteToolCallResult,
  LocalRuntimeTool,
  RunLoopHooks,
} from "./contracts";
import { stringifyResult } from "./result-format";

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
    label: resolution.kind === "affordance" ? resolution.label : undefined,
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
    pluginId: localTool.pluginId,
    providerId: localTool.providerId ?? "session",
    path: localTool.path ?? "/runtime",
    action,
    params: { ...toolUse.input },
  };
  const summary = `${invocation.providerId}:${action} ${invocation.path}`;
  onToolEvent?.({ kind: "started", invocation, summary });

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

export async function executeToolCall(
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
  imageRegistry?: ImageRegistry,
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
      return await executeObservationTool(toolUse, resolution, hub, config, onToolEvent);
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
      label: resolution.label,
      resultKind: resolution.resultKind,
      params: rawInput,
    };
    const summary = `${resolution.providerId}:${resolution.action} ${path}`;
    activeInvocation = invocation;
    activeSummary = summary;
    onToolEvent?.({ kind: "started", invocation, summary });

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
        .focusState({ providerId: resolution.providerId, path: "/tasks", depth: 2 })
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

    const taskId = readTaskId(result.status, result.data);
    let registeredNotes = "";
    if (result.status === "ok" && imageRegistry) {
      const records = await loadContentRefImageRecords(result.data, {
        maxBytes: config.agent.toolResultImageMaxBytes,
      });
      registeredNotes = records
        .map((record) => {
          const entry = imageRegistry.register({
            bytes: record.bytes,
            mediaType: record.mediaType,
            summary: record.summary ?? "tool result image",
            source: `tool:${resolution.providerId}:${path}`,
            width: record.width,
            height: record.height,
          });
          const state = entry.loaded
            ? `loaded, ttl ${entry.ttlTurnsRemaining}`
            : "registered unloaded — trail is full of pinned images";
          const nudge = entry.loaded ? " — describe it before it unloads" : "";
          return `\n[image registered as ${entry.path} (${state})${nudge}]`;
        })
        .join("");
    }
    return {
      kind: "completed",
      invocation,
      result: {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          isError: result.status === "error",
          content: stringifyResult(result) + registeredNotes,
        },
        summary,
      },
      status: result.status,
      taskId,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      activityResult: { kind: resolution.resultKind, data: result.data },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
      errorCode: classifyToolInvocationError(error),
      errorMessage: message,
    };
  }
}

async function executeObservationTool(
  toolUse: ToolUseContentBlock,
  resolution: Extract<RuntimeToolResolution, { kind: "observation" }>,
  hub: ProviderRuntimeHub,
  config: SloppyConfig,
  onToolEvent?: (event: AgentToolEvent) => void,
): Promise<ExecuteToolCallResult> {
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
  onToolEvent?.({ kind: "started", invocation, summary });

  if (resolution.action === "query_state") {
    const depth = typeof toolUse.input.depth === "number" ? toolUse.input.depth : 2;
    const windowOffset =
      typeof toolUse.input.window_offset === "number" ? toolUse.input.window_offset : undefined;
    const windowCount =
      typeof toolUse.input.window_count === "number" ? toolUse.input.window_count : undefined;
    const tree = await hub.queryState({
      providerId,
      path,
      depth,
      window: windowOffset != null && windowCount != null ? [windowOffset, windowCount] : undefined,
    });
    return completedObservation(
      toolUse.id,
      invocation,
      summary,
      `Queried ${providerId}${path}\n\n${formatStateTree(tree)}`,
    );
  }

  if (resolution.action === "unfocus_state") {
    const result = await hub.unfocusState({ providerId, path });
    return completedObservation(
      toolUse.id,
      invocation,
      summary,
      `Unfocused ${providerId}${path} (removed=${result.removed})`,
    );
  }

  const depth =
    typeof toolUse.input.depth === "number" ? toolUse.input.depth : config.agent.detailDepth;
  const tree = await hub.focusState({ providerId, path, depth });
  return completedObservation(
    toolUse.id,
    invocation,
    summary,
    `Focused ${providerId}${path}\n\n${formatStateTree(tree)}`,
  );
}

function completedObservation(
  toolUseId: string,
  invocation: AgentToolInvocation,
  summary: string,
  content: string,
): ExecuteToolCallResult {
  return {
    kind: "completed",
    invocation,
    result: {
      block: { type: "tool_result", toolUseId, content },
      summary,
    },
    status: "ok",
  };
}

function readTaskId(status: string, data: unknown): string | undefined {
  if (status !== "accepted" || !data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const taskId = (data as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

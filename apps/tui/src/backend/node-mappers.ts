import type { ResultMessage, SlopNode } from "@slop-ai/consumer";

import type {
  ActivityItem,
  AppItem,
  ApprovalItem,
  ComposerState,
  GoalState,
  InspectState,
  LlmProfile,
  LlmState,
  PluginActionContribution,
  PluginIndicatorContribution,
  PluginItem,
  PluginNotificationContribution,
  PluginUiManifest,
  QueuedItem,
  SessionMeta,
  SessionViewSnapshot,
  TaskItem,
  ToolCallResult,
  TranscriptBlock,
  TranscriptMessage,
  TurnState,
  UsageState,
} from "./slop-types";

const EMPTY_INSPECT: InspectState = {
  targetId: "session",
  targetName: "Session",
  path: "/",
  depth: 2,
  tree: null,
  result: null,
};

const EMPTY_GOAL: GoalState = {
  exists: false,
  status: "none",
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  totalTokens: 0,
  elapsedMs: 0,
  continuationCount: 0,
  evidence: [],
  canCreate: false,
  canPause: false,
  canResume: false,
  canComplete: false,
  canClear: false,
};

const EMPTY_USAGE: UsageState = {
  lastModelCallInputSource: "unavailable",
  lastModelCallOutputSource: "unavailable",
  lastModelCallThinkingSource: "unavailable",
  currentTurnModelCalls: 0,
  lastStateContextTokenSource: "unavailable",
};

export const EMPTY_SESSION_VIEW: SessionViewSnapshot = {
  connection: {
    status: "idle",
  },
  session: {
    sessionId: null,
    status: "unknown",
  },
  llm: {
    status: "unknown",
    message: "LLM state has not loaded yet.",
    profiles: [],
    actions: [],
  },
  usage: EMPTY_USAGE,
  turn: {
    turnId: null,
    state: "unknown",
    phase: "none",
    iteration: 0,
    message: "Not connected.",
    waitingOn: null,
    canCancel: false,
  },
  goal: EMPTY_GOAL,
  composer: {
    ready: false,
    acceptsAttachments: false,
    maxAttachments: 0,
    canSend: false,
    disabledReason: "Session provider is not connected.",
  },
  transcript: [],
  activity: [],
  approvals: [],
  tasks: [],
  apps: [],
  plugins: [],
  queue: [],
  inspect: EMPTY_INSPECT,
  actionsByPath: {},
};

function props(node: SlopNode | null | undefined): Record<string, unknown> {
  return node?.properties ?? {};
}

function children(node: SlopNode | null | undefined): SlopNode[] {
  return node?.children ?? [];
}

function hasAction(node: SlopNode | null | undefined, action: string): boolean {
  return node?.affordances?.some((affordance) => affordance.action === action) ?? false;
}

function stringProp(source: Record<string, unknown>, key: string, fallback = ""): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function optionalStringProp(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableStringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function booleanProp(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function numberProp(source: Record<string, unknown>, key: string, fallback = 0): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function progressProp(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayProp(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function recordProp(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalRecordProp(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolCallResultProp(
  source: Record<string, unknown>,
  key: string,
): ToolCallResult | undefined {
  const value = optionalRecordProp(source, key);
  if (!value) {
    return undefined;
  }
  return {
    kind: optionalStringProp(value, "kind"),
    data: value.data,
    truncated: booleanProp(value, "truncated"),
  };
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function roleProp(value: string): TranscriptMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system") {
    return value;
  }
  return "unknown";
}

function llmStatusProp(value: string): LlmState["status"] {
  if (value === "ready" || value === "needs_credentials") {
    return value;
  }
  return "unknown";
}

function turnStateProp(value: string): TurnState["state"] {
  if (
    value === "idle" ||
    value === "running" ||
    value === "waiting_approval" ||
    value === "error"
  ) {
    return value;
  }
  return "unknown";
}

export function mapSessionNode(node: SlopNode | null | undefined): SessionMeta {
  const p = props(node);
  return {
    sessionId: nullableStringProp(p, "session_id"),
    status: stringProp(p, "status", "unknown"),
    title: optionalStringProp(p, "title"),
    workspaceRoot: optionalStringProp(p, "workspace_root"),
    workspaceId: optionalStringProp(p, "workspace_id"),
    projectId: optionalStringProp(p, "project_id"),
    launchScopeKey: optionalStringProp(p, "launch_scope_key"),
    launchRoot: optionalStringProp(p, "launch_root"),
    modelProvider: optionalStringProp(p, "model_provider"),
    model: optionalStringProp(p, "model"),
    startedAt: optionalStringProp(p, "started_at"),
    updatedAt: optionalStringProp(p, "updated_at"),
    clientCount: progressProp(p, "client_count"),
    lastError: optionalStringProp(p, "last_error"),
  };
}

export function mapGoalNode(node: SlopNode | null | undefined): GoalState {
  const p = props(node);
  return {
    exists: booleanProp(p, "exists"),
    goalId: optionalStringProp(p, "goal_id"),
    objective: optionalStringProp(p, "objective"),
    status: stringProp(p, "status", "none"),
    createdAt: optionalStringProp(p, "created_at"),
    updatedAt: optionalStringProp(p, "updated_at"),
    completedAt: optionalStringProp(p, "completed_at"),
    tokenBudget: progressProp(p, "token_budget"),
    inputTokens: numberProp(p, "input_tokens"),
    outputTokens: numberProp(p, "output_tokens"),
    thinkingTokens: numberProp(p, "thinking_tokens"),
    totalTokens: numberProp(p, "total_tokens"),
    elapsedMs: numberProp(p, "elapsed_ms"),
    continuationCount: numberProp(p, "continuation_count"),
    lastTurnId: optionalStringProp(p, "last_turn_id"),
    message: optionalStringProp(p, "message"),
    evidence: stringArrayProp(p, "evidence"),
    updateSource: optionalStringProp(p, "update_source"),
    completionSource: optionalStringProp(p, "completion_source"),
    canCreate: hasAction(node, "create_goal"),
    canPause: hasAction(node, "pause_goal"),
    canResume: hasAction(node, "resume_goal"),
    canComplete: hasAction(node, "complete_goal"),
    canClear: hasAction(node, "clear_goal"),
  };
}

export function mapLlmNode(node: SlopNode | null | undefined): LlmState {
  const p = props(node);
  return {
    status: llmStatusProp(stringProp(p, "status", "unknown")),
    message: stringProp(p, "message", ""),
    activeProfileId: optionalStringProp(p, "active_profile_id"),
    selectedProvider: optionalStringProp(p, "selected_provider"),
    selectedModel: optionalStringProp(p, "selected_model"),
    selectedContextWindowTokens: progressProp(p, "selected_context_window_tokens"),
    secureStoreKind: optionalStringProp(p, "secure_store_kind"),
    secureStoreStatus: optionalStringProp(p, "secure_store_status"),
    actions: node?.affordances?.map((affordance) => affordance.action) ?? [],
    profiles: children(node).map(mapLlmProfileNode),
  };
}

export function mapUsageNode(node: SlopNode | null | undefined): UsageState {
  const p = props(node);
  return {
    lastTurnId: optionalStringProp(p, "last_turn_id"),
    lastModelCallInputTokens: progressProp(p, "last_model_call_input_tokens"),
    lastModelCallOutputTokens: progressProp(p, "last_model_call_output_tokens"),
    lastModelCallThinkingTokens: progressProp(p, "last_model_call_thinking_tokens"),
    lastModelCallInputSource: stringProp(p, "last_model_call_input_source", "unavailable"),
    lastModelCallOutputSource: stringProp(p, "last_model_call_output_source", "unavailable"),
    lastModelCallThinkingSource: stringProp(p, "last_model_call_thinking_source", "unavailable"),
    currentTurnInputTokens: progressProp(p, "current_turn_input_tokens"),
    currentTurnOutputTokens: progressProp(p, "current_turn_output_tokens"),
    currentTurnThinkingTokens: progressProp(p, "current_turn_thinking_tokens"),
    currentTurnModelCalls: numberProp(p, "current_turn_model_calls"),
    totalInputTokens: progressProp(p, "total_input_tokens"),
    totalOutputTokens: progressProp(p, "total_output_tokens"),
    totalThinkingTokens: progressProp(p, "total_thinking_tokens"),
    totalTokens: progressProp(p, "total_tokens"),
    lastStateContextTokens: progressProp(p, "last_state_context_tokens"),
    lastStateContextTokenSource: stringProp(p, "last_state_context_token_source", "unavailable"),
    modelContextWindowTokens: progressProp(p, "model_context_window_tokens"),
    availableContextTokens: progressProp(p, "available_context_tokens"),
    updatedAt: optionalStringProp(p, "updated_at"),
  };
}

function mapLlmProfileNode(node: SlopNode): LlmProfile {
  const p = props(node);
  return {
    id: node.id,
    label: optionalStringProp(p, "label"),
    provider: stringProp(p, "provider", "unknown"),
    model: stringProp(p, "model", "unknown"),
    reasoningEffort: optionalStringProp(p, "reasoning_effort"),
    thinkingEnabled: booleanProp(p, "thinking_enabled"),
    thinkingDisplay: stringProp(p, "thinking_display") === "hidden" ? "hidden" : "visible",
    thinkingEffectiveEnabled: booleanProp(p, "thinking_effective_enabled"),
    thinkingEffectiveReason: optionalStringProp(p, "thinking_effective_reason"),
    thinkingEffort: optionalStringProp(p, "thinking_effort"),
    adapterId: optionalStringProp(p, "adapter_id"),
    origin: stringProp(p, "origin", "unknown"),
    isDefault: booleanProp(p, "is_default"),
    hasKey: booleanProp(p, "has_key"),
    keySource: stringProp(p, "key_source", "unknown"),
    ready: booleanProp(p, "ready"),
    managed: booleanProp(p, "managed"),
    baseUrl: optionalStringProp(p, "base_url"),
    apiKeyEnv: optionalStringProp(p, "api_key_env"),
    contextWindowTokens: progressProp(p, "context_window_tokens"),
    canDeleteProfile: booleanProp(p, "can_delete_profile"),
    canDeleteApiKey: booleanProp(p, "can_delete_api_key"),
  };
}

export function mapTurnNode(node: SlopNode | null | undefined): TurnState {
  const p = props(node);
  return {
    turnId: nullableStringProp(p, "turn_id"),
    state: turnStateProp(stringProp(p, "state", "unknown")),
    phase: stringProp(p, "phase", "none"),
    iteration: numberProp(p, "iteration"),
    message: stringProp(p, "message", ""),
    waitingOn: nullableStringProp(p, "waiting_on"),
    startedAt: nullableStringProp(p, "started_at"),
    updatedAt: optionalStringProp(p, "updated_at"),
    lastError: optionalStringProp(p, "last_error"),
    canCancel: hasAction(node, "cancel_turn"),
  };
}

export function mapComposerNode(node: SlopNode | null | undefined): ComposerState {
  const p = props(node);
  return {
    ready: booleanProp(p, "ready"),
    acceptsAttachments: booleanProp(p, "accepts_attachments"),
    maxAttachments: numberProp(p, "max_attachments"),
    disabledReason: optionalStringProp(p, "disabled_reason"),
    canSend: hasAction(node, "send_message"),
  };
}

export function mapTranscriptNode(node: SlopNode | null | undefined): TranscriptMessage[] {
  return children(node).map((message) => {
    const p = props(message);
    const contentNode = children(message).find((child) => child.id === "content");
    return {
      id: message.id,
      seq: numberProp(p, "seq"),
      role: roleProp(stringProp(p, "role", "unknown")),
      state: stringProp(p, "state", "unknown"),
      turnId: nullableStringProp(p, "turn_id"),
      author: optionalStringProp(p, "author"),
      createdAt: optionalStringProp(p, "created_at"),
      error: optionalStringProp(p, "error"),
      blocks: children(contentNode).map(mapTranscriptBlockNode),
    };
  });
}

function mapTranscriptBlockNode(node: SlopNode): TranscriptBlock {
  const p = props(node);
  if (node.type === "media") {
    return {
      id: node.id,
      type: "media",
      mime: optionalStringProp(p, "mime"),
      name: optionalStringProp(p, "name"),
      uri: optionalStringProp(p, "uri"),
      summary: optionalStringProp(p, "summary"),
      preview: optionalStringProp(p, "preview"),
    };
  }

  if (stringProp(p, "kind") === "thinking_output") {
    return {
      id: node.id,
      type: "thinking",
      mime: optionalStringProp(p, "mime"),
      text: stringProp(p, "text"),
      format: stringProp(p, "format") === "raw" ? "raw" : "summary",
      display: stringProp(p, "display") === "hidden" ? "hidden" : "visible",
      provider: optionalStringProp(p, "provider"),
      model: optionalStringProp(p, "model"),
      startedAt: optionalStringProp(p, "started_at"),
      completedAt: optionalStringProp(p, "completed_at"),
      elapsedMs: progressProp(p, "elapsed_ms"),
      tokenCount: progressProp(p, "token_count"),
      tokenCountSource: optionalStringProp(p, "token_count_source"),
    };
  }

  return {
    id: node.id,
    type: "text",
    mime: optionalStringProp(p, "mime"),
    text: stringProp(p, "text"),
  };
}

export function mapActivityNode(node: SlopNode | null | undefined): ActivityItem[] {
  return children(node).map((item) => {
    const p = props(item);
    return {
      id: item.id,
      seq: numberProp(p, "seq"),
      kind: stringProp(p, "kind", "unknown"),
      status: stringProp(p, "status", "unknown"),
      summary: stringProp(p, "summary", item.meta?.summary ?? ""),
      provider: optionalStringProp(p, "provider"),
      path: optionalStringProp(p, "path"),
      action: optionalStringProp(p, "action"),
      label: optionalStringProp(p, "label"),
      turnId: optionalStringProp(p, "turn_id"),
      taskId: optionalStringProp(p, "task_id"),
      approvalId: optionalStringProp(p, "approval_id"),
      toolUseId: optionalStringProp(p, "tool_use_id"),
      paramsPreview: optionalStringProp(p, "params_preview"),
      errorMessage: optionalStringProp(p, "error_message"),
      result: toolCallResultProp(p, "result"),
      startedAt: optionalStringProp(p, "started_at"),
      updatedAt: optionalStringProp(p, "updated_at"),
      completedAt: optionalStringProp(p, "completed_at"),
    };
  });
}

export function mapApprovalsNode(node: SlopNode | null | undefined): ApprovalItem[] {
  return children(node).map((item) => {
    const p = props(item);
    return {
      id: item.id,
      status: stringProp(p, "status", "unknown"),
      provider: stringProp(p, "provider", "unknown"),
      path: stringProp(p, "path", "/"),
      action: stringProp(p, "action", "unknown"),
      reason: stringProp(p, "reason", item.meta?.summary ?? ""),
      paramsPreview: optionalStringProp(p, "params_preview"),
      dangerous: booleanProp(p, "dangerous"),
      canApprove: hasAction(item, "approve"),
      canReject: hasAction(item, "reject"),
      createdAt: optionalStringProp(p, "created_at"),
      resolvedAt: optionalStringProp(p, "resolved_at"),
    };
  });
}

export function mapTasksNode(node: SlopNode | null | undefined): TaskItem[] {
  return children(node).map((item) => {
    const p = props(item);
    return {
      id: item.id,
      status: stringProp(p, "status", "unknown"),
      provider: stringProp(p, "provider", "unknown"),
      providerTaskId: stringProp(p, "provider_task_id", item.id),
      message: stringProp(p, "message", item.meta?.summary ?? ""),
      progress: progressProp(p, "progress"),
      linkedActivityId: optionalStringProp(p, "linked_activity_id"),
      error: optionalStringProp(p, "error"),
      canCancel: hasAction(item, "cancel"),
      startedAt: optionalStringProp(p, "started_at"),
      updatedAt: optionalStringProp(p, "updated_at"),
    };
  });
}

export function mapQueueNode(node: SlopNode | null | undefined): QueuedItem[] {
  return children(node).map((item, index) => {
    const p = props(item);
    return {
      id: item.id,
      text: stringProp(p, "text", ""),
      status: stringProp(p, "status", "queued"),
      position: numberProp(p, "position", index + 1),
      summary: stringProp(p, "summary", item.meta?.summary ?? ""),
      author: optionalStringProp(p, "author"),
      createdAt: optionalStringProp(p, "created_at"),
      canCancel: hasAction(item, "cancel"),
    };
  });
}

export function mapAppsNode(node: SlopNode | null | undefined): AppItem[] {
  return children(node).map((item) => {
    const p = props(item);
    return {
      id: item.id,
      providerId: optionalStringProp(p, "provider_id"),
      name: stringProp(p, "name", item.id),
      transport: stringProp(p, "transport", "unknown"),
      status: stringProp(p, "status", "unknown"),
      lastError: optionalStringProp(p, "last_error"),
    };
  });
}

function mapPluginUiManifest(value: Record<string, unknown>): PluginUiManifest {
  return {
    subscriptions: recordArray(value.subscriptions)
      .map((entry) => ({
        path: optionalStringProp(entry, "path") ?? "",
        depth: numberProp(entry, "depth", 1),
      }))
      .filter((entry) => entry.path.startsWith("/")),
    actions: recordArray(value.actions).flatMap((entry): PluginActionContribution[] => {
      const id = optionalStringProp(entry, "id");
      const label = optionalStringProp(entry, "label");
      const description = optionalStringProp(entry, "description");
      const invoke = optionalRecordProp(entry, "invoke");
      const path = invoke ? optionalStringProp(invoke, "path") : undefined;
      const action = invoke ? optionalStringProp(invoke, "action") : undefined;
      if (!id || !label || !description || !path?.startsWith("/") || !action) {
        return [];
      }
      return [
        {
          id,
          label,
          description,
          invoke: {
            path,
            action,
            params: invoke ? optionalRecordProp(invoke, "params") : undefined,
          },
          whenAvailable: optionalStringProp(entry, "whenAvailable"),
          argument: optionalRecordProp(entry, "argument") as
            | PluginActionContribution["argument"]
            | undefined,
          presentation: optionalRecordProp(entry, "presentation"),
        },
      ];
    }),
    indicators: recordArray(value.indicators).flatMap((entry): PluginIndicatorContribution[] => {
      const id = optionalStringProp(entry, "id");
      const path = optionalStringProp(entry, "path");
      const template = optionalStringProp(entry, "template");
      if (!id || !path?.startsWith("/") || !template) {
        return [];
      }
      return [
        {
          id,
          path,
          depth: numberProp(entry, "depth", 1),
          template,
          fields: optionalRecordProp(entry, "fields") as PluginIndicatorContribution["fields"],
          visibleWhen: optionalRecordProp(entry, "visibleWhen") as
            | PluginIndicatorContribution["visibleWhen"]
            | undefined,
          severity: optionalRecordProp(entry, "severity") as
            | PluginIndicatorContribution["severity"]
            | undefined,
        },
      ];
    }),
    notifications: recordArray(value.notifications).flatMap(
      (entry): PluginNotificationContribution[] => {
        const id = optionalStringProp(entry, "id");
        const source = optionalRecordProp(entry, "source");
        const path = source ? optionalStringProp(source, "path") : undefined;
        const prop = source ? optionalStringProp(source, "prop") : undefined;
        const to = optionalStringProp(entry, "to");
        const message = optionalStringProp(entry, "message");
        if (!id || !path?.startsWith("/") || !prop || to === undefined || !message) {
          return [];
        }
        return [{ id, source: { path, prop }, to, message }];
      },
    ),
  };
}

export function mapPluginsNode(node: SlopNode | null | undefined): PluginItem[] {
  return children(node).map((item) => {
    const p = props(item);
    return {
      id: stringProp(p, "id", item.id),
      version: stringProp(p, "version", "0.0.0"),
      status: stringProp(p, "status", "unknown"),
      description: optionalStringProp(p, "description"),
      sessionPaths: stringArrayProp(p, "session_paths"),
      ui: mapPluginUiManifest(recordProp(p, "ui")),
    };
  });
}

export function applyPathSnapshot(
  snapshot: SessionViewSnapshot,
  path: string,
  node: SlopNode,
): SessionViewSnapshot {
  const withActions = <T extends SessionViewSnapshot>(next: T): T => ({
    ...next,
    actionsByPath: {
      ...snapshot.actionsByPath,
      [path]: node.affordances?.map((affordance) => affordance.action) ?? [],
    },
  });

  switch (path) {
    case "/session":
      return withActions({ ...snapshot, session: mapSessionNode(node) });
    case "/llm":
      return withActions({ ...snapshot, llm: mapLlmNode(node) });
    case "/usage":
      return withActions({ ...snapshot, usage: mapUsageNode(node) });
    case "/turn":
      return withActions({ ...snapshot, turn: mapTurnNode(node) });
    case "/goal":
      return withActions({ ...snapshot, goal: mapGoalNode(node) });
    case "/composer":
      return withActions({ ...snapshot, composer: mapComposerNode(node) });
    case "/transcript":
      return withActions({ ...snapshot, transcript: mapTranscriptNode(node) });
    case "/activity":
      return withActions({ ...snapshot, activity: mapActivityNode(node) });
    case "/approvals":
      return withActions({ ...snapshot, approvals: mapApprovalsNode(node) });
    case "/tasks":
      return withActions({ ...snapshot, tasks: mapTasksNode(node) });
    case "/apps":
      return withActions({ ...snapshot, apps: mapAppsNode(node) });
    case "/plugins":
      return withActions({ ...snapshot, plugins: mapPluginsNode(node) });
    case "/queue":
      return withActions({ ...snapshot, queue: mapQueueNode(node) });
    default:
      return withActions(snapshot);
  }
}

export function withConnectionState(
  snapshot: SessionViewSnapshot,
  connection: Partial<SessionViewSnapshot["connection"]>,
): SessionViewSnapshot {
  return {
    ...snapshot,
    connection: {
      ...snapshot.connection,
      ...connection,
    },
  };
}

export function withInspectTree(
  snapshot: SessionViewSnapshot,
  inspect: Partial<InspectState>,
): SessionViewSnapshot {
  return {
    ...snapshot,
    inspect: {
      ...snapshot.inspect,
      ...inspect,
    },
  };
}

export function withInspectResult(
  snapshot: SessionViewSnapshot,
  result: ResultMessage,
): SessionViewSnapshot {
  return withInspectTree(snapshot, {
    result,
    error: result.status === "error" ? result.error?.message : undefined,
  });
}

export function findRootChild(node: SlopNode, id: string): SlopNode | null {
  return node.children?.find((child) => child.id === id) ?? null;
}

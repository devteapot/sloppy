import type { ResultMessage, SlopNode } from "@slop-ai/consumer";

import type {
  ActivityItem,
  AppItem,
  ApprovalItem,
  ComposerState,
  InspectState,
  LlmProfile,
  LlmState,
  QueuedItem,
  SessionMeta,
  SessionViewSnapshot,
  TaskItem,
  TranscriptBlock,
  TranscriptMessage,
  TurnState,
} from "./types";

const EMPTY_INSPECT: InspectState = {
  targetId: "session",
  targetName: "Session",
  path: "/",
  depth: 2,
  tree: null,
  result: null,
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
  turn: {
    turnId: null,
    state: "unknown",
    phase: "none",
    iteration: 0,
    message: "Not connected.",
    waitingOn: null,
    canCancel: false,
  },
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
  queue: [],
  inspect: EMPTY_INSPECT,
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
    modelProvider: optionalStringProp(p, "model_provider"),
    model: optionalStringProp(p, "model"),
    startedAt: optionalStringProp(p, "started_at"),
    updatedAt: optionalStringProp(p, "updated_at"),
    clientCount: progressProp(p, "client_count"),
    lastError: optionalStringProp(p, "last_error"),
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
    secureStoreKind: optionalStringProp(p, "secure_store_kind"),
    secureStoreStatus: optionalStringProp(p, "secure_store_status"),
    actions: node?.affordances?.map((affordance) => affordance.action) ?? [],
    profiles: children(node).map(mapLlmProfileNode),
  };
}

function mapLlmProfileNode(node: SlopNode): LlmProfile {
  const p = props(node);
  return {
    id: node.id,
    label: optionalStringProp(p, "label"),
    provider: stringProp(p, "provider", "unknown"),
    model: stringProp(p, "model", "unknown"),
    adapterId: optionalStringProp(p, "adapter_id"),
    origin: stringProp(p, "origin", "unknown"),
    isDefault: booleanProp(p, "is_default"),
    hasKey: booleanProp(p, "has_key"),
    keySource: stringProp(p, "key_source", "unknown"),
    ready: booleanProp(p, "ready"),
    managed: booleanProp(p, "managed"),
    baseUrl: optionalStringProp(p, "base_url"),
    apiKeyEnv: optionalStringProp(p, "api_key_env"),
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
      kind: stringProp(p, "kind", "unknown"),
      status: stringProp(p, "status", "unknown"),
      summary: stringProp(p, "summary", item.meta?.summary ?? ""),
      provider: optionalStringProp(p, "provider"),
      path: optionalStringProp(p, "path"),
      action: optionalStringProp(p, "action"),
      turnId: optionalStringProp(p, "turn_id"),
      taskId: optionalStringProp(p, "task_id"),
      approvalId: optionalStringProp(p, "approval_id"),
      toolUseId: optionalStringProp(p, "tool_use_id"),
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

export function applyPathSnapshot(
  snapshot: SessionViewSnapshot,
  path: string,
  node: SlopNode,
): SessionViewSnapshot {
  switch (path) {
    case "/session":
      return { ...snapshot, session: mapSessionNode(node) };
    case "/llm":
      return { ...snapshot, llm: mapLlmNode(node) };
    case "/turn":
      return { ...snapshot, turn: mapTurnNode(node) };
    case "/composer":
      return { ...snapshot, composer: mapComposerNode(node) };
    case "/transcript":
      return { ...snapshot, transcript: mapTranscriptNode(node) };
    case "/activity":
      return { ...snapshot, activity: mapActivityNode(node) };
    case "/approvals":
      return { ...snapshot, approvals: mapApprovalsNode(node) };
    case "/tasks":
      return { ...snapshot, tasks: mapTasksNode(node) };
    case "/apps":
      return { ...snapshot, apps: mapAppsNode(node) };
    case "/queue":
      return { ...snapshot, queue: mapQueueNode(node) };
    default:
      return snapshot;
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

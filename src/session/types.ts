export type AgentSessionStatus = "active" | "closing" | "closed" | "error";

export type AgentTurnState = "idle" | "running" | "waiting_approval" | "error";

export type AgentTurnPhase = "none" | "model" | "tool_use" | "awaiting_result" | "complete";

export type TranscriptMessageRole = "user" | "assistant" | "system";

export type TranscriptMessageState = "complete" | "streaming" | "error";

export type TranscriptTextBlock = {
  id: string;
  type: "text";
  mime: string;
  text: string;
};

export type TranscriptMediaBlock = {
  id: string;
  type: "media";
  mime: string;
  name?: string;
  uri?: string;
  summary?: string;
  preview?: string;
};

export type TranscriptThinkingBlock = {
  id: string;
  type: "thinking";
  mime: "text/plain";
  text: string;
  format: "raw" | "summary";
  display: "visible" | "hidden";
  provider?: string;
  model?: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  tokenCount?: number;
  tokenCountSource?: "reported" | "unavailable";
};

export type TranscriptContentBlock =
  | TranscriptTextBlock
  | TranscriptMediaBlock
  | TranscriptThinkingBlock;

export type TranscriptMessage = {
  id: string;
  seq: number;
  role: TranscriptMessageRole;
  state: TranscriptMessageState;
  turnId: string | null;
  createdAt: string;
  author?: string;
  error?: string;
  content: TranscriptContentBlock[];
};

export type QueuedSessionMessage = {
  id: string;
  status: "queued";
  text: string;
  createdAt: string;
  author: string;
  source?: "user" | "plugin";
  pluginId?: string;
  pluginRunId?: string;
  goalId?: string;
  continuation?: boolean;
};

export type SessionGoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type SessionGoalUpdateSource = "user" | "model" | "runtime";

export type SessionGoalSnapshot = {
  goalId: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  tokenBudget?: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  totalTokens: number;
  elapsedMs: number;
  continuationCount: number;
  lastTurnId?: string;
  message?: string;
  evidence?: string[];
  updateSource?: SessionGoalUpdateSource;
  completionSource?: SessionGoalUpdateSource;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ToolCallResult = {
  kind?: string;
  data?: JsonValue;
  truncated?: boolean;
};

export type SessionExtensionLifecycle = "active" | "completed" | "orphaned";

export type SessionExtensionCleanupPolicy = {
  mode: "manual" | "ttl";
  ttlMs?: number;
  description?: string;
};

export type SessionExtensionOwner = {
  kind: "skill" | "runtime";
  id: string;
  version?: string;
};

export type SessionExtensionRecord = {
  namespace: string;
  instanceId: string;
  schemaVersion: number;
  revision: number;
  owner: SessionExtensionOwner;
  state: JsonObject;
  lifecycle: SessionExtensionLifecycle;
  cleanupPolicy?: SessionExtensionCleanupPolicy;
  retainUntil?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
};

export type ActivityKind =
  | "model_call"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "task"
  | "error";

export type ActivityStatus = "running" | "ok" | "error" | "accepted" | "cancelled";

export type ActivityItem = {
  id: string;
  seq: number;
  kind: ActivityKind;
  status: ActivityStatus;
  summary: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  turnId?: string;
  provider?: string;
  path?: string;
  action?: string;
  label?: string;
  approvalId?: string;
  taskId?: string;
  toolUseId?: string;
  paramsPreview?: string;
  errorMessage?: string;
  result?: ToolCallResult;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalItem = {
  id: string;
  status: ApprovalStatus;
  provider: string;
  path: string;
  action: string;
  reason: string;
  createdAt: string;
  resolvedAt?: string;
  paramsPreview?: string;
  dangerous?: boolean;
  sourceApprovalId?: string;
  sourcePath?: string;
  mirrorLineage?: string[];
  canApprove?: boolean;
  canReject?: boolean;
  turnId?: string;
};

export type SessionTaskStatus = "running" | "completed" | "failed" | "cancelled" | "superseded";

export type SessionTask = {
  id: string;
  status: SessionTaskStatus;
  provider: string;
  providerTaskId: string;
  startedAt: string;
  updatedAt: string;
  message: string;
  progress?: number;
  linkedActivityId?: string;
  error?: string;
  sourceTaskId?: string;
  sourcePath?: string;
  mirrorLineage?: string[];
  canCancel?: boolean;
  turnId?: string;
};

export type ExternalAppStatus = "connected" | "disconnected" | "error";

export type ExternalAppSnapshot = {
  id: string;
  name: string;
  transport: string;
  status: ExternalAppStatus;
  lastError?: string;
};

export type LlmKeySource = "env" | "secure_store" | "missing" | "not_required" | "external_auth";
export type LlmProfileOrigin = "managed" | "environment" | "fallback";

export type LlmSecureStoreStatus = "available" | "unavailable" | "unsupported";

export type LlmProfileSnapshot = {
  id: string;
  label?: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingDisplay?: "visible" | "hidden";
  thinkingEffectiveEnabled?: boolean;
  thinkingEffectiveReason?: string;
  thinkingEffort?: string;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  isDefault: boolean;
  hasKey: boolean;
  keySource: LlmKeySource;
  ready: boolean;
  managed: boolean;
  origin: LlmProfileOrigin;
  canDeleteProfile: boolean;
  canDeleteApiKey: boolean;
};

export type TokenAccountingSource = "reported" | "provider" | "local" | "unavailable";

export type SessionUsageSnapshot = {
  lastTurnId?: string;
  lastModelCallInputTokens?: number;
  lastModelCallOutputTokens?: number;
  lastModelCallThinkingTokens?: number;
  lastModelCallInputSource: TokenAccountingSource;
  lastModelCallOutputSource: TokenAccountingSource;
  lastModelCallThinkingSource: TokenAccountingSource;
  currentTurnInputTokens?: number;
  currentTurnOutputTokens?: number;
  currentTurnThinkingTokens?: number;
  currentTurnModelCalls: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalThinkingTokens?: number;
  lastStateContextTokens?: number;
  lastStateContextTokenSource: TokenAccountingSource;
  modelContextWindowTokens?: number;
  availableContextTokens?: number;
  updatedAt?: string;
};

export type LlmStateSnapshot = {
  status: "ready" | "needs_credentials";
  message: string;
  activeProfileId: string;
  selectedProvider: string;
  selectedModel: string;
  selectedContextWindowTokens?: number;
  secureStoreKind: string;
  secureStoreStatus: LlmSecureStoreStatus;
  profiles: LlmProfileSnapshot[];
};

export type ConnectedClient = {
  clientId: string;
  connectedAt: string;
};

export type SessionMetadata = {
  sessionId: string;
  status: AgentSessionStatus;
  modelProvider: string;
  model: string;
  startedAt: string;
  updatedAt: string;
  lastActivityAt: string;
  clientCount: number;
  connectedClients: ConnectedClient[];
  title?: string;
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  lastError?: string;
  configRequiresRestart?: boolean;
  configRestartReason?: string;
  persistencePath?: string;
  restoredAt?: string;
  recoveredAfterRestart?: boolean;
  maxResolvedApprovals?: number;
  maxResolvedTasks?: number;
};

export type TurnStateSnapshot = {
  turnId: string | null;
  state: AgentTurnState;
  phase: AgentTurnPhase;
  iteration: number;
  startedAt: string | null;
  updatedAt: string;
  message: string;
  lastError?: string;
  waitingOn?: "approval" | "task" | "model" | "tool" | null;
};

export type AgentSessionSnapshot = {
  session: SessionMetadata;
  llm: LlmStateSnapshot;
  usage: SessionUsageSnapshot;
  turn: TurnStateSnapshot;
  goal: SessionGoalSnapshot | null;
  extensions: Record<string, SessionExtensionRecord>;
  queue: QueuedSessionMessage[];
  transcript: TranscriptMessage[];
  activity: ActivityItem[];
  approvals: ApprovalItem[];
  tasks: SessionTask[];
  apps: ExternalAppSnapshot[];
};

export type SessionStoreEventType =
  | "turn"
  | "transcript"
  | "activity"
  | "approvals"
  | "tasks"
  | "apps"
  | "llm"
  | "usage"
  | "session"
  | "goal"
  | "extensions"
  | "queue";

export type SessionStoreGranularListener = (event: {
  type: SessionStoreEventType;
  snapshot: AgentSessionSnapshot;
}) => void;

export type SessionStoreChangeListener = (snapshot: AgentSessionSnapshot) => void;

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

export type TranscriptContentBlock = TranscriptTextBlock | TranscriptMediaBlock;

export type TranscriptMessage = {
  id: string;
  role: TranscriptMessageRole;
  state: TranscriptMessageState;
  turnId: string | null;
  createdAt: string;
  author?: string;
  error?: string;
  content: TranscriptContentBlock[];
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
  approvalId?: string;
  taskId?: string;
  toolUseId?: string;
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

export type LlmKeySource = "env" | "secure_store" | "missing" | "not_required";
export type LlmProfileOrigin = "managed" | "environment" | "fallback";

export type LlmSecureStoreStatus = "available" | "unavailable" | "unsupported";

export type LlmProfileSnapshot = {
  id: string;
  label?: string;
  provider: string;
  model: string;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  isDefault: boolean;
  hasKey: boolean;
  keySource: LlmKeySource;
  ready: boolean;
  managed: boolean;
  origin: LlmProfileOrigin;
  canDeleteProfile: boolean;
  canDeleteApiKey: boolean;
};

export type LlmStateSnapshot = {
  status: "ready" | "needs_credentials";
  message: string;
  activeProfileId: string;
  selectedProvider: string;
  selectedModel: string;
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
  lastError?: string;
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
  turn: TurnStateSnapshot;
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
  | "session";

export type SessionStoreGranularListener = (event: {
  type: SessionStoreEventType;
  snapshot: AgentSessionSnapshot;
}) => void;

export type SessionStoreChangeListener = (snapshot: AgentSessionSnapshot) => void;

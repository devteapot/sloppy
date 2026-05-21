import type { Affordance, ResultMessage, SlopNode } from "@slop-ai/consumer";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type TuiRoute =
  | "chat"
  | "setup"
  | "approvals"
  | "tasks"
  | "apps"
  | "inspect"
  | "runtime"
  | "settings";

export type InspectorMode = "activity" | "approvals" | "tasks" | "apps" | "state";

export type SessionMeta = {
  sessionId: string | null;
  status: string;
  title?: string;
  workspaceRoot?: string;
  workspaceId?: string;
  projectId?: string;
  modelProvider?: string;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
  clientCount?: number;
  lastError?: string;
};

export type LlmProfile = {
  id: string;
  label?: string;
  provider: string;
  model: string;
  adapterId?: string;
  origin: string;
  isDefault: boolean;
  hasKey: boolean;
  keySource: string;
  ready: boolean;
  managed: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  canDeleteProfile: boolean;
  canDeleteApiKey: boolean;
};

export type UsageState = {
  lastTurnId?: string;
  lastModelCallInputTokens?: number;
  lastModelCallOutputTokens?: number;
  lastModelCallInputSource: string;
  lastModelCallOutputSource: string;
  currentTurnInputTokens?: number;
  currentTurnOutputTokens?: number;
  currentTurnModelCalls: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  lastStateContextTokens?: number;
  lastStateContextTokenSource: string;
  modelContextWindowTokens?: number;
  availableContextTokens?: number;
  updatedAt?: string;
};

export type LlmState = {
  status: "ready" | "needs_credentials" | "unknown";
  message: string;
  activeProfileId?: string;
  selectedProvider?: string;
  selectedModel?: string;
  selectedContextWindowTokens?: number;
  secureStoreKind?: string;
  secureStoreStatus?: string;
  profiles: LlmProfile[];
  actions: string[];
};

export type TurnState = {
  turnId: string | null;
  state: "idle" | "running" | "waiting_approval" | "error" | "unknown";
  phase: string;
  iteration: number;
  message: string;
  waitingOn: string | null;
  startedAt?: string | null;
  updatedAt?: string;
  lastError?: string;
  canCancel: boolean;
};

export type GoalState = {
  exists: boolean;
  goalId?: string;
  objective?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  tokenBudget?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  elapsedMs: number;
  continuationCount: number;
  lastTurnId?: string;
  message?: string;
  evidence: string[];
  updateSource?: string;
  completionSource?: string;
  canCreate: boolean;
  canPause: boolean;
  canResume: boolean;
  canComplete: boolean;
  canClear: boolean;
};

export type ComposerState = {
  ready: boolean;
  acceptsAttachments: boolean;
  maxAttachments: number;
  disabledReason?: string;
  canSend: boolean;
};

export type TranscriptBlock = {
  id: string;
  type: "text" | "media";
  mime?: string;
  text?: string;
  name?: string;
  uri?: string;
  summary?: string;
  preview?: string;
};

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "unknown";
  state: string;
  turnId: string | null;
  author?: string;
  createdAt?: string;
  error?: string;
  blocks: TranscriptBlock[];
};

export type ActivityItem = {
  id: string;
  kind: string;
  status: string;
  summary: string;
  provider?: string;
  path?: string;
  action?: string;
  turnId?: string;
  taskId?: string;
  approvalId?: string;
  toolUseId?: string;
  paramsPreview?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
};

export type ApprovalItem = {
  id: string;
  status: string;
  provider: string;
  path: string;
  action: string;
  reason: string;
  paramsPreview?: string;
  dangerous: boolean;
  canApprove: boolean;
  canReject: boolean;
  createdAt?: string;
  resolvedAt?: string;
};

export type TaskItem = {
  id: string;
  status: string;
  provider: string;
  providerTaskId: string;
  message: string;
  progress?: number;
  linkedActivityId?: string;
  error?: string;
  canCancel: boolean;
  startedAt?: string;
  updatedAt?: string;
};

export type QueuedItem = {
  id: string;
  text: string;
  status: string;
  position: number;
  summary: string;
  author?: string;
  createdAt?: string;
  canCancel: boolean;
};

export type AppItem = {
  id: string;
  name: string;
  providerId?: string;
  transport: string;
  status: string;
  lastError?: string;
};

export type PluginNotificationContribution = {
  id: string;
  source: {
    path: string;
    prop: string;
  };
  to: string;
  message: string;
};

export type PluginActionContribution = {
  id: string;
  label: string;
  description: string;
  invoke: {
    path: string;
    action: string;
    params?: Record<string, unknown>;
  };
  whenAvailable?: string;
  argument?: {
    name: string;
    description?: string;
    required?: boolean;
    param?: string;
  };
  presentation?: Record<string, unknown>;
};

export type PluginIndicatorContribution = {
  id: string;
  path: string;
  depth?: number;
  template: string;
  fields?: Record<string, { format: "text" | "number" | "duration" | "percent" | "bytes" }>;
  visibleWhen?: {
    prop: string;
    equals?: unknown;
  };
  severity?: {
    prop: string;
    map: Record<string, string>;
  };
};

export type PluginUiManifest = {
  subscriptions?: Array<{ path: string; depth: number }>;
  actions?: PluginActionContribution[];
  notifications?: PluginNotificationContribution[];
  indicators?: PluginIndicatorContribution[];
};

export type PluginItem = {
  id: string;
  version: string;
  status: string;
  description?: string;
  sessionPaths: string[];
  ui: PluginUiManifest;
};

export type InspectState = {
  targetId: string;
  targetName: string;
  targetTransport?: string;
  path: string;
  depth: number;
  window?: [number, number];
  maxNodes?: number;
  tree: SlopNode | null;
  result: ResultMessage | null;
  error?: string;
};

export type InspectQueryOptions = {
  window?: [number, number];
  maxNodes?: number;
};

export type SessionViewSnapshot = {
  connection: {
    status: ConnectionStatus;
    socketPath?: string;
    providerId?: string;
    providerName?: string;
    error?: string;
  };
  session: SessionMeta;
  llm: LlmState;
  usage: UsageState;
  turn: TurnState;
  goal: GoalState;
  composer: ComposerState;
  transcript: TranscriptMessage[];
  activity: ActivityItem[];
  approvals: ApprovalItem[];
  tasks: TaskItem[];
  apps: AppItem[];
  plugins: PluginItem[];
  queue: QueuedItem[];
  inspect: InspectState;
  actionsByPath: Record<string, string[]>;
};

export type SaveProfileInput = {
  profileId?: string;
  label?: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  adapterId?: string;
  baseUrl?: string;
  apiKey?: string;
  makeDefault?: boolean;
};

export type CreateGoalInput = {
  objective: string;
  tokenBudget?: number;
};

export type SessionClientEvent =
  | { type: "snapshot"; snapshot: SessionViewSnapshot }
  | { type: "result"; result: ResultMessage }
  | { type: "error"; message: string };

export type SessionClientListener = (event: SessionClientEvent) => void;

export type NodeWithAffordances = SlopNode & {
  affordances?: Affordance[];
};

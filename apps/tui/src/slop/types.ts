import type { Affordance, ResultMessage, SlopNode } from "@slop-ai/consumer";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type TuiRoute = "chat" | "setup" | "approvals" | "tasks" | "apps" | "inspect" | "settings";

export type InspectorMode = "activity" | "approvals" | "tasks" | "apps" | "state";

export type SessionMeta = {
  sessionId: string | null;
  status: string;
  title?: string;
  workspaceRoot?: string;
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
  canDeleteProfile: boolean;
  canDeleteApiKey: boolean;
};

export type LlmState = {
  status: "ready" | "needs_credentials" | "unknown";
  message: string;
  activeProfileId?: string;
  selectedProvider?: string;
  selectedModel?: string;
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
  turn: TurnState;
  composer: ComposerState;
  transcript: TranscriptMessage[];
  activity: ActivityItem[];
  approvals: ApprovalItem[];
  tasks: TaskItem[];
  apps: AppItem[];
  queue: QueuedItem[];
  inspect: InspectState;
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

export type SessionClientEvent =
  | { type: "snapshot"; snapshot: SessionViewSnapshot }
  | { type: "result"; result: ResultMessage }
  | { type: "error"; message: string };

export type SessionClientListener = (event: SessionClientEvent) => void;

export type NodeWithAffordances = SlopNode & {
  affordances?: Affordance[];
};

export type PlanStatus = "active" | "completed" | "cancelled" | "none";

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "unknown";

export type HandoffStatus = "pending" | "responded" | "cancelled";

export type DashboardPlan = {
  id?: string;
  sessionId: string;
  query: string;
  strategy: string;
  status: PlanStatus;
  maxAgents: number;
  createdAt: string;
  version: number;
};

export type DashboardTask = {
  id: string;
  planId?: string;
  name: string;
  goal: string;
  status: TaskStatus;
  dependsOn: string[];
  unmetDependencies: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  iteration: number;
  version: number;
  progressPreview: string;
  resultPreview?: string;
  error?: string;
  supersededBy?: string;
};

export type DashboardHandoff = {
  id: string;
  planId?: string;
  fromTask: string;
  toTask: string;
  request: string;
  status: HandoffStatus;
  createdAt: string;
  responsePreview?: string;
  version: number;
};

export type FlowEvent = {
  id: string;
  toolUseId?: string;
  ts: string;
  lane: "model" | "tool" | "provider" | "state" | "agent" | "data" | "error";
  scope: string;
  event: string;
  title: string;
  summary: string;
  status?: string;
  providerId?: string;
  path?: string;
  action?: string;
  taskId?: string;
  agentId?: string;
  actorId?: string;
  actorName?: string;
  actorKind?: "orchestrator" | "agent";
  actorParentId?: string;
  actorTaskId?: string;
  toolName?: string;
  fileOperation?: "read" | "write" | "mkdir" | "search" | "focus";
  filePath?: string;
  dataPreview?: string;
  fromTask?: string;
  toTask?: string;
};

export type DashboardState = {
  mode: "live" | "empty";
  source: string;
  updatedAt: string;
  plan: DashboardPlan;
  tasks: DashboardTask[];
  handoffs: DashboardHandoff[];
  events: FlowEvent[];
};

export type DeltaMessage =
  | { kind: "snapshot"; state: DashboardState }
  | { kind: "plan"; fields: Partial<DashboardPlan>; updatedAt: string }
  | { kind: "task"; id: string; fields: DashboardTask | null; updatedAt: string }
  | { kind: "handoff"; id: string; fields: DashboardHandoff | null; updatedAt: string }
  | { kind: "event"; event: FlowEvent };

export type AgentNode = {
  id: string;
  name: string;
  kind: "orchestrator" | "agent";
  parentId?: string;
  taskId?: string;
  lastActivityMs: number;
  currentTool?: string;
  toolStartMs?: number;
  lastStatus?: string;
  errorCount: number;
  toolCount: number;
  recent: RecentItem[];
  pendingApproval: boolean;
};

export type RecentItem = {
  ts: number;
  kind: "tool" | "file" | "approval" | "task" | "spawn" | "handoff";
  label: string;
  status?: string;
};

export type FileNode = {
  path: string;
  reads: number;
  writes: number;
  lastOpMs: number;
  lastOpBy?: string;
  lastOp: "read" | "write" | "mkdir" | "search" | "focus";
};

export type SchedulerState = {
  idle: boolean;
  lastReason?: string;
  scheduled: string[];
  blocked: string[];
  lastPulse: Record<string, { kind: "scheduled" | "unblocked" | "started"; at: number }>;
};

export type HandoffPulse = {
  id: string;
  fromTask: string;
  toTask: string;
  at: number;
  status: HandoffStatus;
};

export type ActiveFileOp = {
  key: string;
  agentId: string;
  filePath: string;
  op: "read" | "write" | "mkdir" | "search" | "focus";
  startedAt: number;
  completedAt?: number;
  status: "running" | "ok" | "error";
  /** When set, this op is reading a file freshly written by this agent — propagation chain. */
  propagationFromAgent?: string;
};

export type RecentWrite = { agentId: string; at: number };

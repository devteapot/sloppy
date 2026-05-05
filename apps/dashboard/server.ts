#!/usr/bin/env bun

import { existsSync, type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type ClientTransport,
  SlopConsumer,
  WebSocketClientTransport,
} from "@slop-ai/consumer/browser";
import { SolidPlugin } from "bun-plugin-solid";
import { NodeSocketClientTransport } from "../../src/providers/node-socket";

type PlanStatus = "active" | "completed" | "cancelled" | "none";
type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "unknown";
type HandoffStatus = "pending" | "responded" | "cancelled";

type DashboardPlan = {
  id?: string;
  sessionId: string;
  query: string;
  strategy: string;
  status: PlanStatus;
  maxAgents: number;
  createdAt: string;
  version: number;
};

type DashboardTask = {
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

type DashboardHandoff = {
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

type DashboardDigestAction = {
  id: string;
  kind: string;
  label: string;
  targetRef: string;
  actionPath: string;
  actionName: string;
  urgency: "low" | "normal" | "high";
};

type DashboardDigest = {
  id: string;
  status: string;
  cadence: string;
  createdAt: string;
  actionEnabled: boolean;
  headline: string[];
  sourceRefs: string[];
  actions: DashboardDigestAction[];
  sections: {
    escalations: Array<{
      gateId: string;
      gateType: string;
      status: string;
      subjectRef: string;
      summary: string;
    }>;
    autoResolutionCount: number;
    nearMisses: Array<{
      kind: string;
      ref: string;
      summary: string;
    }>;
    drift: {
      criteriaTotal: number;
      criteriaSatisfied: number;
      criteriaUnknown: number;
      progressVelocity: number;
      progressCurrentDistance: number;
      replanCount: number;
      failureCount: number;
      coverageGapCount: number;
      goalRevisionPressure: number;
      recentEvents: Array<{
        id: string;
        kind: string;
        severity: string;
        status: string;
        summary: string;
      }>;
    };
    budget: {
      configured: boolean;
      exceeded: boolean;
      message: string;
      exceededLimits: string[];
    };
    next: {
      pendingGateCount: number;
      nextReadySlices: string[];
      runningSlices: string[];
      finalAuditStatus: string;
    };
  };
};

type DashboardFlowEvent = {
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

type DashboardState = {
  mode: "live" | "empty";
  source: string;
  updatedAt: string;
  plan: DashboardPlan;
  tasks: DashboardTask[];
  handoffs: DashboardHandoff[];
  digest: DashboardDigest | null;
  events: DashboardFlowEvent[];
};

type DeltaMessage =
  | { kind: "snapshot"; state: DashboardState }
  | { kind: "plan"; fields: Partial<DashboardPlan>; updatedAt: string }
  | { kind: "task"; id: string; fields: DashboardTask | null; updatedAt: string }
  | { kind: "handoff"; id: string; fields: DashboardHandoff | null; updatedAt: string }
  | { kind: "digest"; digest: DashboardDigest | null; updatedAt: string }
  | { kind: "event"; event: DashboardFlowEvent };

const appRoot = import.meta.dir;
const repoRoot = resolve(appRoot, "../..");
const encoder = new TextEncoder();

function readOption(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  if (index < 0) return undefined;
  return Bun.argv[index + 1];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringProp(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function numberProp(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanProp(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayProp(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function recordArrayProp(
  record: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<Record<string, unknown>> => {
    const candidate = asRecord(item);
    return Object.keys(candidate).length > 0 ? [candidate] : [];
  });
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `...[truncated]\n${text.slice(-maxChars)}`;
}

function preview(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined;
  const cleaned = text.trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 14)}...[truncated]`;
}

function taskStatus(value: string): TaskStatus {
  if (
    value === "pending" ||
    value === "scheduled" ||
    value === "running" ||
    value === "verifying" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "superseded"
  ) {
    return value;
  }
  return "unknown";
}

function planStatusValue(value: string): PlanStatus {
  if (value === "active" || value === "completed" || value === "cancelled") return value;
  return "none";
}

function handoffStatusValue(value: string): HandoffStatus {
  if (value === "responded" || value === "cancelled") return value;
  return "pending";
}

function listTaskIds(orchestrationRoot: string): string[] {
  const tasksDir = join(orchestrationRoot, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listHandoffFiles(orchestrationRoot: string): string[] {
  const handoffsDir = join(orchestrationRoot, "handoffs");
  if (!existsSync(handoffsDir)) return [];
  return readdirSync(handoffsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(handoffsDir, entry.name))
    .sort();
}

function listDigestFiles(orchestrationRoot: string): string[] {
  const digestsDir = join(orchestrationRoot, "digests");
  if (!existsSync(digestsDir)) return [];
  return readdirSync(digestsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(digestsDir, entry.name));
}

function newestDirectory(paths: string[]): string[] {
  return paths
    .flatMap((path) => {
      try {
        return [{ path, mtimeMs: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.path);
}

function workspaceFromOrchestrationRoot(orchestrationRoot: string): string {
  return dirname(dirname(orchestrationRoot));
}

function eventStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function laneForKind(kind: string, providerId?: string): DashboardFlowEvent["lane"] {
  if (kind === "tool_approval_requested") return "tool";
  if (
    kind === "task_state" ||
    kind === "task_unblocked" ||
    kind === "task_scheduled" ||
    kind === "task_started" ||
    kind === "scheduler_idle" ||
    kind === "scheduler_blocked"
  ) {
    return "state";
  }
  if (kind === "tool_started" || kind === "tool_completed") {
    if (providerId === "filesystem") return "data";
    if (providerId === "orchestration" || providerId === "delegation") return "state";
    return "tool";
  }
  if (kind === "providers") return "provider";
  return "tool";
}

function titleForKind(kind: string): string {
  switch (kind) {
    case "tool_started":
      return "Tool call";
    case "tool_completed":
      return "Tool result";
    case "tool_approval_requested":
      return "Approval requested";
    case "task_state":
      return "Task state";
    case "task_unblocked":
      return "Task unblocked";
    case "task_scheduled":
      return "Task scheduled";
    case "task_started":
      return "Task started";
    case "scheduler_idle":
      return "Scheduler idle";
    case "scheduler_blocked":
      return "Scheduler blocked";
    case "providers":
      return "Providers";
    default:
      return kind;
  }
}

function parseEventLine(line: string, index: number): DashboardFlowEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const record = asRecord(JSON.parse(trimmed));
    const ts = eventStringField(record, "ts");
    const kind = eventStringField(record, "kind");
    if (!ts || !kind) return null;
    const actor = asRecord(record.actor);
    const file = asRecord(record.file);
    const providerId = eventStringField(record, "providerId");
    const action = eventStringField(record, "action");
    const path = eventStringField(record, "path");
    const status = eventStringField(record, "status");
    const paramsPreview = eventStringField(record, "paramsPreview");
    const summary =
      kind === "tool_started"
        ? `${providerId ?? "?"}:${action ?? "?"} ${path ?? ""}${paramsPreview ? ` · ${paramsPreview}` : ""}`.trim()
        : kind === "tool_completed"
          ? `${status ?? "done"} · ${eventStringField(record, "summary") ?? ""}${paramsPreview ? ` · ${paramsPreview}` : ""}`.trim()
          : kind === "tool_approval_requested"
            ? `${providerId ?? "?"}:${action ?? "?"} ${path ?? ""}${paramsPreview ? ` · ${paramsPreview}` : ""}`.trim()
            : kind === "task_state"
              ? (eventStringField(record, "summary") ??
                `${eventStringField(record, "taskId") ?? "task"} ${status ?? "updated"}`)
              : (eventStringField(record, "summary") ?? kind);

    let fromTask: string | undefined;
    let toTask: string | undefined;
    if (
      providerId === "orchestration" &&
      (action === "create_handoff" || action === "respond_handoff")
    ) {
      const params = asRecord(record.params);
      fromTask = eventStringField(params, "from_task") ?? eventStringField(actor, "taskId");
      toTask = eventStringField(params, "to_task");
    }

    return {
      id: `${ts}-${index}-${kind}`,
      toolUseId: eventStringField(record, "toolUseId"),
      ts,
      lane: laneForKind(kind, providerId),
      scope: providerId ?? "agent",
      event: kind,
      title: titleForKind(kind),
      summary,
      status,
      providerId,
      path,
      action,
      taskId: eventStringField(record, "taskId"),
      agentId: eventStringField(actor, "id"),
      actorId: eventStringField(actor, "id"),
      actorName: eventStringField(actor, "name"),
      actorKind: eventStringField(actor, "kind") as "orchestrator" | "agent" | undefined,
      actorParentId: eventStringField(actor, "parentId"),
      actorTaskId: eventStringField(actor, "taskId"),
      toolName: action,
      fileOperation: eventStringField(file, "op") as
        | DashboardFlowEvent["fileOperation"]
        | undefined,
      filePath: eventStringField(file, "path"),
      dataPreview: paramsPreview,
      fromTask,
      toTask,
    };
  } catch {
    return null;
  }
}

function parseEventBusLogTail(orchestrationRoot: string): DashboardFlowEvent[] {
  const workspaceRoot = workspaceFromOrchestrationRoot(orchestrationRoot);
  const eventLog = join(workspaceRoot, ".sloppy/events.jsonl");
  const content = readText(eventLog);
  if (!content) return [];
  return content
    .split("\n")
    .slice(-300)
    .flatMap((line, index): DashboardFlowEvent[] => {
      const parsed = parseEventLine(line, index);
      return parsed ? [parsed] : [];
    });
}

function loadTaskFromDir(orchestrationRoot: string, id: string): DashboardTask | null {
  const taskDir = join(orchestrationRoot, "tasks", id);
  if (!existsSync(taskDir)) return null;
  const definition = readJson(join(taskDir, "definition.json")) ?? {};
  const state = readJson(join(taskDir, "state.json")) ?? {};
  return {
    id,
    planId: stringProp(definition, "plan_id") || undefined,
    name: stringProp(definition, "name", id),
    goal: stringProp(definition, "goal", ""),
    status: taskStatus(stringProp(state, "status", "unknown")),
    dependsOn: stringArrayProp(definition, "depends_on"),
    unmetDependencies: [],
    createdAt: stringProp(definition, "created_at"),
    updatedAt: stringProp(state, "updated_at"),
    completedAt: stringProp(state, "completed_at") || undefined,
    iteration: numberProp(state, "iteration"),
    version: numberProp(state, "version"),
    progressPreview: tail(readText(join(taskDir, "progress.md")) ?? "", 900),
    resultPreview: preview(readText(join(taskDir, "result.md")), 900),
    error: stringProp(state, "error") || undefined,
    supersededBy: stringProp(state, "superseded_by") || undefined,
  };
}

function loadHandoffFromFile(path: string): DashboardHandoff | null {
  const record = readJson(path);
  if (!record) return null;
  return {
    id: stringProp(record, "id"),
    planId: stringProp(record, "plan_id") || undefined,
    fromTask: stringProp(record, "from_task"),
    toTask: stringProp(record, "to_task"),
    request: stringProp(record, "request"),
    status: handoffStatusValue(stringProp(record, "status")),
    createdAt: stringProp(record, "created_at"),
    responsePreview: preview(stringProp(record, "response"), 500),
    version: numberProp(record, "version"),
  };
}

function digestUrgency(value: string): DashboardDigestAction["urgency"] {
  if (value === "low" || value === "high") return value;
  return "normal";
}

function loadLatestDigest(orchestrationRoot: string): DashboardDigest | null {
  const candidates = listDigestFiles(orchestrationRoot)
    .flatMap((path) => {
      const record = readJson(path);
      if (!record) return [];
      const createdAt = stringProp(record, "created_at");
      return [{ path, record, createdAt }];
    })
    .sort((left, right) => {
      const byCreated = right.createdAt.localeCompare(left.createdAt);
      if (byCreated !== 0) return byCreated;
      try {
        return statSync(right.path).mtimeMs - statSync(left.path).mtimeMs;
      } catch {
        return 0;
      }
    });
  const latest = candidates[0]?.record;
  if (!latest) return null;

  const sections = asRecord(latest.sections);
  const drift = asRecord(sections.drift_dashboard);
  const progress = asRecord(drift.progress);
  const coherence = asRecord(drift.coherence);
  const intent = asRecord(drift.intent);
  const budget = asRecord(sections.budget);
  const next = asRecord(sections.whats_next);
  const autoResolutions = asRecord(sections.auto_resolutions);

  return {
    id: stringProp(latest, "id"),
    status: stringProp(latest, "status"),
    cadence: stringProp(latest, "cadence"),
    createdAt: stringProp(latest, "created_at"),
    actionEnabled: sessionOption !== undefined,
    headline: stringArrayProp(latest, "headline"),
    sourceRefs: stringArrayProp(latest, "source_refs").slice(0, 24),
    actions: recordArrayProp(latest, "actions").map((action) => ({
      id: stringProp(action, "id"),
      kind: stringProp(action, "kind"),
      label: stringProp(action, "label"),
      targetRef: stringProp(action, "target_ref"),
      actionPath: stringProp(action, "action_path"),
      actionName: stringProp(action, "action_name"),
      urgency: digestUrgency(stringProp(action, "urgency")),
    })),
    sections: {
      escalations: recordArrayProp(sections, "escalations").map((gate) => ({
        gateId: stringProp(gate, "gate_id"),
        gateType: stringProp(gate, "gate_type"),
        status: stringProp(gate, "status"),
        subjectRef: stringProp(gate, "subject_ref"),
        summary: stringProp(gate, "summary"),
      })),
      autoResolutionCount: numberProp(autoResolutions, "count"),
      nearMisses: recordArrayProp(sections, "near_misses").map((item) => ({
        kind: stringProp(item, "kind"),
        ref: stringProp(item, "ref"),
        summary: stringProp(item, "summary"),
      })),
      drift: {
        criteriaTotal: numberProp(progress, "criteria_total"),
        criteriaSatisfied: numberProp(progress, "criteria_satisfied"),
        criteriaUnknown: numberProp(progress, "criteria_unknown"),
        progressVelocity: numberProp(progress, "velocity"),
        progressCurrentDistance: numberProp(progress, "current_distance"),
        replanCount: numberProp(coherence, "replan_count"),
        failureCount: numberProp(coherence, "failure_count"),
        coverageGapCount: numberProp(intent, "coverage_gap_count"),
        goalRevisionPressure: numberProp(intent, "goal_revision_pressure"),
        recentEvents: recordArrayProp(drift, "recent_events").map((event) => ({
          id: stringProp(event, "id"),
          kind: stringProp(event, "kind"),
          severity: stringProp(event, "severity"),
          status: stringProp(event, "status"),
          summary: stringProp(event, "summary"),
        })),
      },
      budget: {
        configured: booleanProp(budget, "configured"),
        exceeded: booleanProp(budget, "exceeded"),
        message: stringProp(budget, "message"),
        exceededLimits: stringArrayProp(budget, "exceeded_limits"),
      },
      next: {
        pendingGateCount: numberProp(next, "pending_gate_count"),
        nextReadySlices: stringArrayProp(next, "next_ready_slices"),
        runningSlices: stringArrayProp(next, "running_slices"),
        finalAuditStatus: stringProp(next, "final_audit_status", "none"),
      },
    },
  };
}

function computeUnmet(tasks: DashboardTask[]): void {
  const byStatus = new Map<string, DashboardTask>();
  for (const t of tasks) byStatus.set(t.id, t);
  for (const task of tasks) {
    task.unmetDependencies = task.dependsOn.filter((id) => {
      const dep = byStatus.get(id);
      if (!dep) return true;
      if (dep.status === "completed") return false;
      if (dep.status !== "superseded") return true;
      if (!dep.supersededBy) return true;
      const replacement = byStatus.get(dep.supersededBy);
      return !replacement || replacement.status !== "completed";
    });
  }
}

function loadLiveState(orchestrationRoot: string): DashboardState | null {
  const planJson = readJson(join(orchestrationRoot, "plan.json"));
  const taskIds = listTaskIds(orchestrationRoot);
  if (!planJson && taskIds.length === 0) return null;
  const currentPlanId = planJson ? stringProp(planJson, "id") : "";

  const tasks = taskIds
    .flatMap((id) => {
      const task = loadTaskFromDir(orchestrationRoot, id);
      return task ? [task] : [];
    })
    .filter((task) => !currentPlanId || task.planId === currentPlanId);
  computeUnmet(tasks);

  const handoffs = listHandoffFiles(orchestrationRoot)
    .flatMap((path) => {
      const h = loadHandoffFromFile(path);
      return h ? [h] : [];
    })
    .filter((handoff) => !currentPlanId || handoff.planId === currentPlanId);

  const plan = planJson ?? {};
  return {
    mode: "live",
    source: orchestrationRoot,
    updatedAt: new Date().toISOString(),
    plan: {
      id: stringProp(plan, "id") || undefined,
      sessionId: stringProp(plan, "session_id", "default"),
      query: stringProp(plan, "query", "Filesystem orchestration"),
      strategy: stringProp(plan, "strategy", "unknown"),
      status: planStatusValue(stringProp(plan, "status", "none")),
      maxAgents: numberProp(plan, "max_agents", 0),
      createdAt: stringProp(plan, "created_at"),
      version: numberProp(plan, "version"),
    },
    tasks,
    handoffs,
    digest: loadLatestDigest(orchestrationRoot),
    events: parseEventBusLogTail(orchestrationRoot),
  };
}

function loadPlanOnly(orchestrationRoot: string): DashboardPlan | null {
  const planJson = readJson(join(orchestrationRoot, "plan.json"));
  if (!planJson) return null;
  return {
    id: stringProp(planJson, "id") || undefined,
    sessionId: stringProp(planJson, "session_id", "default"),
    query: stringProp(planJson, "query", "Filesystem orchestration"),
    strategy: stringProp(planJson, "strategy", "unknown"),
    status: planStatusValue(stringProp(planJson, "status", "none")),
    maxAgents: numberProp(planJson, "max_agents", 0),
    createdAt: stringProp(planJson, "created_at"),
    version: numberProp(planJson, "version"),
  };
}

function activeE2eCandidates(): string[] {
  const root = tmpdir();
  try {
    return newestDirectory(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("sloppy-e2e-"))
        .map((entry) => join(root, entry.name, ".sloppy/orchestration")),
    );
  } catch {
    return [];
  }
}

function emptyState(source: string): DashboardState {
  const now = new Date().toISOString();
  return {
    mode: "empty",
    source,
    updatedAt: now,
    plan: {
      sessionId: "",
      query: "Waiting for orchestration state",
      strategy: "",
      status: "none",
      maxAgents: 0,
      createdAt: "",
      version: 0,
    },
    tasks: [],
    handoffs: [],
    digest: null,
    events: [],
  };
}

const workspaceOption = readOption("--workspace") ?? process.env.SLOPPY_DASHBOARD_WORKSPACE;
const sessionOption = readOption("--session") ?? process.env.SLOPPY_DASHBOARD_SESSION;
const workspaceRoot = resolve(workspaceOption ?? repoRoot);
const port = Number(readOption("--port") ?? process.env.PORT ?? 8787);

function resolveOrchestrationRoot(): string {
  const workspaceCandidate = join(workspaceRoot, ".sloppy/orchestration");
  const e2eCandidates = activeE2eCandidates();
  const demoCandidate = join(repoRoot, ".sloppy-demo/.sloppy/orchestration");
  const candidates = workspaceOption
    ? [workspaceCandidate, ...e2eCandidates, demoCandidate]
    : [...e2eCandidates, workspaceCandidate, demoCandidate];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return e2eCandidates[0] ?? workspaceCandidate;
}

function buildState(): DashboardState {
  const root = resolveOrchestrationRoot();
  const loaded = loadLiveState(root);
  return loaded ?? emptyState(root);
}

async function clientScript(): Promise<Response> {
  const result = await Bun.build({
    entrypoints: [join(appRoot, "src/main.tsx")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    minify: false,
    plugins: [SolidPlugin()],
  });

  if (!result.success || !result.outputs[0]) {
    const message = result.logs.map((log) => log.message).join("\n");
    return new Response(message || "Failed to build dashboard client.", { status: 500 });
  }

  return new Response(result.outputs[0], {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fileResponse(path: string, contentType: string): Response {
  const stat = statSync(path);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": contentType,
      "content-length": String(stat.size),
      "cache-control": "no-store",
    },
  });
}

type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  alive: boolean;
};

const subscribers = new Set<Subscriber>();

function send(subscriber: Subscriber, eventName: string, payload: unknown): boolean {
  if (!subscriber.alive) return false;
  try {
    subscriber.controller.enqueue(
      encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
    return true;
  } catch {
    subscriber.alive = false;
    return false;
  }
}

function broadcast(eventName: string, payload: unknown) {
  for (const sub of [...subscribers]) {
    if (!send(sub, eventName, payload)) subscribers.delete(sub);
  }
}

// ---- filesystem watching -------------------------------------------------

type WatchState = {
  orchestrationRoot: string;
  watcher?: FSWatcher;
  eventWatcher?: FSWatcher;
  eventOffset: number;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const watchState: WatchState = {
  orchestrationRoot: resolveOrchestrationRoot(),
  eventOffset: 0,
  debounceTimers: new Map(),
};

function iso() {
  return new Date().toISOString();
}

function handleFsChange(relPath: string) {
  const key = relPath;
  const existing = watchState.debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    watchState.debounceTimers.delete(key);
    applyFsChange(relPath);
  }, 50);
  watchState.debounceTimers.set(key, timer);
}

function applyFsChange(relPath: string) {
  const root = watchState.orchestrationRoot;
  const normalized = relPath.split(sep).join("/");

  if (normalized === "plan.json") {
    broadcast("delta", {
      kind: "snapshot",
      state: loadLiveState(root) ?? emptyState(root),
    } satisfies DeltaMessage);
    return;
  }

  const taskMatch = normalized.match(
    /^tasks\/([^/]+)\/(definition\.json|state\.json|progress\.md|result\.md)$/,
  );
  if (taskMatch) {
    const id = taskMatch[1];
    if (!id) return;
    const task = loadTaskFromDir(root, id);
    if (task === null) {
      broadcast("delta", {
        kind: "task",
        id,
        fields: null,
        updatedAt: iso(),
      } satisfies DeltaMessage);
      recomputeAllUnmet();
      return;
    }
    const plan = loadPlanOnly(root);
    if (plan?.id && task.planId !== plan.id) {
      broadcast("delta", {
        kind: "task",
        id,
        fields: null,
        updatedAt: iso(),
      } satisfies DeltaMessage);
      recomputeAllUnmet();
      return;
    }
    // Unmet deps depend on other tasks — recompute for just this one using a fresh pass of peers.
    const peerIds = listTaskIds(root);
    const peers = peerIds
      .flatMap((pid) => {
        if (pid === id) return [task];
        const p = loadTaskFromDir(root, pid);
        return p ? [p] : [];
      })
      .filter((peer) => !plan?.id || peer.planId === plan.id);
    computeUnmet(peers);
    const updated = peers.find((t) => t.id === id) ?? task;
    broadcast("delta", {
      kind: "task",
      id,
      fields: updated,
      updatedAt: iso(),
    } satisfies DeltaMessage);
    // Cascade: other tasks' unmet deps may change when this task's status changes.
    for (const peer of peers) {
      if (peer.id === id) continue;
      broadcast("delta", {
        kind: "task",
        id: peer.id,
        fields: peer,
        updatedAt: iso(),
      } satisfies DeltaMessage);
    }
    return;
  }

  const handoffMatch = normalized.match(/^handoffs\/(.+)\.json$/);
  if (handoffMatch) {
    const handoffId = handoffMatch[1];
    if (!handoffId) return;
    const fullPath = join(root, normalized);
    if (!existsSync(fullPath)) {
      broadcast("delta", {
        kind: "handoff",
        id: handoffId,
        fields: null,
        updatedAt: iso(),
      } satisfies DeltaMessage);
      return;
    }
    const handoff = loadHandoffFromFile(fullPath);
    const plan = loadPlanOnly(root);
    if (handoff && plan?.id && handoff.planId !== plan.id) {
      broadcast("delta", {
        kind: "handoff",
        id: handoff.id || handoffId,
        fields: null,
        updatedAt: iso(),
      } satisfies DeltaMessage);
      return;
    }
    if (handoff) {
      broadcast("delta", {
        kind: "handoff",
        id: handoff.id || handoffId,
        fields: handoff,
        updatedAt: iso(),
      } satisfies DeltaMessage);
    }
    return;
  }

  if (normalized.match(/^digests\/.+\.json$/)) {
    broadcast("delta", {
      kind: "digest",
      digest: loadLatestDigest(root),
      updatedAt: iso(),
    } satisfies DeltaMessage);
  }
}

function recomputeAllUnmet() {
  const root = watchState.orchestrationRoot;
  const plan = loadPlanOnly(root);
  const ids = listTaskIds(root);
  const tasks = ids
    .flatMap((id) => {
      const t = loadTaskFromDir(root, id);
      return t ? [t] : [];
    })
    .filter((task) => !plan?.id || task.planId === plan.id);
  computeUnmet(tasks);
  for (const task of tasks) {
    broadcast("delta", {
      kind: "task",
      id: task.id,
      fields: task,
      updatedAt: iso(),
    } satisfies DeltaMessage);
  }
}

function readNewEventLines() {
  const workspace = workspaceFromOrchestrationRoot(watchState.orchestrationRoot);
  const path = join(workspace, ".sloppy/events.jsonl");
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (stat.size < watchState.eventOffset) {
      watchState.eventOffset = 0; // truncated/rotated
    }
    if (stat.size === watchState.eventOffset) return;
    const fd = Bun.file(path);
    const buf = Buffer.alloc(stat.size - watchState.eventOffset);
    // Fall back to readFileSync + slice (simpler than positional reads in Bun).
    const content = readFileSync(path);
    const slice = content.subarray(watchState.eventOffset, stat.size).toString("utf8");
    watchState.eventOffset = stat.size;
    const lines = slice.split("\n");
    lines.forEach((line, index) => {
      const parsed = parseEventLine(line, index + Math.floor(Math.random() * 1e6));
      if (parsed) broadcast("delta", { kind: "event", event: parsed } satisfies DeltaMessage);
    });
    void fd;
    void buf;
  } catch {
    // ignore
  }
}

function startWatching() {
  stopWatching();
  const root = watchState.orchestrationRoot;
  if (existsSync(root)) {
    try {
      watchState.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        handleFsChange(String(filename));
      });
    } catch (err) {
      console.error("[sloppy-dashboard] watch failed", err);
    }
  }

  const workspace = workspaceFromOrchestrationRoot(root);
  const sloppyDir = join(workspace, ".sloppy");
  const eventLog = join(sloppyDir, "events.jsonl");
  try {
    if (existsSync(eventLog)) {
      watchState.eventOffset = statSync(eventLog).size;
    } else {
      watchState.eventOffset = 0;
    }
  } catch {
    watchState.eventOffset = 0;
  }
  try {
    if (existsSync(sloppyDir)) {
      watchState.eventWatcher = watch(sloppyDir, (_event, filename) => {
        if (filename && basename(String(filename)) === "events.jsonl") {
          readNewEventLines();
        }
      });
    }
  } catch (err) {
    console.error("[sloppy-dashboard] event watch failed", err);
  }
}

function stopWatching() {
  watchState.watcher?.close();
  watchState.eventWatcher?.close();
  watchState.watcher = undefined;
  watchState.eventWatcher = undefined;
  for (const timer of watchState.debounceTimers.values()) clearTimeout(timer);
  watchState.debounceTimers.clear();
}

// Periodically re-resolve the orchestration root in case a new e2e workspace
// appears. Cheap — just existsSync checks.
const ROOT_CHECK_MS = 2000;
setInterval(() => {
  const candidate = resolveOrchestrationRoot();
  if (candidate !== watchState.orchestrationRoot) {
    watchState.orchestrationRoot = candidate;
    startWatching();
    broadcast("delta", { kind: "snapshot", state: buildState() } satisfies DeltaMessage);
  }
}, ROOT_CHECK_MS);

startWatching();

// ---- HTTP ---------------------------------------------------------------

function eventStream(request: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const subscriber: Subscriber = { controller, alive: true };
      subscribers.add(subscriber);
      // initial snapshot
      send(subscriber, "snapshot", buildState());
      request.signal.addEventListener("abort", () => {
        subscriber.alive = false;
        subscribers.delete(subscriber);
        try {
          controller.close();
        } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

function sessionTransportForAddress(address: string): ClientTransport {
  if (address.startsWith("ws://") || address.startsWith("wss://")) {
    return new WebSocketClientTransport(address);
  }
  if (address.startsWith("unix:")) {
    return new NodeSocketClientTransport(address.slice("unix:".length));
  }
  if (address.startsWith("/") || address.startsWith(".")) {
    return new NodeSocketClientTransport(address);
  }
  throw new Error(`Unsupported session provider address: ${address}`);
}

async function invokeSession(path: string, action: string, params: Record<string, unknown>) {
  if (!sessionOption) {
    return Response.json(
      {
        ok: false,
        error: "Start the dashboard with --session <socket-or-ws-url> to enable actions.",
      },
      { status: 409 },
    );
  }

  const consumer = new SlopConsumer(sessionTransportForAddress(sessionOption));
  try {
    await consumer.connect();
    const result = await consumer.invoke(path, action, params);
    if (result.status === "error") {
      return Response.json(
        { ok: false, error: result.error?.message ?? "Session action failed.", result },
        { status: 400 },
      );
    }
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  } finally {
    consumer.disconnect();
  }
}

async function digestAction(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON body." }, { status: 400 });
  }
  const actionId =
    stringProp(asRecord(body), "action_id") || stringProp(asRecord(body), "actionId");
  if (!actionId) {
    return Response.json({ ok: false, error: "Missing action_id." }, { status: 400 });
  }
  return invokeSession("/orchestration", "run_digest_action", { action_id: actionId });
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return fileResponse(join(appRoot, "index.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/styles.css") {
      return fileResponse(join(appRoot, "styles.css"), "text/css; charset=utf-8");
    }
    if (url.pathname === "/app.js") {
      return clientScript();
    }
    if (url.pathname === "/api/state") {
      return Response.json(buildState(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/events") {
      return eventStream(request);
    }
    if (url.pathname === "/api/digest-actions" && request.method === "POST") {
      return digestAction(request);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`[sloppy-dashboard] http://localhost:${server.port}`);
console.log(`[sloppy-dashboard] workspace: ${workspaceRoot}`);
console.log(`[sloppy-dashboard] orchestration: ${watchState.orchestrationRoot}`);
console.log(`[sloppy-dashboard] session actions: ${sessionOption ?? "disabled"}`);

void relative;

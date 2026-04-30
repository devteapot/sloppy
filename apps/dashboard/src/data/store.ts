import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type {
  ActiveFileOp,
  AgentNode,
  DashboardDigest,
  DashboardHandoff,
  DashboardPlan,
  DashboardTask,
  FileNode,
  FlowEvent,
  HandoffPulse,
  RecentWrite,
  SchedulerState,
} from "./types";

const EMPTY_PLAN: DashboardPlan = {
  sessionId: "",
  query: "awaiting plan",
  strategy: "",
  status: "none",
  maxAgents: 0,
  createdAt: "",
  version: 0,
};

export type DashboardStore = ReturnType<typeof createDashboardStore>;

export function createDashboardStore() {
  const [plan, setPlan] = createStore<DashboardPlan>({ ...EMPTY_PLAN });
  const [tasks, setTasks] = createStore<Record<string, DashboardTask>>({});
  const [handoffs, setHandoffs] = createStore<Record<string, DashboardHandoff>>({});
  const [digest, setDigest] = createSignal<DashboardDigest | null>(null);
  const [agents, setAgents] = createStore<Record<string, AgentNode>>({});
  const [files, setFiles] = createStore<Record<string, FileNode>>({});
  const [scheduler, setScheduler] = createStore<SchedulerState>({
    idle: true,
    scheduled: [],
    blocked: [],
    lastPulse: {},
  });
  const [handoffPulses, setHandoffPulses] = createStore<HandoffPulse[]>([]);
  const [activeOps, setActiveOps] = createStore<Record<string, ActiveFileOp>>({});
  const [recentWrites, setRecentWrites] = createStore<Record<string, RecentWrite>>({});
  const [recent, setRecent] = createSignal<FlowEvent[]>([]);
  const [source, setSource] = createSignal("");
  const [updatedAt, setUpdatedAt] = createSignal("");
  const [mode, setMode] = createSignal<"live" | "empty">("empty");
  const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null);
  const [counters, setCounters] = createStore({ tools: 0, fileOps: 0 });

  function clear() {
    setPlan({ ...EMPTY_PLAN });
    setTasks(
      produce((t) => {
        for (const k of Object.keys(t)) delete t[k];
      }),
    );
    setHandoffs(
      produce((h) => {
        for (const k of Object.keys(h)) delete h[k];
      }),
    );
    setDigest(null);
    setAgents(
      produce((a) => {
        for (const k of Object.keys(a)) delete a[k];
      }),
    );
    setFiles(
      produce((f) => {
        for (const k of Object.keys(f)) delete f[k];
      }),
    );
    setScheduler({ idle: true, scheduled: [], blocked: [], lastPulse: {} });
    setHandoffPulses([]);
    setActiveOps(
      produce((o) => {
        for (const k of Object.keys(o)) delete o[k];
      }),
    );
    setRecentWrites(
      produce((w) => {
        for (const k of Object.keys(w)) delete w[k];
      }),
    );
    setRecent([]);
    setCounters({ tools: 0, fileOps: 0 });
  }

  return {
    plan,
    setPlan,
    tasks,
    setTasks,
    handoffs,
    setHandoffs,
    digest,
    setDigest,
    agents,
    setAgents,
    files,
    setFiles,
    scheduler,
    setScheduler,
    handoffPulses,
    setHandoffPulses,
    activeOps,
    setActiveOps,
    recentWrites,
    setRecentWrites,
    recent,
    setRecent,
    source,
    setSource,
    updatedAt,
    setUpdatedAt,
    mode,
    setMode,
    selectedAgentId,
    setSelectedAgentId,
    selectedTaskId,
    setSelectedTaskId,
    counters,
    setCounters,
    clear,
  };
}

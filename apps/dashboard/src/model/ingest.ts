import { produce } from "solid-js/store";
import type { DashboardStore } from "../data/store";
import type { AgentNode, FlowEvent, HandoffPulse, HandoffStatus, RecentItem } from "../data/types";

const RECENT_CAP = 200;
const AGENT_RECENT_CAP = 12;
const PULSE_TTL_MS = 4000;
const PROPAGATION_WINDOW_MS = 5000;

export function ingestEvent(store: DashboardStore, event: FlowEvent): void {
  const ts = Date.parse(event.ts) || Date.now();
  const actorId = event.actorId ?? "agent";

  store.setAgents(
    produce((a) => {
      const existing = a[actorId];
      const next: AgentNode = existing ?? {
        id: actorId,
        name: event.actorName ?? actorId,
        kind: event.actorKind ?? (actorId === "orchestrator" ? "orchestrator" : "agent"),
        parentId: event.actorParentId,
        taskId: event.actorTaskId,
        lastActivityMs: ts,
        errorCount: 0,
        toolCount: 0,
        recent: [],
        pendingApproval: false,
      };
      if (event.actorName) next.name = event.actorName;
      if (event.actorKind) next.kind = event.actorKind;
      if (event.actorParentId) next.parentId = event.actorParentId;
      if (event.actorTaskId) next.taskId = event.actorTaskId;
      next.lastActivityMs = ts;

      if (event.event === "tool_started") {
        next.currentTool = `${event.providerId ?? "?"}:${event.action ?? "?"}`;
        next.toolStartMs = ts;
        next.toolCount += 1;
        const label =
          event.fileOperation && event.filePath
            ? `${event.fileOperation} ${event.filePath}`
            : `${event.providerId ?? "?"}:${event.action ?? "?"} ${event.path ?? ""}`.trim();
        const recentKind: RecentItem["kind"] = event.fileOperation ? "file" : "tool";
        next.recent = [{ ts, kind: recentKind, label }, ...next.recent].slice(0, AGENT_RECENT_CAP);
      } else if (event.event === "tool_completed") {
        next.lastStatus = event.status;
        if (event.status === "error") next.errorCount += 1;
        next.currentTool = undefined;
        next.toolStartMs = undefined;
      } else if (event.event === "tool_approval_requested") {
        next.pendingApproval = true;
        next.recent = [
          { ts, kind: "approval" as const, label: `approval: ${event.action ?? "?"}` },
          ...next.recent,
        ].slice(0, AGENT_RECENT_CAP);
      } else if (event.event === "task_state") {
        next.lastStatus = event.status;
        next.recent = [
          {
            ts,
            kind: "task" as const,
            label: `${event.taskId ?? "task"} ${event.status ?? "updated"}`,
          },
          ...next.recent,
        ].slice(0, AGENT_RECENT_CAP);
      }
      a[actorId] = next;
    }),
  );

  if (event.event === "tool_started") {
    store.setCounters("tools", (n) => n + 1);
    if (event.fileOperation && event.filePath) {
      store.setCounters("fileOps", (n) => n + 1);
      const op = event.fileOperation;
      const path = event.filePath;
      store.setFiles(
        produce((f) => {
          const existing = f[path];
          const base = existing ?? {
            path,
            reads: 0,
            writes: 0,
            lastOpMs: ts,
            lastOp: op,
          };
          if (op === "read" || op === "search") base.reads += 1;
          if (op === "write" || op === "mkdir") base.writes += 1;
          base.lastOpMs = ts;
          base.lastOp = op;
          base.lastOpBy = actorId;
          f[path] = base;
        }),
      );

      const opKey = event.toolUseId ?? `${actorId}:${path}:${ts}`;
      const recent = store.recentWrites[path];
      const isPropagation =
        (op === "read" || op === "search") &&
        recent !== undefined &&
        recent.agentId !== actorId &&
        ts - recent.at <= PROPAGATION_WINDOW_MS;
      store.setActiveOps(opKey, {
        key: opKey,
        agentId: actorId,
        filePath: path,
        op,
        startedAt: ts,
        status: "running",
        propagationFromAgent: isPropagation ? recent!.agentId : undefined,
      });
    }
    if (event.providerId === "delegation" && event.action === "spawn_agent") {
      const agent = store.agents[actorId];
      if (agent) {
        store.setAgents(actorId, "recent", (r) =>
          [
            {
              ts,
              kind: "spawn" as const,
              label: `spawn ${event.path ?? event.dataPreview ?? ""}`.trim(),
            },
            ...r,
          ].slice(0, AGENT_RECENT_CAP),
        );
      }
    }
    if (
      event.providerId === "orchestration" &&
      (event.action === "create_handoff" || event.action === "respond_handoff")
    ) {
      const agent = store.agents[actorId];
      if (agent) {
        store.setAgents(actorId, "recent", (r) =>
          [
            {
              ts,
              kind: "handoff" as const,
              label: `${event.action} ${event.path ?? ""}`.trim(),
            },
            ...r,
          ].slice(0, AGENT_RECENT_CAP),
        );
      }
    }
  }

  if (event.event === "tool_completed") {
    if (event.fileOperation && event.filePath) {
      const opKey = event.toolUseId ?? `${actorId}:${event.filePath}`;
      // The op may already be gone if the snapshot replayed completions only.
      const existing = store.activeOps[opKey];
      if (existing) {
        store.setActiveOps(opKey, {
          ...existing,
          completedAt: ts,
          status: event.status === "error" ? "error" : "ok",
        });
      }
      if (
        (event.fileOperation === "write" || event.fileOperation === "mkdir") &&
        event.status === "ok"
      ) {
        store.setRecentWrites(event.filePath, { agentId: actorId, at: ts });
      }
    }
  }

  if (event.event === "tool_completed" && event.status === "ok") {
    if (
      event.providerId === "orchestration" &&
      (event.action === "create_handoff" || event.action === "respond_handoff")
    ) {
      const fromId = event.fromTask ?? event.actorTaskId;
      const toId = event.toTask;
      if (fromId && toId) {
        const status: HandoffStatus = event.action === "respond_handoff" ? "responded" : "pending";
        const pulse: HandoffPulse = {
          id: `${fromId}:${toId}:${ts}`,
          fromTask: fromId,
          toTask: toId,
          at: ts,
          status,
        };
        store.setHandoffPulses((p) =>
          [...p.filter((x) => Date.now() - x.at < PULSE_TTL_MS), pulse].slice(-32),
        );
      }
    }
  }

  if (
    event.event === "task_scheduled" ||
    event.event === "task_unblocked" ||
    event.event === "task_started"
  ) {
    if (event.taskId) {
      const pulseKind =
        event.event === "task_scheduled"
          ? "scheduled"
          : event.event === "task_unblocked"
            ? "unblocked"
            : "started";
      store.setScheduler("lastPulse", event.taskId, { kind: pulseKind, at: ts });
    }
    if (event.event === "task_scheduled" && event.taskId) {
      const taskId = event.taskId;
      store.setScheduler("scheduled", (s) => (s.includes(taskId) ? s : [...s, taskId]));
    }
    if (event.event === "task_started" && event.taskId) {
      store.setScheduler("scheduled", (s) => s.filter((x) => x !== event.taskId));
    }
  }
  if (event.event === "scheduler_idle") {
    store.setScheduler({ idle: true, lastReason: event.summary });
  }
  if (event.event === "scheduler_blocked") {
    store.setScheduler({ idle: false, lastReason: event.summary });
  }

  store.setRecent((r) => [event, ...r].slice(0, RECENT_CAP));
}

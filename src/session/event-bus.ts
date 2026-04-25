import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentCallbacks, AgentToolEvent, AgentToolInvocation } from "../core/agent";
import type { ExternalProviderState } from "../core/consumer";
import type { OrchestrationSchedulerEvent } from "../core/orchestration-scheduler";

export type AgentEventActor = {
  id: string;
  name?: string;
  kind: "orchestrator" | "agent";
  parentId?: string;
  taskId?: string;
};

type BaseEvent = {
  ts: string;
  actor: AgentEventActor;
};

export type AgentEvent = BaseEvent &
  (
    | {
        kind: "tool_started";
        toolUseId: string;
        providerId?: string;
        action: string;
        path?: string;
        invocationKind: AgentToolInvocation["kind"];
        paramsPreview?: string;
        file?: { op: string; path?: string };
      }
    | {
        kind: "tool_completed";
        toolUseId: string;
        providerId?: string;
        action: string;
        path?: string;
        status: "ok" | "error" | "accepted" | "cancelled";
        taskId?: string;
        errorCode?: string;
        errorMessage?: string;
        summary: string;
        paramsPreview?: string;
        file?: { op: string; path?: string };
      }
    | {
        kind: "tool_approval_requested";
        toolUseId: string;
        providerId?: string;
        action: string;
        path?: string;
        errorCode?: string;
        errorMessage?: string;
        paramsPreview?: string;
      }
    | {
        kind: "approval_state";
        providerId: string;
        approvals: Array<{
          id: string;
          status?: string;
          path?: string;
          action?: string;
          reason?: string;
          paramsPreview?: string;
          dangerous?: boolean;
        }>;
      }
    | {
        kind: "task_state";
        providerId: string;
        taskId: string;
        taskName?: string;
        status?: string;
        version?: number;
        summary: string;
      }
    | {
        kind: "providers";
        states: Array<{ id: string; status: string; message?: string }>;
      }
    | (OrchestrationSchedulerEvent & {
        kind:
          | "task_unblocked"
          | "task_scheduled"
          | "task_started"
          | "scheduler_idle"
          | "scheduler_blocked";
      })
  );

export interface AgentEventBus {
  callbacks: AgentCallbacks;
  emit(event: AgentEvent): void;
  stop(): void;
}

function inferFile(inv: AgentToolInvocation): { op: string; path?: string } | undefined {
  if (inv.providerId !== "filesystem") return undefined;
  const params = (inv.params ?? {}) as Record<string, unknown>;
  const p = typeof params.path === "string" ? params.path : undefined;
  const opMap: Record<string, string> = {
    read: "read",
    write: "write",
    edit: "write",
    mkdir: "mkdir",
    search: "search",
    set_focus: "focus",
    focus: "focus",
  };
  const op = opMap[inv.action];
  if (!op) return undefined;
  return { op, path: p };
}

function shouldRedactParam(key: string): boolean {
  return /(api[-_]?key|authorization|cookie|password|secret|token)/i.test(key);
}

function sanitizeParamValue(value: unknown, key = "", depth = 0): unknown {
  if (shouldRedactParam(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 224)}...[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 3) return `[array:${value.length}]`;
    return value.slice(0, 12).map((item) => sanitizeParamValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 3) return "[object]";
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, 24)
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeParamValue(childValue, childKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

function paramsPreview(inv: AgentToolInvocation): string | undefined {
  const params = inv.params ?? {};
  if (Object.keys(params).length === 0) return undefined;
  const preview = JSON.stringify(sanitizeParamValue(params));
  if (!preview) return undefined;
  return preview.length > 1200 ? `${preview.slice(0, 1184)}...[truncated]` : preview;
}

export function createAgentEventBus(options: {
  logPath: string;
  actor: AgentEventActor;
}): AgentEventBus {
  let stopped = false;
  const taskStateSignatures = new Map<string, string>();
  try {
    mkdirSync(dirname(options.logPath), { recursive: true });
  } catch {
    // ignore
  }

  const write = (event: AgentEvent) => {
    if (stopped) return;
    try {
      appendFileSync(options.logPath, `${JSON.stringify(event)}\n`);
    } catch {
      // best-effort; never break agent on logging failure
    }
  };

  const callbacks: AgentCallbacks = {
    onToolEvent: (event: AgentToolEvent) => {
      const ts = new Date().toISOString();
      const base = { ts, actor: options.actor };
      if (event.kind === "started") {
        write({
          ...base,
          kind: "tool_started",
          toolUseId: event.invocation.toolUseId,
          providerId: event.invocation.providerId,
          action: event.invocation.action,
          path: event.invocation.path,
          invocationKind: event.invocation.kind,
          paramsPreview: paramsPreview(event.invocation),
          file: inferFile(event.invocation),
        });
      } else if (event.kind === "completed") {
        write({
          ...base,
          kind: "tool_completed",
          toolUseId: event.invocation.toolUseId,
          providerId: event.invocation.providerId,
          action: event.invocation.action,
          path: event.invocation.path,
          status: event.status,
          taskId: event.taskId,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          summary: event.summary,
          paramsPreview: paramsPreview(event.invocation),
          file: inferFile(event.invocation),
        });
      } else if (event.kind === "approval_requested") {
        write({
          ...base,
          kind: "tool_approval_requested",
          toolUseId: event.invocation.toolUseId,
          providerId: event.invocation.providerId,
          action: event.invocation.action,
          path: event.invocation.path,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          paramsPreview: paramsPreview(event.invocation),
        });
      }
    },
    onProviderSnapshot: (update) => {
      if (update.path === "/tasks") {
        if (!update.tree) {
          for (const key of [...taskStateSignatures.keys()]) {
            if (key.startsWith(`${update.providerId}:`)) {
              taskStateSignatures.delete(key);
            }
          }
          return;
        }

        for (const child of update.tree.children ?? []) {
          const props = (child.properties ?? {}) as Record<string, unknown>;
          const taskId = typeof props.id === "string" && props.id.length > 0 ? props.id : child.id;
          const status = typeof props.status === "string" ? props.status : undefined;
          const taskName = typeof props.name === "string" ? props.name : undefined;
          const version = typeof props.version === "number" ? props.version : undefined;
          const key = `${update.providerId}:${taskId}`;
          const signature = JSON.stringify({ status, taskName, version });
          if (taskStateSignatures.get(key) === signature) {
            continue;
          }
          taskStateSignatures.set(key, signature);
          write({
            ts: new Date().toISOString(),
            actor: options.actor,
            kind: "task_state",
            providerId: update.providerId,
            taskId,
            taskName,
            status,
            version,
            summary: `${taskName ?? taskId}: ${status ?? "updated"}`,
          });
        }
        return;
      }

      if (update.path !== "/approvals") {
        return;
      }

      write({
        ts: new Date().toISOString(),
        actor: options.actor,
        kind: "approval_state",
        providerId: update.providerId,
        approvals: (update.tree?.children ?? []).map((child) => {
          const props = (child.properties ?? {}) as Record<string, unknown>;
          return {
            id: child.id,
            status: typeof props.status === "string" ? props.status : undefined,
            path: typeof props.path === "string" ? props.path : undefined,
            action: typeof props.action === "string" ? props.action : undefined,
            reason: typeof props.reason === "string" ? props.reason : undefined,
            paramsPreview:
              typeof props.params_preview === "string" ? props.params_preview : undefined,
            dangerous: typeof props.dangerous === "boolean" ? props.dangerous : undefined,
          };
        }),
      });
    },
    onExternalProviderStates: (states: ExternalProviderState[]) => {
      write({
        ts: new Date().toISOString(),
        actor: options.actor,
        kind: "providers",
        states: states.map((s) => ({ id: s.id, status: s.status, message: s.lastError })),
      });
    },
    onSchedulerEvent: (event: OrchestrationSchedulerEvent) => {
      write({
        ts: new Date().toISOString(),
        actor: options.actor,
        ...event,
      });
    },
  };

  return {
    callbacks,
    emit: write,
    stop() {
      stopped = true;
    },
  };
}

export function mergeCallbacks(a: AgentCallbacks, b: AgentCallbacks): AgentCallbacks {
  return {
    onText: chain(a.onText, b.onText),
    onToolCall: chain(a.onToolCall, b.onToolCall),
    onToolResult: chain(a.onToolResult, b.onToolResult),
    onToolEvent: chain(a.onToolEvent, b.onToolEvent),
    onExternalProviderStates: chain(a.onExternalProviderStates, b.onExternalProviderStates),
    onSchedulerEvent: chain(a.onSchedulerEvent, b.onSchedulerEvent),
    onProviderSnapshot: chain(a.onProviderSnapshot, b.onProviderSnapshot),
  };
}

function chain<T>(
  a: ((arg: T) => void) | undefined,
  b: ((arg: T) => void) | undefined,
): ((arg: T) => void) | undefined {
  if (!a) return b;
  if (!b) return a;
  return (arg: T) => {
    a(arg);
    b(arg);
  };
}

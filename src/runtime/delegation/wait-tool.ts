import type { SlopNode } from "@slop-ai/consumer/browser";

import type { LocalRuntimeTool, LocalRuntimeToolContext } from "../../core/loop";
import { LlmAbortError } from "../../llm/types";

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const STATE_CHANGE_WAIT_SLICE_MS = 30_000;

const WAIT_EVENT_TYPES = [
  "turn_idle",
  "completed",
  "failed",
  "cancelled",
  "closed",
  "approval_needed",
  "timeout",
] as const;

type WaitEventType = (typeof WAIT_EVENT_TYPES)[number];

const DEFAULT_EVENT_TYPES = new Set<WaitEventType>(WAIT_EVENT_TYPES);

type DelegationAgentSnapshot = {
  id: string;
  name?: string;
  status?: string;
  turn_state?: string;
  turn_phase?: string;
  result_preview?: string;
  error?: string;
  session_provider_id?: string;
  session_provider_closed?: boolean;
  completed_at?: string;
  pending_approvals: unknown[];
};

type WakeMatch = {
  eventType: WaitEventType;
  changedAgents: DelegationAgentSnapshot[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("agent_ids must be an array of delegation agent ids.");
  }

  const ids = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (ids.length === 0) {
    throw new Error("agent_ids must contain at least one delegation agent id.");
  }

  return [...new Set(ids)];
}

function parseTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("timeout_ms must be a finite number when provided.");
  }
  return Math.max(0, Math.floor(value));
}

function parseEventTypes(value: unknown): Set<WaitEventType> {
  if (value === undefined || value === null) {
    return new Set(DEFAULT_EVENT_TYPES);
  }
  if (!Array.isArray(value)) {
    throw new Error("event_types must be an array when provided.");
  }

  const parsed = new Set<WaitEventType>();
  for (const item of value) {
    if (typeof item !== "string" || !WAIT_EVENT_TYPES.includes(item as WaitEventType)) {
      throw new Error(`Unsupported delegation wait event type: ${String(item)}`);
    }
    parsed.add(item as WaitEventType);
  }

  return parsed.size > 0 ? parsed : new Set(DEFAULT_EVENT_TYPES);
}

function snapshotFromNode(node: SlopNode): DelegationAgentSnapshot {
  const props = isRecord(node.properties) ? node.properties : {};
  const pendingApprovals = Array.isArray(props.pending_approvals) ? props.pending_approvals : [];

  return {
    id: String(props.id ?? node.id),
    name: typeof props.name === "string" ? props.name : undefined,
    status: typeof props.status === "string" ? props.status : undefined,
    turn_state: typeof props.turn_state === "string" ? props.turn_state : undefined,
    turn_phase: typeof props.turn_phase === "string" ? props.turn_phase : undefined,
    result_preview: typeof props.result_preview === "string" ? props.result_preview : undefined,
    error: typeof props.error === "string" ? props.error : undefined,
    session_provider_id:
      typeof props.session_provider_id === "string" ? props.session_provider_id : undefined,
    session_provider_closed:
      typeof props.session_provider_closed === "boolean"
        ? props.session_provider_closed
        : undefined,
    completed_at: typeof props.completed_at === "string" ? props.completed_at : undefined,
    pending_approvals: pendingApprovals,
  };
}

function snapshotKey(snapshot: DelegationAgentSnapshot): string {
  return JSON.stringify(snapshot);
}

async function readAgentSnapshots(
  context: LocalRuntimeToolContext,
  agentIds: string[],
): Promise<Map<string, DelegationAgentSnapshot>> {
  const tree = await context.hub.queryState({
    providerId: "delegation",
    path: "/agents",
    depth: 2,
    maxNodes: Math.max(50, agentIds.length + 10),
  });
  const wanted = new Set(agentIds);
  const snapshots = new Map<string, DelegationAgentSnapshot>();

  for (const child of tree.children ?? []) {
    const snapshot = snapshotFromNode(child);
    if (wanted.has(snapshot.id)) {
      snapshots.set(snapshot.id, snapshot);
    }
  }

  const missing = agentIds.filter((id) => !snapshots.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown delegation agent id(s): ${missing.join(", ")}`);
  }

  return snapshots;
}

function classifySnapshot(
  snapshot: DelegationAgentSnapshot,
  allowedEventTypes: Set<WaitEventType>,
): WaitEventType | null {
  if (
    allowedEventTypes.has("approval_needed") &&
    (snapshot.pending_approvals.length > 0 || snapshot.turn_state === "waiting_approval")
  ) {
    return "approval_needed";
  }

  if (snapshot.status === "failed" && allowedEventTypes.has("failed")) {
    return "failed";
  }
  if (snapshot.status === "cancelled" && allowedEventTypes.has("cancelled")) {
    return "cancelled";
  }
  if (snapshot.status === "closed" && allowedEventTypes.has("closed")) {
    return "closed";
  }
  if (snapshot.status === "completed" && allowedEventTypes.has("completed")) {
    return "completed";
  }
  if (
    snapshot.turn_state === "idle" &&
    snapshot.status !== "pending" &&
    snapshot.status !== "running" &&
    allowedEventTypes.has("turn_idle")
  ) {
    return "turn_idle";
  }

  return null;
}

function findWakeMatch(
  previous: Map<string, DelegationAgentSnapshot> | null,
  current: Map<string, DelegationAgentSnapshot>,
  allowedEventTypes: Set<WaitEventType>,
): WakeMatch | null {
  const changedByEvent = new Map<WaitEventType, DelegationAgentSnapshot[]>();

  for (const [id, snapshot] of current) {
    const previousSnapshot = previous?.get(id);
    if (previous && previousSnapshot && snapshotKey(previousSnapshot) === snapshotKey(snapshot)) {
      continue;
    }

    const eventType = classifySnapshot(snapshot, allowedEventTypes);
    if (!eventType) {
      continue;
    }

    const bucket = changedByEvent.get(eventType) ?? [];
    bucket.push(snapshot);
    changedByEvent.set(eventType, bucket);
  }

  for (const eventType of WAIT_EVENT_TYPES) {
    const changedAgents = changedByEvent.get(eventType);
    if (changedAgents && changedAgents.length > 0) {
      return { eventType, changedAgents };
    }
  }

  return null;
}

function allSnapshots(snapshots: Map<string, DelegationAgentSnapshot>): DelegationAgentSnapshot[] {
  return [...snapshots.values()];
}

function buildWakeResult(
  eventType: WaitEventType,
  agentIds: string[],
  snapshots: Map<string, DelegationAgentSnapshot>,
  changedAgents: DelegationAgentSnapshot[],
  startedAt: number,
) {
  const elapsedMs = Date.now() - startedAt;

  return {
    status: "ok" as const,
    summary:
      eventType === "timeout"
        ? `Delegation wait timed out after ${elapsedMs}ms.`
        : `Delegation event ${eventType} for ${changedAgents.map((agent) => agent.id).join(", ")}.`,
    content: {
      status: "ok",
      data: {
        event_type: eventType,
        timed_out: eventType === "timeout",
        elapsed_ms: elapsedMs,
        agent_ids: agentIds,
        changed_agents: changedAgents,
        snapshots: allSnapshots(snapshots),
      },
    },
  };
}

async function waitForDelegationEvent(
  params: Record<string, unknown>,
  context: LocalRuntimeToolContext,
) {
  const agentIds = parseAgentIds(params.agent_ids);
  const timeoutMs = parseTimeoutMs(params.timeout_ms);
  const allowedEventTypes = parseEventTypes(params.event_types);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let previous: Map<string, DelegationAgentSnapshot> | null = null;

  for (;;) {
    if (context.signal?.aborted) {
      throw new LlmAbortError();
    }

    const revision = context.hub.getStateRevision();
    const current = await readAgentSnapshots(context, agentIds);
    const wake = findWakeMatch(previous, current, allowedEventTypes);
    if (wake) {
      return buildWakeResult(wake.eventType, agentIds, current, wake.changedAgents, startedAt);
    }

    previous = current;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return buildWakeResult("timeout", agentIds, current, [], startedAt);
    }

    const changed = await context.hub.waitForStateChange(revision, {
      timeoutMs: Math.min(STATE_CHANGE_WAIT_SLICE_MS, remainingMs),
      signal: context.signal,
    });
    if (context.signal?.aborted) {
      throw new LlmAbortError();
    }
    if (!changed && Date.now() >= deadline) {
      return buildWakeResult("timeout", agentIds, current, [], startedAt);
    }
  }
}

export function createDelegationWaitTool(): LocalRuntimeTool {
  return {
    providerId: "session",
    path: "/delegation",
    tool: {
      type: "function",
      function: {
        name: "slop_wait_for_delegation_event",
        description:
          "Park this turn until one watched child delegation agent changes state. Spawn children, do independent work, then use this instead of repeatedly querying delegation /agents. The result is one wake event; decide whether to wait again, send a follow-up, get results, approve/reject a child approval, or close the child. After retrieving a final result, close that child unless a follow-up is still needed.",
        parameters: {
          type: "object",
          properties: {
            agent_ids: {
              type: "array",
              items: { type: "string" },
              description: "Delegation agent ids to watch.",
            },
            timeout_ms: {
              type: "number",
              description: "Optional maximum wait in milliseconds. Defaults to 300000.",
            },
            event_types: {
              type: "array",
              items: {
                type: "string",
                enum: WAIT_EVENT_TYPES,
              },
              description:
                "Optional event types to wake on. Defaults to child idle/completed, failed/cancelled/closed, approval needed, and timeout.",
            },
          },
          required: ["agent_ids"],
          additionalProperties: false,
        },
      },
    },
    execute: waitForDelegationEvent,
  };
}

import {
  buildId,
  createExtensionRecord,
  now,
  type PluginRuntimeContext,
  type PluginTurnRequest,
  type SessionSnapshotRecoveryContext,
} from "../../../session/plugins";
import type {
  AgentSessionSnapshot,
  JsonObject,
  SessionGoalStatus,
  SessionGoalUpdateSource,
} from "../../../session/types";
import {
  GOAL_EXTENSION_NAMESPACE,
  GOAL_EXTENSION_OWNER,
  GOAL_EXTENSION_RETENTION_MS,
  GOAL_EXTENSION_SCHEMA_VERSION,
  goalFromExtension,
  selectGoalSnapshot,
} from "./goal-schema";

export const PERSISTENT_GOAL_PLUGIN_ID = "persistent-goal";
export const PERSISTENT_GOAL_SKILL_NAME = "persistent-goal";

const GOAL_RECOVERY_MESSAGE =
  "Goal paused after process restart because its in-flight turn could not be resumed.";

export type GoalStatusUpdate = {
  message?: string;
  evidence?: string[];
  source?: SessionGoalUpdateSource;
};

export function recoverGoalSnapshot(
  snapshot: AgentSessionSnapshot,
  context: SessionSnapshotRecoveryContext,
): AgentSessionSnapshot {
  const recovered = {
    ...snapshot,
    extensions: { ...(snapshot.extensions ?? {}) },
  };
  if (!context.hadInFlightTurn) {
    return recovered;
  }

  const goal = selectGoalSnapshot(recovered);
  if (goal?.status !== "active") {
    return recovered;
  }

  const extension = recovered.extensions[GOAL_EXTENSION_NAMESPACE];
  if (!extension || extension.instanceId !== goal.goalId) {
    return recovered;
  }

  extension.revision += 1;
  extension.updatedAt = context.restoredAt;
  extension.lastUsedAt = context.restoredAt;
  extension.state.status = "paused";
  extension.state.updatedAt = context.restoredAt;
  extension.state.message = GOAL_RECOVERY_MESSAGE;
  extension.state.updateSource = "runtime";
  recovered.goal = null;

  return recovered;
}

function renderGoalSkillSection(skillContent: string): string {
  return ["", "Loaded persistent-goal skill:", "", skillContent].join("\n");
}

export function buildGoalStartPrompt(objective: string, skillContent: string): string {
  return [
    "Start working toward this persistent session goal.",
    "",
    objective,
    "",
    "Continue until the objective is genuinely complete or you are blocked. Keep the core runtime lean: use existing SLOP provider state and affordances, and prefer reusable skill updates over hardcoded runtime policy when the work discovers a repeatable procedure.",
    "Use the slop_goal_update tool to report meaningful progress, blockers, or completion with concrete evidence.",
    renderGoalSkillSection(skillContent),
  ].join("\n");
}

export function buildGoalContinuationPrompt(
  goal: {
    objective: string;
    totalTokens: number;
    tokenBudget?: number;
  },
  skillContent: string,
): string {
  const budget =
    goal.tokenBudget === undefined
      ? "No token budget is configured."
      : `Token usage so far is ${goal.totalTokens}/${goal.tokenBudget}.`;
  return [
    "Continue the active persistent session goal from the current runtime state.",
    "",
    goal.objective,
    "",
    budget,
    "Use the slop_goal_update tool to report meaningful progress, blockers, or completion with concrete evidence. If the goal is now complete, mark it complete before your concise completion summary. If work remains, take the next concrete action. If you are blocked, report the blocker.",
    renderGoalSkillSection(skillContent),
  ].join("\n");
}

export function compactEvidence(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

function goalRunMetadata(goalId: string): Record<string, unknown> {
  return { goalId };
}

export function goalTurnRequest(options: {
  goalId: string;
  text: string;
  continuation: boolean;
}): PluginTurnRequest {
  return {
    pluginId: PERSISTENT_GOAL_PLUGIN_ID,
    runId: options.goalId,
    text: options.text,
    author: "goal",
    role: options.continuation ? "system" : "user",
    continuation: options.continuation,
    metadata: goalRunMetadata(options.goalId),
  };
}

export function createGoalState(
  ctx: PluginRuntimeContext,
  options: {
    objective: string;
    tokenBudget?: number;
    message?: string;
  },
): string {
  const goalId = buildId("goal");
  const state: JsonObject = {
    objective: options.objective,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    elapsedMs: 0,
    continuationCount: 0,
    message: options.message ?? "Goal active.",
  };
  if (options.tokenBudget !== undefined) {
    state.tokenBudget = options.tokenBudget;
  }

  const record = createExtensionRecord({
    namespace: GOAL_EXTENSION_NAMESPACE,
    instanceId: goalId,
    schemaVersion: GOAL_EXTENSION_SCHEMA_VERSION,
    owner: GOAL_EXTENSION_OWNER,
    state,
    cleanupPolicy: {
      mode: "ttl",
      ttlMs: GOAL_EXTENSION_RETENTION_MS,
      description:
        "clear_goal removes live state immediately; completed goals are retained briefly for audit.",
    },
  });
  record.state.createdAt = record.createdAt;
  record.state.updatedAt = record.updatedAt;
  ctx.store.upsertExtension(record);
  return goalId;
}

function normalizeGoalStatusUpdate(update?: string | GoalStatusUpdate): GoalStatusUpdate {
  if (typeof update === "string") {
    return { message: update };
  }
  return update ?? {};
}

function defaultGoalMessage(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "Goal active.";
    case "paused":
      return "Goal paused.";
    case "budget_limited":
      return "Goal paused after reaching its token budget.";
    case "complete":
      return "Goal complete.";
  }
}

export function updateGoalStatusState(
  ctx: PluginRuntimeContext,
  status: SessionGoalStatus,
  update?: string | GoalStatusUpdate,
  options?: { expectedGoalId?: string; expectedRevision?: number },
): void {
  const normalized = normalizeGoalStatusUpdate(update);
  ctx.store.patchExtension(
    GOAL_EXTENSION_NAMESPACE,
    (record) => {
      const updatedAt = now();
      record.state.status = status;
      record.state.updatedAt = updatedAt;
      record.state.message = normalized.message ?? defaultGoalMessage(status);
      if (normalized.evidence) {
        record.state.evidence = normalized.evidence;
      }
      if (normalized.source) {
        record.state.updateSource = normalized.source;
      }
      if (status === "complete") {
        record.state.completedAt = updatedAt;
        if (normalized.source) {
          record.state.completionSource = normalized.source;
        }
        record.lifecycle = "completed";
        record.retainUntil = new Date(
          Date.parse(updatedAt) + GOAL_EXTENSION_RETENTION_MS,
        ).toISOString();
      } else {
        delete record.state.completedAt;
        delete record.state.completionSource;
        record.lifecycle = "active";
        delete record.retainUntil;
      }
      return record;
    },
    {
      instanceId: options?.expectedGoalId,
      expectedRevision: options?.expectedRevision,
    },
  );
}

export function clearGoalState(ctx: PluginRuntimeContext): void {
  ctx.store.clearExtension(GOAL_EXTENSION_NAMESPACE);
}

export function accountGoalTurnState(
  ctx: PluginRuntimeContext,
  options: {
    turnId: string;
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    elapsedMs: number;
    continuation: boolean;
    usedTools: boolean;
  },
): void {
  const current = ctx.snapshot().goal;
  if (!current) {
    return;
  }

  ctx.store.patchExtension(GOAL_EXTENSION_NAMESPACE, (record) => {
    const goal = goalFromExtension(record);
    if (!goal) {
      return record;
    }
    const updatedAt = now();
    const inputTokens = goal.inputTokens + (options.inputTokens ?? 0);
    const outputTokens = goal.outputTokens + (options.outputTokens ?? 0);
    const thinkingTokens = (goal.thinkingTokens ?? 0) + (options.thinkingTokens ?? 0);
    record.state.inputTokens = inputTokens;
    record.state.outputTokens = outputTokens;
    record.state.thinkingTokens = thinkingTokens;
    record.state.totalTokens = inputTokens + outputTokens + thinkingTokens;
    record.state.elapsedMs = goal.elapsedMs + Math.max(0, Math.round(options.elapsedMs));
    record.state.lastTurnId = options.turnId;
    record.state.updatedAt = updatedAt;
    if (options.continuation) {
      record.state.continuationCount = goal.continuationCount + 1;
    }

    if (
      goal.status === "active" &&
      goal.tokenBudget &&
      inputTokens + outputTokens + thinkingTokens >= goal.tokenBudget
    ) {
      record.state.status = "budget_limited";
      record.state.message = "Goal stopped after reaching its token budget.";
    } else if (goal.status === "active" && options.continuation && !options.usedTools) {
      record.state.status = "paused";
      record.state.message =
        "Goal paused after a continuation turn completed without tool activity.";
    }

    return record;
  });
}

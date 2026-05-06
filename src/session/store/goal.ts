import type { SessionGoalStatus, SessionGoalUpdateSource } from "../types";
import { buildId, now } from "./helpers";
import type { SessionStoreState } from "./state";

type GoalStatusUpdate = {
  message?: string;
  evidence?: string[];
  source?: SessionGoalUpdateSource;
};

export function createGoal(
  state: SessionStoreState,
  options: {
    objective: string;
    tokenBudget?: number;
    message?: string;
  },
): string {
  const time = now();
  const goalId = buildId("goal");
  state.snapshot.goal = {
    goalId,
    objective: options.objective,
    status: "active",
    createdAt: time,
    updatedAt: time,
    tokenBudget: options.tokenBudget,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    elapsedMs: 0,
    continuationCount: 0,
    message: options.message ?? "Goal active.",
  };
  state.snapshot.session.lastActivityAt = time;
  state.goalChanged = true;
  state.sessionChanged = true;
  return goalId;
}

export function updateGoalStatus(
  state: SessionStoreState,
  status: SessionGoalStatus,
  update?: string | GoalStatusUpdate,
): void {
  const goal = state.snapshot.goal;
  if (!goal) {
    throw new Error("No active session goal.");
  }

  const normalized = normalizeGoalStatusUpdate(update);
  const time = now();
  goal.status = status;
  goal.updatedAt = time;
  goal.message = normalized.message ?? defaultGoalMessage(status);
  if (normalized.evidence) {
    goal.evidence = normalized.evidence;
  }
  if (normalized.source) {
    goal.updateSource = normalized.source;
  }
  if (status === "complete") {
    goal.completedAt = time;
    goal.completionSource = normalized.source;
  } else {
    delete goal.completedAt;
    delete goal.completionSource;
  }
  state.snapshot.session.lastActivityAt = time;
  state.goalChanged = true;
  state.sessionChanged = true;
}

export function clearGoal(state: SessionStoreState): void {
  if (!state.snapshot.goal) {
    return;
  }
  const time = now();
  state.snapshot.goal = null;
  state.snapshot.session.lastActivityAt = time;
  state.goalChanged = true;
  state.sessionChanged = true;
}

export function accountGoalTurn(
  state: SessionStoreState,
  options: {
    turnId: string;
    inputTokens?: number;
    outputTokens?: number;
    elapsedMs: number;
    continuation: boolean;
    usedTools: boolean;
  },
): void {
  const goal = state.snapshot.goal;
  if (!goal) {
    return;
  }

  const time = now();
  goal.inputTokens += options.inputTokens ?? 0;
  goal.outputTokens += options.outputTokens ?? 0;
  goal.totalTokens = goal.inputTokens + goal.outputTokens;
  goal.elapsedMs += Math.max(0, Math.round(options.elapsedMs));
  goal.lastTurnId = options.turnId;
  goal.updatedAt = time;
  if (options.continuation) {
    goal.continuationCount += 1;
  }

  if (goal.status === "active" && goal.tokenBudget && goal.totalTokens >= goal.tokenBudget) {
    goal.status = "budget_limited";
    goal.message = "Goal stopped after reaching its token budget.";
  } else if (goal.status === "active" && options.continuation && !options.usedTools) {
    goal.status = "paused";
    goal.message = "Goal paused after a continuation turn completed without tool activity.";
  }

  state.goalChanged = true;
}

function defaultGoalMessage(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "Goal active.";
    case "paused":
      return "Goal paused.";
    case "budget_limited":
      return "Goal stopped after reaching its token budget.";
    case "complete":
      return "Goal complete.";
  }
}

function normalizeGoalStatusUpdate(
  update: string | GoalStatusUpdate | undefined,
): GoalStatusUpdate {
  if (typeof update === "string") {
    return { message: update };
  }
  if (!update) {
    return {};
  }
  return {
    message: update.message,
    evidence: update.evidence?.filter((item) => item.trim().length > 0),
    source: update.source,
  };
}

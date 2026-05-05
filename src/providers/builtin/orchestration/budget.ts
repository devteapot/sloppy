import type { BudgetStatus, Plan, PlanBudget } from "./types";

export type RetryBudgetUsage = {
  retryAttemptsUsed?: number;
  retryOverBudgetSliceCount?: number;
  retryGateId?: string;
};

export type TokenCostBudgetUsage = {
  inputTokensUsed?: number;
  outputTokensUsed?: number;
  tokensUsed?: number;
  costUsdUsed?: number;
  tokenGateId?: string;
  costGateId?: string;
};

export function normalizePlanBudget(budget: PlanBudget | undefined): PlanBudget | undefined {
  if (!budget) {
    return undefined;
  }

  const normalized: PlanBudget = {};
  if (
    typeof budget.wall_time_ms === "number" &&
    Number.isFinite(budget.wall_time_ms) &&
    budget.wall_time_ms > 0
  ) {
    normalized.wall_time_ms = Math.floor(budget.wall_time_ms);
  }
  if (
    typeof budget.retries_per_slice === "number" &&
    Number.isFinite(budget.retries_per_slice) &&
    budget.retries_per_slice >= 0
  ) {
    normalized.retries_per_slice = Math.floor(budget.retries_per_slice);
  }
  if (
    typeof budget.token_limit === "number" &&
    Number.isFinite(budget.token_limit) &&
    budget.token_limit > 0
  ) {
    normalized.token_limit = Math.floor(budget.token_limit);
  }
  if (
    typeof budget.cost_usd === "number" &&
    Number.isFinite(budget.cost_usd) &&
    budget.cost_usd > 0
  ) {
    normalized.cost_usd = budget.cost_usd;
  }

  return normalized.wall_time_ms === undefined &&
    normalized.retries_per_slice === undefined &&
    normalized.token_limit === undefined &&
    normalized.cost_usd === undefined
    ? undefined
    : normalized;
}

export function normalizePlanBudgetInput(value: unknown): PlanBudget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const wallTime = record.wall_time_ms ?? record.wallTimeMs;
  const retriesPerSlice = record.retries_per_slice ?? record.retriesPerSlice;
  const tokenLimit = record.token_limit ?? record.tokenLimit ?? record.tokens;
  const costUsd = record.cost_usd ?? record.costUsd;
  return normalizePlanBudget({
    wall_time_ms: typeof wallTime === "number" ? wallTime : undefined,
    retries_per_slice: typeof retriesPerSlice === "number" ? retriesPerSlice : undefined,
    token_limit: typeof tokenLimit === "number" ? tokenLimit : undefined,
    cost_usd: typeof costUsd === "number" ? costUsd : undefined,
  });
}

export function buildBudgetStatus(
  plan: Plan | null,
  options: { nowMs?: number; gateId?: string } & RetryBudgetUsage & TokenCostBudgetUsage = {},
): BudgetStatus {
  const budget = normalizePlanBudget(plan?.budget);
  if (!plan || !budget) {
    return {
      configured: false,
      exceeded: false,
      exceeded_limits: [],
      message: "No budget policy configured for this plan.",
    };
  }

  const startedAt = Date.parse(plan.created_at);
  const nowMs = options.nowMs ?? Date.now();
  const elapsedWallTimeMs = Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : 0;
  const remainingWallTimeMs =
    budget.wall_time_ms !== undefined
      ? Math.max(0, budget.wall_time_ms - elapsedWallTimeMs)
      : undefined;
  const wallTimeExceeded =
    budget.wall_time_ms !== undefined ? elapsedWallTimeMs > budget.wall_time_ms : false;
  const retryLimit = budget.retries_per_slice;
  const retryAttemptsUsed = options.retryAttemptsUsed;
  const retryOverBudgetSliceCount = options.retryOverBudgetSliceCount ?? 0;
  const retryExceeded = retryOverBudgetSliceCount > 0 || options.retryGateId !== undefined;
  const inputTokensUsed = Math.max(0, Math.floor(options.inputTokensUsed ?? 0));
  const outputTokensUsed = Math.max(0, Math.floor(options.outputTokensUsed ?? 0));
  const tokensUsed = Math.max(
    0,
    Math.floor(options.tokensUsed ?? inputTokensUsed + outputTokensUsed),
  );
  const tokensRemaining =
    budget.token_limit !== undefined ? Math.max(0, budget.token_limit - tokensUsed) : undefined;
  const tokenExceeded =
    budget.token_limit !== undefined
      ? tokensUsed > budget.token_limit || options.tokenGateId !== undefined
      : false;
  const costUsdUsed = Math.max(0, options.costUsdUsed ?? 0);
  const costUsdRemaining =
    budget.cost_usd !== undefined ? Math.max(0, budget.cost_usd - costUsdUsed) : undefined;
  const costExceeded =
    budget.cost_usd !== undefined
      ? costUsdUsed > budget.cost_usd || options.costGateId !== undefined
      : false;
  const exceededLimits: Array<keyof PlanBudget> = [
    ...(wallTimeExceeded ? (["wall_time_ms"] as const) : []),
    ...(retryExceeded ? (["retries_per_slice"] as const) : []),
    ...(tokenExceeded ? (["token_limit"] as const) : []),
    ...(costExceeded ? (["cost_usd"] as const) : []),
  ];
  const messages: string[] = [];
  if (budget.wall_time_ms !== undefined) {
    messages.push(
      wallTimeExceeded
        ? `Wall-time budget exceeded by ${elapsedWallTimeMs - budget.wall_time_ms}ms.`
        : `Wall-time budget has ${remainingWallTimeMs ?? 0}ms remaining.`,
    );
  }
  if (retryLimit !== undefined) {
    messages.push(
      retryExceeded
        ? `${retryOverBudgetSliceCount || 1} slice retry budget violation${retryOverBudgetSliceCount === 1 ? "" : "s"} pending resolution.`
        : `Retry budget allows ${retryLimit} retries per slice; max used is ${retryAttemptsUsed ?? 0}.`,
    );
  }
  if (budget.token_limit !== undefined) {
    messages.push(
      tokenExceeded
        ? `Token budget exceeded by ${Math.max(0, tokensUsed - budget.token_limit)} tokens.`
        : `Token budget has ${tokensRemaining ?? 0} tokens remaining.`,
    );
  }
  if (budget.cost_usd !== undefined) {
    messages.push(
      costExceeded
        ? `Cost budget exceeded by $${Math.max(0, costUsdUsed - budget.cost_usd).toFixed(4)}.`
        : `Cost budget has $${(costUsdRemaining ?? 0).toFixed(4)} remaining.`,
    );
  }

  return {
    configured: true,
    exceeded: exceededLimits.length > 0,
    exceeded_limits: exceededLimits,
    wall_time_ms: budget.wall_time_ms,
    elapsed_wall_time_ms: elapsedWallTimeMs,
    remaining_wall_time_ms: remainingWallTimeMs,
    retries_per_slice: retryLimit,
    retry_attempts_used: retryAttemptsUsed,
    retry_over_budget_slice_count: retryOverBudgetSliceCount,
    retry_gate_id: options.retryGateId,
    token_limit: budget.token_limit,
    input_tokens_used: inputTokensUsed,
    output_tokens_used: outputTokensUsed,
    tokens_used: tokensUsed,
    tokens_remaining: tokensRemaining,
    token_gate_id: options.tokenGateId,
    cost_usd: budget.cost_usd,
    cost_usd_used: costUsdUsed,
    cost_usd_remaining: costUsdRemaining,
    cost_gate_id: options.costGateId,
    gate_id: options.gateId ?? options.retryGateId ?? options.tokenGateId ?? options.costGateId,
    message: messages.join(" "),
  };
}

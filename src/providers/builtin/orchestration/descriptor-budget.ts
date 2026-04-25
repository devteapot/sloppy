import { action, type ItemDescriptor } from "@slop-ai/server";

import { buildBudgetStatus } from "./budget";
import type { DescriptorWiring } from "./descriptor-wiring";
import { OPTIONAL_EXPECTED_VERSION_PARAM } from "./types";

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function buildBudgetDescriptor(wiring: DescriptorWiring) {
  const { repo, plans } = wiring;
  const plan = repo.loadPlan();
  const budget = buildBudgetStatus(plan, {
    ...repo.retryBudgetUsageForPlan(plan),
    ...repo.tokenCostBudgetUsageForPlan(plan),
  });
  const usage = repo.listBudgetUsageForPlan(plan);
  const items: ItemDescriptor[] = usage.map((record) => ({
    id: record.id,
    props: record,
    summary: `${record.source} usage: ${record.total_tokens} tokens${record.cost_usd !== undefined ? `, $${record.cost_usd.toFixed(4)}` : ""}`,
    meta: {
      salience: 0.45,
    },
  }));

  return {
    type: "collection",
    props: {
      plan_id: plan?.id,
      budget,
      usage_count: usage.length,
      tokens_used: budget.tokens_used,
      cost_usd_used: budget.cost_usd_used,
      exceeded: budget.exceeded,
      exceeded_limits: budget.exceeded_limits,
    },
    summary: budget.configured
      ? `Budget ${budget.exceeded ? "exceeded" : "within limits"}; ${usage.length} usage record${usage.length === 1 ? "" : "s"}.`
      : "No budget policy configured for the active plan.",
    actions:
      plan?.status === "active"
        ? {
            raise_budget_cap: action(
              {
                wall_time_ms: {
                  type: "number",
                  description: "Raised wall-time budget in milliseconds.",
                  optional: true,
                },
                retries_per_slice: {
                  type: "number",
                  description: "Raised retry budget per logical slice.",
                  optional: true,
                },
                token_limit: {
                  type: "number",
                  description: "Raised total token budget for recorded model usage.",
                  optional: true,
                },
                cost_usd: {
                  type: "number",
                  description: "Raised USD cost budget.",
                  optional: true,
                },
                resolve_gates: {
                  type: "boolean",
                  description: "Resolve covered open budget_exceeded gates after raising caps.",
                  optional: true,
                },
                resolution: {
                  type: "string",
                  description: "Optional resolution note for covered budget gates.",
                  optional: true,
                },
                expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
              },
              async ({
                wall_time_ms,
                retries_per_slice,
                token_limit,
                cost_usd,
                resolve_gates,
                resolution,
                expected_version,
              }) =>
                plans.raiseBudgetCap({
                  wall_time_ms: normalizeNumber(wall_time_ms),
                  retries_per_slice: normalizeNumber(retries_per_slice),
                  token_limit: normalizeNumber(token_limit),
                  cost_usd: normalizeNumber(cost_usd),
                  resolve_gates: normalizeBoolean(resolve_gates),
                  resolution: normalizeString(resolution),
                  expected_version:
                    typeof expected_version === "number" ? expected_version : undefined,
                }),
              {
                label: "Raise Budget Cap",
                description:
                  "Increase one or more active-plan budget caps and resolve covered budget gates.",
                estimate: "instant",
              },
            ),
          }
        : undefined,
    items,
    meta: {
      salience: budget.exceeded ? 0.9 : 0.45,
      urgency: budget.exceeded ? ("high" as const) : ("low" as const),
    },
  };
}

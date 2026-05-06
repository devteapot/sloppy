import type { TuiRoute } from "../slop/types";

export type LlmStatus = "ready" | "needs_credentials" | "unknown";

export type RouteReconcileInput = {
  currentRoute: TuiRoute;
  llmStatus: LlmStatus;
  firstStatusSeen: boolean;
  userNavigated: boolean;
};

export type RouteReconcileOutput = {
  route: TuiRoute;
  firstStatusSeen: boolean;
};

/**
 * Pure decision function for landing the user on `setup` exactly once when
 * the first non-`unknown` `/llm` snapshot arrives reporting `needs_credentials`.
 * Subsequent snapshots never override the current route, and an explicit user
 * navigation locks the route in regardless of LLM status.
 */
export function reconcileInitialRoute(input: RouteReconcileInput): RouteReconcileOutput {
  const { currentRoute, llmStatus, firstStatusSeen, userNavigated } = input;

  if (llmStatus === "unknown") {
    return { route: currentRoute, firstStatusSeen };
  }

  if (firstStatusSeen || userNavigated) {
    return { route: currentRoute, firstStatusSeen: true };
  }

  if (llmStatus === "needs_credentials") {
    return { route: "setup", firstStatusSeen: true };
  }

  return { route: currentRoute, firstStatusSeen: true };
}

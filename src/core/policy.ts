import type { SloppyConfig } from "../config/schema";

/**
 * Decision returned by an `InvokePolicy` for a given invocation. A policy may
 * allow the invocation, deny it outright with a reason, or require approval
 * before dispatching to the provider.
 */
export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "require_approval"; reason: string; dangerous?: boolean; paramsPreview?: string };

export interface InvokeContext {
  providerId: string;
  /** Affordance name relative to the path (e.g. "execute", "cd"). */
  action: string;
  /** SLOP path the affordance is being invoked on. */
  path: string;
  params: Record<string, unknown>;
  /** Optional id of the role driving this invocation (e.g. "orchestrator"). */
  roleId?: string;
  config: SloppyConfig;
}

/**
 * Per-invocation metadata threaded through `ConsumerHub.invoke` and forwarded
 * to policy rules via `InvokeContext`. Scoped per call (NOT hub-wide) so that
 * background callers like the orchestration scheduler, approval re-invokes,
 * or UI/dashboard calls do not inherit a previous caller's role/actor.
 */
export interface InvocationMetadata {
  /** Optional id of the role driving this invocation (e.g. "orchestrator"). */
  roleId?: string;
  /**
   * Optional free-form actor tag for telemetry (e.g. "scheduler", "ui").
   * Not consulted by current rules; reserved for future use.
   */
  actor?: string;
}

export interface InvokePolicy {
  evaluate(ctx: InvokeContext): PolicyDecision | Promise<PolicyDecision>;
}

const ALLOW: PolicyDecision = { kind: "allow" };

/**
 * The default hub policy: always allow. Used by `ConsumerHub` when no
 * application-level policy has been configured so existing call sites and
 * tests behave identically.
 */
export const allowAllPolicy: InvokePolicy = {
  evaluate() {
    return ALLOW;
  },
};

/**
 * Composes an ordered list of `InvokePolicy` rules. Returns the first
 * non-`allow` decision; if all rules allow, the composite allows. Rules can
 * be added incrementally via `add` to support extensions that register their
 * own policies at runtime (e.g. role-scoped rules).
 */
export class CompositePolicy implements InvokePolicy {
  private rules: InvokePolicy[];

  constructor(rules: InvokePolicy[] = []) {
    this.rules = [...rules];
  }

  add(rule: InvokePolicy): void {
    this.rules.push(rule);
  }

  remove(rule: InvokePolicy): void {
    const idx = this.rules.indexOf(rule);
    if (idx >= 0) {
      this.rules.splice(idx, 1);
    }
  }

  async evaluate(ctx: InvokeContext): Promise<PolicyDecision> {
    for (const rule of this.rules) {
      const decision = await rule.evaluate(ctx);
      if (decision.kind !== "allow") {
        return decision;
      }
    }
    return ALLOW;
  }
}

/**
 * Error thrown by `ConsumerHub.invoke` when a policy denies the call. Carries
 * a stable `code` so the run loop and tooling can recognize policy denials
 * separately from arbitrary provider errors.
 */
export class PolicyDeniedError extends Error {
  readonly code = "policy_denied";
  constructor(message: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

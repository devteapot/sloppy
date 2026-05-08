import type { InvokeContext, InvokePolicy, PolicyDecision } from "../policy";

const ALLOW: PolicyDecision = { kind: "allow" };

/**
 * Auto-elevates any affordance whose action descriptor is marked
 * `dangerous: true` to require_approval. Consults a hub-owned registry that
 * accumulates `dangerous` flags from every subscribed tree the hub has ever
 * seen — so unfocused / deep affordances are still policed, not just those
 * that happen to be in the currently-focused subtree at the moment of
 * invocation.
 */
export function dangerousActionRule(
  isDangerous: (providerId: string, path: string, action: string) => boolean,
): InvokePolicy {
  return {
    evaluate(ctx: InvokeContext): PolicyDecision {
      if (ctx.preApproved) {
        return ALLOW;
      }
      if (!isDangerous(ctx.providerId, ctx.path, ctx.action)) {
        return ALLOW;
      }
      return {
        kind: "require_approval",
        reason: `Action ${ctx.providerId}:${ctx.action} on ${ctx.path} is marked dangerous.`,
        dangerous: true,
        paramsPreview: safePreview(ctx.params),
      };
    },
  };
}

function safePreview(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params);
  } catch {
    return "[unserializable params]";
  }
}

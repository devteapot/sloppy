import type { InvokeContext, InvokePolicy, PolicyDecision } from "./policy";

export type RuntimeCapabilityMask = {
  id: string;
  provider?: string;
  path?: string;
  actions?: string[];
  mode: "allow" | "deny";
};

const ALLOW: PolicyDecision = { kind: "allow" };

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function pathMatches(maskPath: string | undefined, invocationPath: string): boolean {
  if (!maskPath) return true;
  const normalizedMask = normalizePath(maskPath);
  const normalizedInvocation = normalizePath(invocationPath);
  return (
    normalizedInvocation === normalizedMask ||
    normalizedInvocation.startsWith(`${normalizedMask.replace(/\/$/, "")}/`)
  );
}

function maskMatches(mask: RuntimeCapabilityMask, ctx: InvokeContext): boolean {
  if (mask.provider && mask.provider !== ctx.providerId) return false;
  if (!pathMatches(mask.path, ctx.path)) return false;
  if (mask.actions && !mask.actions.includes(ctx.action)) return false;
  return true;
}

function describe(mask: RuntimeCapabilityMask): string {
  const provider = mask.provider ?? "*";
  const path = mask.path ?? "/*";
  const actions = mask.actions?.join(",") ?? "*";
  return `${provider}:${actions} ${path}`;
}

export function capabilityMaskRule(masks: RuntimeCapabilityMask[]): InvokePolicy {
  const denyMasks = masks.filter((mask) => mask.mode === "deny");
  const allowMasks = masks.filter((mask) => mask.mode === "allow");

  return {
    evaluate(ctx: InvokeContext): PolicyDecision {
      const deny = denyMasks.find((mask) => maskMatches(mask, ctx));
      if (deny) {
        return {
          kind: "deny",
          reason: `Capability mask ${deny.id} denies ${ctx.providerId}:${ctx.action} on ${ctx.path}.`,
        };
      }

      if (allowMasks.length === 0) {
        return ALLOW;
      }

      if (allowMasks.some((mask) => maskMatches(mask, ctx))) {
        return ALLOW;
      }

      return {
        kind: "deny",
        reason: `No capability mask allows ${ctx.providerId}:${ctx.action} on ${ctx.path}. Active allow masks: ${allowMasks
          .map(describe)
          .join("; ")}.`,
      };
    },
  };
}

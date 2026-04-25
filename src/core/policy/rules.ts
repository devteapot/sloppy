import type { SlopNode } from "@slop-ai/consumer/browser";

import type { ProviderTreeView } from "../subscriptions";
import type { InvokeContext, InvokePolicy, PolicyDecision } from "../policy";

const ALLOW: PolicyDecision = { kind: "allow" };

/**
 * Canonical destructive-command heuristic for shell `execute` invocations.
 * Evaluated at the `ConsumerHub` boundary by `terminalSafetyRule`; the
 * terminal provider no longer mirrors this check inline (the rule is the
 * single source of truth).
 */
const DESTRUCTIVE_COMMAND_RE =
  /(?:^|\s|&&|\|\||;)(rm\s|rmdir\s|mv\s|git\s+(?:reset|clean|checkout)\s|sed\s+-i|truncate\s|dd\s|shred\s)/;
const FILE_OUTPUT_REDIRECT_RE = /(^|[^>])(?:\d?>|&>)(?![>&])\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;

function usesFileOutputRedirection(command: string): boolean {
  FILE_OUTPUT_REDIRECT_RE.lastIndex = 0;
  for (const match of command.matchAll(FILE_OUTPUT_REDIRECT_RE)) {
    const rawTarget = match[2]?.trim() ?? "";
    const target = rawTarget.replace(/^["']|["']$/g, "");
    if (target !== "/dev/null") {
      return true;
    }
  }
  return false;
}

function describeTerminalReason(command: string): string {
  const reasons: string[] = [];
  if (DESTRUCTIVE_COMMAND_RE.test(command)) {
    reasons.push("matches a destructive shell command pattern");
  }
  if (usesFileOutputRedirection(command)) {
    reasons.push("uses file output redirection");
  }
  return `Shell command requires approval because it ${reasons.join(" and ")}.`;
}

export const terminalSafetyRule: InvokePolicy = {
  evaluate(ctx: InvokeContext): PolicyDecision {
    if (ctx.providerId !== "terminal" || ctx.action !== "execute") {
      return ALLOW;
    }
    const command = typeof ctx.params.command === "string" ? ctx.params.command : "";
    if (typeof ctx.params.confirmed === "boolean" && ctx.params.confirmed) {
      return ALLOW;
    }
    if (!DESTRUCTIVE_COMMAND_RE.test(command) && !usesFileOutputRedirection(command)) {
      return ALLOW;
    }
    return {
      kind: "require_approval",
      reason: describeTerminalReason(command),
      dangerous: true,
      paramsPreview: JSON.stringify({
        command,
        background: Boolean(ctx.params.background),
      }),
    };
  },
};

const ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS = new Set([
  "write",
  "edit",
  "mkdir",
  "delete",
  "remove",
  "move",
  "copy",
]);

const ORCHESTRATOR_SAFE_TERMINAL_COMMANDS = [
  /^npm run (build|lint|test|typecheck)$/,
  /^npm test$/,
  /^bun run (build|lint|test|typecheck)$/,
  /^bun test(?: .*)?$/,
  /^tsc(?: -b| --noEmit)?$/,
  /^vite build$/,
];

/**
 * Hub-layer mirror of `orchestratorToolPolicy` (in
 * `src/runtime/orchestration/tool-policy.ts`). Activated only when the run
 * loop tags the invocation with `roleId === "orchestrator"`.
 *
 * Migration note: until the run loop is updated to call
 * `hub.setInvocationMetadata({ roleId })` per turn, the legacy `RoleProfile.toolPolicy`
 * hook remains the live enforcement path. This rule is a drop-in replacement
 * that the orchestration extension installs via `hub.addPolicyRule(...)`. When
 * the metadata wiring is in place, delete `orchestratorToolPolicy` from the
 * RoleProfile and rely on this rule alone.
 */
export const orchestratorRoleRule: InvokePolicy = {
  evaluate(ctx: InvokeContext): PolicyDecision {
    if (ctx.roleId !== "orchestrator") {
      return ALLOW;
    }

    if (
      ctx.providerId === "filesystem" &&
      ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS.has(ctx.action)
    ) {
      return {
        kind: "deny",
        reason: `Orchestrator mode cannot call filesystem.${ctx.action} directly. Create or retry a delegated task with spawn_agent so a sub-agent performs file mutations.`,
      };
    }

    if (ctx.providerId === "delegation" && ctx.action === "spawn_agent") {
      return {
        kind: "deny",
        reason: `Orchestrator mode does not spawn delegation agents directly. Create or retry orchestration tasks; the runtime scheduler starts ready tasks when dependencies and capacity allow.`,
      };
    }

    if (ctx.providerId === "terminal" && ctx.action === "execute") {
      const command =
        typeof ctx.params.command === "string" ? ctx.params.command.trim() : "";
      const safe = ORCHESTRATOR_SAFE_TERMINAL_COMMANDS.some((p) => p.test(command));
      if (!safe) {
        return {
          kind: "deny",
          reason: `Orchestrator mode can only run simple verification commands directly (build, lint, test, typecheck). Delegate setup, install, repair, and shell-composed commands to a sub-agent.`,
        };
      }
    }

    return ALLOW;
  },
};

/**
 * Auto-elevates any affordance whose action descriptor is marked
 * `dangerous: true` to require_approval. Requires a callback that returns the
 * current provider tree views so the rule can look up the descriptor for the
 * (providerId, path, action) tuple at evaluation time.
 */
export function dangerousActionRule(
  getViews: () => ProviderTreeView[],
): InvokePolicy {
  return {
    evaluate(ctx: InvokeContext): PolicyDecision {
      if (typeof ctx.params.confirmed === "boolean" && ctx.params.confirmed) {
        return ALLOW;
      }
      const views = getViews();
      const view = views.find((v) => v.providerId === ctx.providerId);
      if (!view) {
        return ALLOW;
      }
      const descriptor = findActionDescriptor(view, ctx.path, ctx.action);
      if (descriptor?.dangerous) {
        return {
          kind: "require_approval",
          reason: `Action ${ctx.providerId}:${ctx.action} on ${ctx.path} is marked dangerous.`,
          dangerous: true,
          paramsPreview: safePreview(ctx.params),
        };
      }
      return ALLOW;
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

function findActionDescriptor(
  view: ProviderTreeView,
  path: string,
  action: string,
): { dangerous?: boolean } | null {
  const node = locateNode(view, path);
  if (!node) {
    return null;
  }
  const affordances = node.affordances;
  if (!Array.isArray(affordances)) {
    return null;
  }
  const found = affordances.find((aff) => aff.action === action);
  return found ? { dangerous: found.dangerous } : null;
}

function locateNode(view: ProviderTreeView, path: string): SlopNode | null {
  // Try the focused detail tree first, since it's typically deeper and the
  // most likely to carry the affordance descriptor for the path being
  // invoked. Fall back to the overview tree.
  const segments = path.replace(/^\//, "").split("/").filter(Boolean);
  if (view.detailTree && view.detailPath) {
    const detailSegments = view.detailPath.replace(/^\//, "").split("/").filter(Boolean);
    if (
      segments.length >= detailSegments.length &&
      detailSegments.every((seg, idx) => segments[idx] === seg)
    ) {
      const remainder = segments.slice(detailSegments.length);
      const node = walkSegments(view.detailTree, remainder);
      if (node) {
        return node;
      }
    }
  }
  return walkSegments(view.overviewTree, segments);
}

function walkSegments(root: SlopNode, segments: string[]): SlopNode | null {
  let node: SlopNode | null = root;
  for (const segment of segments) {
    if (!node?.children) {
      return null;
    }
    const next: SlopNode | undefined = node.children.find((child) => child.id === segment);
    if (!next) {
      return null;
    }
    node = next;
  }
  return node;
}

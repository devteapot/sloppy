import type { ProviderTreeView } from "../subscriptions";
import type { InvokeContext, InvokePolicy, PolicyDecision } from "../policy";

const ALLOW: PolicyDecision = { kind: "allow" };

/**
 * Mirror of the regexes embedded in `src/providers/builtin/terminal.ts`. Kept
 * here so the same destructive-command heuristic can be evaluated at the
 * `ConsumerHub` boundary without depending on the provider implementation.
 *
 * Migration note: today the terminal provider still owns destructive-command
 * approvals via `ProviderApprovalManager`. When the hub-owned approval queue
 * lands, install `terminalSafetyRule` on the hub and remove the in-provider
 * checks (`looksDestructive`, `runSyncCommand`/`startBackgroundCommand`
 * gating) so the rule isn't evaluated twice.
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
 *
 * Migration note: not installed by default. Once a hub-owned approval queue
 * is in place, install this rule and remove per-provider `dangerous: true`
 * gates that today rely on `ProviderApprovalManager`. Until then, providers
 * still own their own approval flows.
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
      // Walking the SLOP overview tree to locate (path, action) is provider-
      // shape-specific and best done lazily; for now we conservatively allow
      // when the descriptor isn't found in the cached overview, deferring to
      // the provider's own dangerous handling.
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
  _path: string,
  _action: string,
): { dangerous?: boolean } | null {
  // Placeholder: a future iteration should walk view.overviewTree (and
  // view.detailTree when present) to find the matching action descriptor.
  // Current SLOP node shapes don't expose action metadata directly in the
  // overview tree, so locating the descriptor requires either a richer hub-
  // side cache or a one-shot consumer.query at evaluation time. Returning
  // null today means the dangerous-flag rule is a no-op; per-provider
  // `dangerous: true` markers continue to drive their existing approval
  // flows. See the migration note on `dangerousActionRule`.
  void view;
  return null;
}

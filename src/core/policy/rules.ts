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
// File-clobbering redirects: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`. The leading
// `(?:^|[^>&])` ensures we don't double-count the second `>` in `>>` and that
// we don't misread `2>&1` (where the target is a file descriptor, not a file).
// The target excludes `>` so a stray `>>` operator can't itself match as one.
const FILE_OUTPUT_REDIRECT_RE = /(?:^|[^>&])(?:\d?>{1,2}|&>{1,2})\s*("[^"]+"|'[^']+'|[^\s;&|>]+)/g;
// `tee` (with or without flags) writes to one or more files; treat any target
// other than `/dev/null` as a write that needs approval.
const TEE_WRITE_RE = /(?:^|[\s;&|])tee\b(?:\s+-[a-zA-Z]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;

function writesToNonNullTarget(command: string, regex: RegExp): boolean {
  regex.lastIndex = 0;
  for (const match of command.matchAll(regex)) {
    const rawTarget = match[1]?.trim() ?? "";
    const target = rawTarget.replace(/^["']|["']$/g, "");
    if (target !== "/dev/null") {
      return true;
    }
  }
  return false;
}

function usesFileOutputRedirection(command: string): boolean {
  return writesToNonNullTarget(command, FILE_OUTPUT_REDIRECT_RE);
}

function usesTeeWrite(command: string): boolean {
  return writesToNonNullTarget(command, TEE_WRITE_RE);
}

function describeTerminalReason(command: string): string {
  const reasons: string[] = [];
  if (DESTRUCTIVE_COMMAND_RE.test(command)) {
    reasons.push("matches a destructive shell command pattern");
  }
  if (usesFileOutputRedirection(command)) {
    reasons.push("uses file output redirection");
  }
  if (usesTeeWrite(command)) {
    reasons.push("pipes to `tee` writing a file");
  }
  return `Shell command requires approval because it ${reasons.join(" and ")}.`;
}

export const terminalSafetyRule: InvokePolicy = {
  evaluate(ctx: InvokeContext): PolicyDecision {
    if (ctx.providerId !== "terminal" || ctx.action !== "execute") {
      return ALLOW;
    }
    const command = typeof ctx.params.command === "string" ? ctx.params.command : "";
    if (ctx.preApproved) {
      return ALLOW;
    }
    if (
      !DESTRUCTIVE_COMMAND_RE.test(command) &&
      !usesFileOutputRedirection(command) &&
      !usesTeeWrite(command)
    ) {
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

    if (ctx.providerId === "filesystem" && ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS.has(ctx.action)) {
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
      const command = typeof ctx.params.command === "string" ? ctx.params.command.trim() : "";
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

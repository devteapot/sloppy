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

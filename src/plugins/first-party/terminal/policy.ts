import type { InvokeContext, InvokePolicy, PolicyDecision } from "../../../core/policy";

const ALLOW: PolicyDecision = { kind: "allow" };

const DESTRUCTIVE_COMMAND_RE =
  /(?:^|\s|&&|\|\||;)(rm\s|rmdir\s|mv\s|chmod\s|chown\s|chgrp\s|git\s+(?:reset|clean|checkout|restore)\s|sed\s+-i|truncate\s|dd\s|shred\s|rsync\s+[^;&|]*--delete\b|find\s+[^;&|]*\s-delete\b)/;
const FILE_OUTPUT_REDIRECT_RE = /(?:^|[^>&])(?:\d?>{1,2}|&>{1,2})\s*("[^"]+"|'[^']+'|[^\s;&|>]+)/g;
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

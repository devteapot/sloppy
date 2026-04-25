import { normalizeReference } from "./normalization";
import type { AcceptanceCriterion, TaskStatus } from "./types";

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeReference(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

export function failureClass(error: string): string {
  const firstLine = error.trim().split("\n")[0] ?? "failure";
  const prefix = firstLine.split(":")[0]?.trim().toLowerCase();
  return prefix?.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "failure";
}

export function terminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "superseded"
  );
}

export function deriveAcceptanceCriteria(goal: string): string[] {
  const matches = [...goal.matchAll(/(?:^|\s)(\d+)[.)]\s+/g)];
  if (matches.length < 2) {
    return [];
  }

  const criteria: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? goal.length;
    const text = goal.slice(start, end).trim().replace(/\s+/g, " ");
    if (text.length > 0) {
      criteria.push(text);
    }
  }

  return criteria.slice(0, 12);
}

export function buildAcceptanceCriteria(goal: string, explicit?: string[]): AcceptanceCriterion[] {
  const source = explicit && explicit.length > 0 ? explicit : deriveAcceptanceCriteria(goal);
  return uniqueStrings(source)
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((text, index) => ({
      id: `ac-${index + 1}`,
      text,
    }));
}

// Deterministic irreversibility heuristics. Matches command text from EvidenceClaim
// checks; the executor can still declare additional irreversible actions explicitly.
// Patterns are conservative — false positives force a user gate, which is the safe
// failure mode in autonomous mode.
const IRREVERSIBLE_COMMAND_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+push\s+(?:[^\n]*\s)?(?:--force|-f)\b/i, label: "git push --force" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: "git reset --hard" },
  { pattern: /\brm\s+-rf?\b/i, label: "rm -rf" },
  { pattern: /\b(?:npm|bun|yarn|pnpm)\s+publish\b/i, label: "package publish" },
  { pattern: /\bdrop\s+table\b/i, label: "drop table" },
  { pattern: /\btruncate\s+table\b/i, label: "truncate table" },
  { pattern: /\bdelete\s+from\b/i, label: "delete from" },
  { pattern: /\bkubectl\s+delete\b/i, label: "kubectl delete" },
  { pattern: /\bterraform\s+(?:apply|destroy)\b/i, label: "terraform apply/destroy" },
];

export function classifyIrreversibleCommand(command: string): string | undefined {
  if (!command) return undefined;
  for (const { pattern, label } of IRREVERSIBLE_COMMAND_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return undefined;
}

export function looksLikeFileEvidenceRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.includes("://")) return false;
  return trimmed.includes("/") || /\.[a-z0-9]+$/i.test(trimmed);
}

export function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

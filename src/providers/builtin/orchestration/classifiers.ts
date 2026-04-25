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

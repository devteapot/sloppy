import { normalizeReference } from "./normalization";
import type { AcceptanceCriterion, CreateTaskParams, TaskStatus } from "./types";

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

function taskSearchText(task: Pick<CreateTaskParams, "name" | "goal" | "client_ref">): string {
  return `${task.name} ${task.goal} ${task.client_ref ?? ""}`.toLowerCase();
}

function hasTerm(text: string, terms: RegExp[]): boolean {
  return terms.some((term) => term.test(text));
}

export function isDocumentationTask(
  task: Pick<CreateTaskParams, "name" | "goal" | "client_ref">,
): boolean {
  return hasTerm(taskSearchText(task), [
    /\breadme\b/,
    /\bdocs?\b/,
    /\bdocumentation\b/,
    /\busage guide\b/,
    /\bsetup instructions\b/,
  ]);
}

export function isVerificationTask(
  task: Pick<CreateTaskParams, "name" | "goal" | "client_ref">,
): boolean {
  const text = taskSearchText(task);
  return hasTerm(text, [
    /\bverify\b/,
    /\bverification\b/,
    /\bvalidate\b/,
    /\bsmoke\b/,
    /\btest suite\b/,
    /\blint\b/,
    /\btypecheck\b/,
    /\bbuild passes\b/,
    /\bbuild verification\b/,
    /\brun (?:npm|bun|pnpm|yarn) (?:run )?build\b/,
  ]);
}

export function isScaffoldTask(
  task: Pick<CreateTaskParams, "name" | "goal" | "client_ref">,
): boolean {
  return hasTerm(taskSearchText(task), [
    /\bscaffold\b/,
    /\bbootstrap\b/,
    /\binitiali[sz]e\b/,
    /\bsetup project\b/,
    /\bcreate (?:a |the )?(?:vite|react|next|node|bun|typescript).*project\b/,
    /\bproject structure\b/,
  ]);
}

export function isDataModelTask(
  task: Pick<CreateTaskParams, "name" | "goal" | "client_ref">,
): boolean {
  return hasTerm(taskSearchText(task), [
    /\bdata model\b/,
    /\bseed data\b/,
    /\bschema\b/,
    /\btypes?\b/,
    /\bstore\b/,
    /\bstate management\b/,
    /\bcontext\b/,
  ]);
}

export function isUiTask(task: Pick<CreateTaskParams, "name" | "goal" | "client_ref">): boolean {
  return hasTerm(taskSearchText(task), [
    /\bui\b/,
    /\bfrontend\b/,
    /\bcomponents?\b/,
    /\bviews?\b/,
    /\bscreens?\b/,
    /\blayout\b/,
    /\bboard\b/,
    /\bcards?\b/,
    /\bforms?\b/,
  ]);
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

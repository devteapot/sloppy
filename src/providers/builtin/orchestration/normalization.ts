import type {
  AuditFindingRecommendation,
  AuditFindingSeverity,
  CreateTaskParams,
  HandoffKind,
  HandoffPriority,
  TaskKind,
  VerificationStatus,
} from "./types";

export function normalizeVerificationStatus(value: unknown): VerificationStatus {
  return value === "passed" ||
    value === "failed" ||
    value === "skipped" ||
    value === "not_required" ||
    value === "unknown"
    ? value
    : "unknown";
}

export function normalizeReference(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function normalizeTaskKind(value: unknown): TaskKind | undefined {
  switch (value) {
    case "implementation":
    case "audit":
    case "repair":
    case "docs":
    case "verification":
      return value;
    default:
      return undefined;
  }
}

export function normalizeFindingSeverity(value: unknown): AuditFindingSeverity {
  switch (value) {
    case "warning":
    case "note":
      return value;
    default:
      return "blocking";
  }
}

export function normalizeFindingRecommendation(value: unknown): AuditFindingRecommendation {
  switch (value) {
    case "spec_change":
    case "accept_deviation":
      return value;
    default:
      return "repair";
  }
}

export function normalizeHandoffKind(value: unknown): HandoffKind | undefined {
  switch (value) {
    case "question":
    case "artifact_request":
    case "review_request":
    case "decision_request":
    case "dependency_signal":
      return value;
    default:
      return undefined;
  }
}

export function normalizeHandoffPriority(value: unknown): HandoffPriority | undefined {
  switch (value) {
    case "low":
    case "normal":
    case "high":
      return value;
    default:
      return undefined;
  }
}

export function parseTaskArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as { tasks?: unknown }).tasks;
  return Array.isArray(nested) ? nested : null;
}

export function parseJsonTaskArrayString(value: string): unknown[] | null {
  let trimmed = value.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    trimmed = fenced[1].trim();
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const parsedArray = parseTaskArray(parsed);
    if (parsedArray) return parsedArray;
  } catch {
    // Fall through to best-effort bracket extraction below.
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return parseTaskArray(parsed);
  } catch {
    return null;
  }
}

export function normalizeTaskList(value: unknown): CreateTaskParams[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseJsonTaskArrayString(value)
      : parseTaskArray(value);

  if (!source) {
    return [];
  }

  return source
    .filter((task): task is Record<string, unknown> => {
      return task !== null && typeof task === "object" && !Array.isArray(task);
    })
    .map((task) => ({
      name: typeof task.name === "string" ? task.name : "",
      goal: typeof task.goal === "string" ? task.goal : "",
      kind: normalizeTaskKind(task.kind),
      client_ref: typeof task.client_ref === "string" ? task.client_ref : undefined,
      depends_on: normalizeStringList(task.depends_on),
      spec_refs: normalizeStringList(task.spec_refs),
      audit_of: typeof task.audit_of === "string" ? task.audit_of : undefined,
      finding_refs: normalizeStringList(task.finding_refs),
      acceptance_criteria: normalizeStringList(task.acceptance_criteria),
    }))
    .filter((task) => task.name.trim().length > 0 && task.goal.trim().length > 0);
}

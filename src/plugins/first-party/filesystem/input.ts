import type { RangeEdit } from "./model";

export const WORKSPACE_FILE_PATH_DESCRIPTION =
  "File path relative to the filesystem workspace root, e.g. 'todo-app/src/App.jsx'. Put this path at the top level of the tool arguments, not inside edits[]. Required.";

export const WORKSPACE_DIRECTORY_PATH_DESCRIPTION =
  "Directory path relative to the filesystem workspace root, e.g. 'todo-app' or 'todo-app/src'. Do not include the workspace directory name; paths like '.sloppy-demo/todo-app' are normalized when possible but 'todo-app' is preferred.";

export const EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    oldText: {
      type: "string",
      description:
        "Exact text to replace. Must appear exactly once in the original file. Include enough surrounding context to make it unique.",
    },
    newText: {
      type: "string",
      description: "Replacement text.",
    },
  },
  required: ["oldText", "newText"],
  additionalProperties: false,
};

export const EDITS_DESCRIPTION =
  'One or more targeted replacements. Use edit for small unique string or intra-line replacements. If replacing whole lines or blocks from a read that returned source_version, prefer edit_range. Each item must be exactly { oldText, newText }. Do not put path inside each edit; for workspace-level edit, path is a top-level argument. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally, so reason about each edit independently. (4) Keep each oldText as small as possible while still unique -- do not quote the whole function. (5) If two changes touch the same block or adjacent lines, merge them into a single edit rather than emitting overlapping ones. Example: {"path":"src/App.jsx","edits":[{"oldText":"const title = \'Old\';","newText":"const title = \'New\';"}],"expected_version":3}. Errors return { error, edit_index } identifying the offending edit.';

export const ENTRY_EDITS_DESCRIPTION =
  "One or more targeted replacements. Use edit for small unique string or intra-line replacements. If replacing whole lines or blocks from a read that returned source_version, prefer edit_range. This per-file action already targets the file, so each item must be exactly { oldText, newText } and must not include a path. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally. (4) Keep each oldText as small as possible while still unique. Errors return { error, edit_index } identifying the offending edit.";

export const RANGE_EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    start_line: {
      type: "number",
      description: "1-based first line in the range to replace.",
    },
    end_line: {
      type: "number",
      description: "1-based final line in the range to replace, inclusive.",
    },
    new_text: {
      type: "string",
      description:
        "Replacement text for the line range. Empty string deletes the range. Do not add a trailing newline unless you intentionally want an extra blank line before the following file line.",
    },
  },
  required: ["start_line", "end_line", "new_text"],
  additionalProperties: false,
};

export const RANGE_EDITS_DESCRIPTION =
  "One or more line-range replacements against a source_version returned by a prior read. Use edit_range when replacing whole lines or blocks and you already know the line numbers from the observed file view. The provider remembers the old line text it returned, validates that the current file still has the same text at those lines, and rejects with range_conflict if the view is stale. This avoids echoing oldText or model-visible hashes while still preventing wrong-place edits.";

export const ENTRY_RANGE_EDITS_DESCRIPTION =
  "One or more line-range replacements against a source_version returned by a prior read of this file. The provider remembers the old line text it returned, validates that the current file still has the same text at those lines, and rejects with range_conflict if the view is stale. Use expected_version only when whole-file CAS is required.";

export function invalidInput(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = "invalid_input";
  return error;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(
      `${name} must be a non-empty string relative to the filesystem workspace root.`,
    );
  }
  return value;
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw invalidInput(`${name} must be a string.`);
  }
  return value;
}

export function coerceEdits(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<{ oldText: string; newText: string }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const { oldText, newText } = raw as { oldText?: unknown; newText?: unknown };
    if (typeof oldText !== "string" || typeof newText !== "string") {
      continue;
    }
    out.push({ oldText, newText });
  }
  return out;
}

export function coerceRangeEdits(value: unknown): RangeEdit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: RangeEdit[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const { start_line, end_line, new_text } = raw as {
      start_line?: unknown;
      end_line?: unknown;
      new_text?: unknown;
    };
    if (
      typeof start_line !== "number" ||
      typeof end_line !== "number" ||
      typeof new_text !== "string"
    ) {
      continue;
    }
    out.push({
      startLine: start_line,
      endLine: end_line,
      newText: new_text,
    });
  }
  return out;
}

function pathFromNestedEdits(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const paths = value
    .map((edit) =>
      edit && typeof edit === "object" && typeof (edit as { path?: unknown }).path === "string"
        ? (edit as { path: string }).path.trim() || undefined
        : undefined,
    )
    .filter((path): path is string => typeof path === "string");

  if (paths.length === 0) {
    return undefined;
  }

  const first = paths[0];
  return paths.every((path) => path === first) ? first : undefined;
}

export function requirePathOrNestedEditPath(path: unknown, edits: unknown): string {
  if (typeof path === "string" && path.trim().length > 0) {
    return path;
  }

  const nestedPath = pathFromNestedEdits(edits);
  if (nestedPath) {
    return nestedPath;
  }

  throw invalidInput(
    'path must be a non-empty string relative to the filesystem workspace root. For edit, pass path as a top-level argument, e.g. {"path":"src/App.jsx","edits":[{"oldText":"...","newText":"..."}]}.',
  );
}

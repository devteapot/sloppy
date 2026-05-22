import { diffLines } from "diff";

export type EditPair = {
  oldText: string;
  newText: string;
};

export type DiffLine = {
  kind: "remove" | "add" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

// Split a diff-library change value into lines, dropping the trailing empty
// element produced by a trailing newline.
function splitChangeValue(value: string): string[] {
  if (value.length === 0) return [];
  const parts = value.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Build a hunk from a real line-level LCS diff (via the `diff` library), so
// unchanged lines stay as context and only true changes are add/remove —
// instead of a naive "all old, then all new" block.
export function buildTextDiffHunk(
  oldText: string,
  newText: string,
  options?: {
    oldStart?: number;
    newStart?: number;
  },
): DiffHunk {
  const oldStart = options?.oldStart ?? 1;
  const newStart = options?.newStart ?? oldStart;
  const lines: DiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  for (const part of diffLines(oldText, newText)) {
    for (const text of splitChangeValue(part.value)) {
      if (part.added) {
        lines.push({ kind: "add", text, newLine });
        newLine += 1;
      } else if (part.removed) {
        lines.push({ kind: "remove", text, oldLine });
        oldLine += 1;
      } else {
        lines.push({ kind: "context", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return {
    oldStart,
    oldLines: oldLine - oldStart,
    newStart,
    newLines: newLine - newStart,
    lines,
  };
}

export function buildEditDiffHunks(edits: readonly EditPair[]): DiffHunk[] {
  return edits.map((edit) => buildTextDiffHunk(edit.oldText, edit.newText));
}

export function renderDiffHunks(hunks: readonly DiffHunk[]): string {
  return hunks
    .flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines.map((line) =>
        line.kind === "add"
          ? `+${line.text}`
          : line.kind === "remove"
            ? `-${line.text}`
            : ` ${line.text}`,
      ),
    ])
    .join("\n");
}

export function renderEditDiff(params: Record<string, unknown>): string | undefined {
  const pairs = collectEditPairs(params);
  if (pairs.length === 0) return undefined;
  return renderDiffHunks(buildEditDiffHunks(pairs));
}

export function collectEditPairs(params: Record<string, unknown>): EditPair[] {
  const pairs: EditPair[] = [];
  const single = readEditPair(params);
  if (single) pairs.push(single);
  const list = params.edits;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        const pair = readEditPair(entry as Record<string, unknown>);
        if (pair) pairs.push(pair);
      }
    }
  }
  return pairs;
}

export function readEditPair(source: Record<string, unknown>): EditPair | null {
  const oldText = pickString(source, ["oldText", "old_string", "old", "search"]);
  const newText = pickString(source, ["newText", "new_string", "new", "replace"]);
  if (oldText === null || newText === null) return null;
  return { oldText, newText };
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return null;
}

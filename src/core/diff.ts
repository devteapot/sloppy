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

export function splitDiffLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/\r?\n/);
}

export function buildTextDiffHunk(
  oldText: string,
  newText: string,
  options?: {
    oldStart?: number;
    newStart?: number;
  },
): DiffHunk {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  const oldStart = options?.oldStart ?? 1;
  const newStart = options?.newStart ?? oldStart;
  return {
    oldStart,
    oldLines: oldLines.length,
    newStart,
    newLines: newLines.length,
    lines: [
      ...oldLines.map((text, index) => ({
        kind: "remove" as const,
        text,
        oldLine: oldStart + index,
      })),
      ...newLines.map((text, index) => ({
        kind: "add" as const,
        text,
        newLine: newStart + index,
      })),
    ],
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

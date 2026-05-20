import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  type Action,
  action,
  createSlopServer,
  type ItemDescriptor,
  type ParamDef,
  type SlopServer,
} from "@slop-ai/server";

import type { FilesystemEditMode } from "../../../config/schema";
import { debug } from "../../../core/debug";
import { isWithinRoot, realpathOfPrefix, safeRealpath } from "../../../providers/path-containment";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const ANCHOR_SNAPSHOT_LIMIT = 64;

type SearchResult = {
  id: string;
  path: string;
  line: number;
  preview: string;
  version: number;
};

type RecentFileOperation = {
  id: string;
  action: string;
  path: string;
  detail?: string;
};

type TaggedLine = {
  line: number;
  tag: string;
  text: string;
};

type TaggedRange = {
  start_line: number;
  start_tag: string;
  end_line: number;
  end_tag: string;
  line_count: number;
};

type RangeEdit = {
  startLine: number;
  startTag?: string;
  endLine: number;
  endTag?: string;
  newText: string;
};

type AnchorLine = {
  line: number;
  text: string;
  tag: string;
};

type AnchorSnapshot = {
  path: string;
  version: number;
  totalLines?: number;
  lines: AnchorLine[];
};

type RangeSpan = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  relocated: boolean;
};

type ProviderParamDef =
  | string
  | {
      type: string;
      description?: string;
      enum?: readonly unknown[];
      items?: object;
      optional?: boolean;
    };

export type { FilesystemEditMode };

const WORKSPACE_FILE_PATH_DESCRIPTION =
  "File path relative to the filesystem workspace root, e.g. 'todo-app/src/App.jsx'. Put this path at the top level of the tool arguments, not inside edits[]. Required.";

const WORKSPACE_DIRECTORY_PATH_DESCRIPTION =
  "Directory path relative to the filesystem workspace root, e.g. 'todo-app' or 'todo-app/src'. Do not include the workspace directory name; paths like '.sloppy-demo/todo-app' are normalized when possible but 'todo-app' is preferred.";

const EDIT_ITEM_SCHEMA = {
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

const EDITS_DESCRIPTION =
  'One or more small exact string replacements. Use edit when the target text is short, stable, and unique; use edit_range after a tagged read when replacing a larger block, repeated text, generated output, or a line-oriented region. Each item must be exactly { oldText, newText }. Do not put path inside each edit; for workspace-level edit, path is a top-level argument. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally, so reason about each edit independently. (4) Keep each oldText as small as possible while still unique -- do not quote the whole function. (5) If two changes touch the same block or adjacent lines, merge them into a single edit rather than emitting overlapping ones. Example: {"path":"src/App.jsx","edits":[{"oldText":"const title = \'Old\';","newText":"const title = \'New\';"}],"expected_version":3}. Errors return { error, edit_index } identifying the offending edit.';

const ENTRY_EDITS_DESCRIPTION =
  "One or more small exact string replacements. Use edit when the target text is short, stable, and unique; use edit_range after a tagged read when replacing a larger block, repeated text, generated output, or a line-oriented region. This per-file action already targets the file, so each item must be exactly { oldText, newText } and must not include a path. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally. (4) Keep each oldText as small as possible while still unique. Errors return { error, edit_index } identifying the offending edit.";

const RANGE_EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    start_line: {
      type: "number",
      description: "1-based first line in the range to replace.",
    },
    start_tag: {
      type: "string",
      description:
        "Line tag returned by read(include_line_tags=true) for start_line. Optional when top-level source_version is supplied from a prior read/search.",
      optional: true,
    },
    end_line: {
      type: "number",
      description: "1-based final line in the range to replace, inclusive.",
    },
    end_tag: {
      type: "string",
      description:
        "Line tag returned by read(include_line_tags=true) for end_line. Optional when top-level source_version is supplied from a prior read/search.",
      optional: true,
    },
    new_text: {
      type: "string",
      description:
        "Replacement text for the line range. Do not add a trailing newline unless you intentionally want a blank line before the following file line.",
    },
  },
  required: ["start_line", "end_line", "new_text"],
  additionalProperties: false,
};

const RANGE_EDITS_DESCRIPTION =
  "One or more line-range replacements. Use edit_range when replacing whole lines or blocks, when an oldText replacement would be large or fragile, or when repeated text makes exact replacement risky. Preferred path: use source_version from a prior read/search and each edit as { start_line, end_line, new_text }; the provider derives boundary tags from its cached source snapshot. If no source_version is available, first read the target range with include_line_tags=true and pass { start_line, start_tag, end_line, end_tag, new_text }. Tags are local CAS guards: unrelated file changes are allowed when the target boundary lines still match. If the original line numbers no longer match, edit_range searches for a unique boundary-tag pair with the same line span. Pass expected_version only when whole-file CAS is required.";

const ENTRY_RANGE_EDITS_DESCRIPTION =
  "One or more line-range replacements. Use edit_range when replacing whole lines or blocks, when an oldText replacement would be large or fragile, or when repeated text makes exact replacement risky. Preferred path: use source_version from a prior read/search and each edit as { start_line, end_line, new_text }; the provider derives boundary tags from its cached source snapshot. If no source_version is available, first read the target range with include_line_tags=true and pass { start_line, start_tag, end_line, end_tag, new_text }. Tags are local CAS guards; when line numbers drift, edit_range searches for a unique boundary-tag pair with the same line span. expected_version is optional strict whole-file CAS.";

function actionParams(params: Record<string, ProviderParamDef>): Record<string, ParamDef> {
  return params as Record<string, ParamDef>;
}

function buildReadParams(includeLineTagParams: boolean): Record<string, ProviderParamDef> {
  const params: Record<string, ProviderParamDef> = {
    start_line: {
      type: "number",
      description:
        "Optional 1-based start line. Pair with end_line to read a slice instead of the whole file.",
      optional: true,
    },
    end_line: {
      type: "number",
      description: "Optional 1-based end line (inclusive).",
      optional: true,
    },
  };

  if (includeLineTagParams) {
    params.include_line_tags = {
      type: "boolean",
      description:
        "When true with start_line/end_line, include structured { line, tag, text } records for range-safe edit_range calls.",
      optional: true,
    };
    params.tag_mode = {
      type: "string",
      description:
        "Optional tag shape when include_line_tags=true: 'all' returns every tagged line, 'boundary' returns only start/end tags.",
      optional: true,
    };
    params.include_content = {
      type: "boolean",
      description:
        "Optional range-read output control. Set false with include_line_tags=true to omit content and return only tag metadata.",
      optional: true,
    };
  }

  return params;
}

function buildReadDescription(
  target: "this file" | "a path",
  includeLineTagParams: boolean,
): string {
  const base =
    target === "this file"
      ? "Read this file as text. Returns { content, version, exists, ... }. Pass start_line/end_line to read just a slice."
      : "Read a path relative to the workspace root. For files, returns { content, version, exists, kind: 'file', ... }. For directories, returns { kind: 'directory', entries, content } as a compact listing. For a nonexistent file returns { content: '', version: 0, exists: false } so callers can use a uniform read->write(expected_version) loop. Pass start_line/end_line to read just a slice of an existing file.";

  if (!includeLineTagParams) {
    return base;
  }

  return `${base} File reads return source_version when the provider cached line anchors for later edit_range calls. Pass include_line_tags=true with a range only when explicit tag values are needed. Use tag_mode='boundary' and include_content=false for compact explicit-tag setup.`;
}

function buildWriteDescription(editMode: FilesystemEditMode): string {
  if (editMode === "hash") {
    return "Write a text file relative to the workspace root. Prefer `edit_range` for targeted changes to existing files; use `write` for new files (with expected_version=0) or full rewrites.";
  }

  if (editMode === "replace") {
    return "Write a text file relative to the workspace root. Prefer `edit` for targeted changes to existing files; use `write` for new files (with expected_version=0) or full rewrites.";
  }

  return "Write a text file relative to the workspace root. Prefer `edit` or `edit_range` for targeted changes to existing files; use `write` for new files (with expected_version=0) or full rewrites.";
}

export function buildFilesystemSystemPromptFragment(editMode: FilesystemEditMode): string {
  const common = [
    `Filesystem edit mode is '${editMode}'.`,
    "Use search when you know text or symbols but not the file or line.",
    "Use read for inspection; prefer start_line/end_line slices when the target region is known.",
  ];

  if (editMode === "replace") {
    return [
      ...common,
      "Use edit for targeted changes: oldText must be short, stable, exact, and unique in the original file.",
      "Tagged hash/range editing is disabled in this mode; do not plan on edit_range or tagged reads.",
      "Use write only for new files or full rewrites; use expected_version=0 for atomic creation.",
    ].join("\n");
  }

  if (editMode === "hash") {
    return [
      ...common,
      "Use source_version from a prior read/search with edit_range for targeted changes; omit start_tag/end_tag when source_version covers the edited range.",
      "Use read(include_line_tags=true) only when the prior read/search did not cover the target range or explicit tags are required.",
      "Use tag_mode='boundary' and include_content=false when you already saw the text and only need compact explicit guards.",
      "Exact string replacement editing is disabled in this mode; do not plan on edit.",
      "Use write only for new files or full rewrites; use expected_version=0 for atomic creation.",
    ].join("\n");
  }

  return [
    ...common,
    "Use edit for small exact string replacements when oldText is short, stable, and unique.",
    "Use source_version from a prior read/search with edit_range for larger blocks, repeated text, fragile/generated output, or whole-line edits.",
    "Use read(include_line_tags=true) only when the prior read/search did not cover the target range or explicit tags are required.",
    "Use tag_mode='boundary' and include_content=false when you already saw the text and only need compact explicit guards.",
    "Use write only for new files or full rewrites; use expected_version=0 for atomic creation.",
  ].join("\n");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

function isProbablyBinary(content: Uint8Array): boolean {
  const sample = content.subarray(0, 1024);
  return sample.includes(0);
}

function relativePath(root: string, target: string): string {
  const rel = relative(root, target);
  return rel || ".";
}

function entryIdForPath(path: string): string {
  return path.replaceAll("/", "__");
}

function displayNameForPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function lineTag(text: string, line?: number): string {
  const salt = line === undefined ? "line" : `line:${line}`;
  return createHash("sha256").update(`${salt}\0${text}`).digest("hex").slice(0, 8);
}

function tagMatchesLine(line: number, text: string, tag: string): boolean {
  return tag === lineTag(text) || tag === lineTag(text, line);
}

function buildTaggedLines(lines: string[], startLine: number, endLine: number): TaggedLine[] {
  const tagged = lines.slice(startLine - 1, endLine).map((text, index) => ({
    line: startLine + index,
    text,
    baseTag: lineTag(text),
  }));
  const counts = new Map<string, number>();
  for (const item of tagged) {
    counts.set(item.baseTag, (counts.get(item.baseTag) ?? 0) + 1);
  }
  return tagged.map((item) => ({
    line: item.line,
    tag: (counts.get(item.baseTag) ?? 0) > 1 ? lineTag(item.text, item.line) : item.baseTag,
    text: item.text,
  }));
}

function buildTaggedRange(lines: string[], startLine: number, endLine: number): TaggedRange {
  return {
    start_line: startLine,
    start_tag: lineTag(lines[startLine - 1] ?? ""),
    end_line: endLine,
    end_tag: lineTag(lines[endLine - 1] ?? ""),
    line_count: endLine - startLine + 1,
  };
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function findTaggedRangeSpan(
  lines: string[],
  starts: number[],
  edit: RangeEdit & { startTag: string; endTag: string },
):
  | { ok: true; span: RangeSpan }
  | {
      ok: false;
      error: "invalid_range" | "tag_mismatch" | "ambiguous_tag";
      line?: number;
      expectedTag?: string;
      currentTag?: string;
    } {
  const { startLine, startTag, endLine, endTag } = edit;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    startTag.length === 0 ||
    endTag.length === 0
  ) {
    return { ok: false, error: "invalid_range" };
  }

  const lineDelta = endLine - startLine;
  const exactStartText = lines[startLine - 1];
  const exactEndText = lines[endLine - 1];
  const exactStartMatches =
    exactStartText !== undefined && tagMatchesLine(startLine, exactStartText, startTag);
  const exactEndMatches =
    exactEndText !== undefined && tagMatchesLine(endLine, exactEndText, endTag);
  const exactStart = starts[startLine - 1];

  if (
    exactStart !== undefined &&
    exactStartMatches &&
    exactEndMatches &&
    exactEndText !== undefined
  ) {
    return {
      ok: true,
      span: {
        start: exactStart,
        end: (starts[endLine - 1] ?? 0) + exactEndText.length,
        startLine,
        endLine,
        relocated: false,
      },
    };
  }

  const matches: RangeSpan[] = [];
  for (let startIndex = 0; startIndex + lineDelta < lines.length; startIndex++) {
    const candidateStartLine = startIndex + 1;
    const candidateEndLine = candidateStartLine + lineDelta;
    const candidateStartText = lines[startIndex] ?? "";
    const candidateEndText = lines[candidateEndLine - 1] ?? "";
    if (
      tagMatchesLine(candidateStartLine, candidateStartText, startTag) &&
      tagMatchesLine(candidateEndLine, candidateEndText, endTag)
    ) {
      const start = starts[startIndex];
      const endStart = starts[candidateEndLine - 1];
      if (start !== undefined && endStart !== undefined) {
        matches.push({
          start,
          end: endStart + candidateEndText.length,
          startLine: candidateStartLine,
          endLine: candidateEndLine,
          relocated: true,
        });
      }
    }
  }

  if (matches.length === 1) {
    return { ok: true, span: matches[0] };
  }

  if (matches.length > 1) {
    return { ok: false, error: "ambiguous_tag" };
  }

  const mismatchLine = !exactStartMatches ? startLine : endLine;
  const expectedTag = !exactStartMatches ? startTag : endTag;
  const currentText = lines[mismatchLine - 1];
  return {
    ok: false,
    error: "tag_mismatch",
    line: mismatchLine,
    expectedTag,
    currentTag: currentText === undefined ? undefined : lineTag(currentText),
  };
}

function invalidInput(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = "invalid_input";
  return error;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(
      `${name} must be a non-empty string relative to the filesystem workspace root.`,
    );
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw invalidInput(`${name} must be a string.`);
  }
  return value;
}

function coerceEdits(value: unknown): Array<{ oldText: string; newText: string }> {
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

function coerceRangeEdits(value: unknown): RangeEdit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: RangeEdit[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const { start_line, start_tag, end_line, end_tag, new_text } = raw as {
      start_line?: unknown;
      start_tag?: unknown;
      end_line?: unknown;
      end_tag?: unknown;
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
      startTag: typeof start_tag === "string" ? start_tag : undefined,
      endLine: end_line,
      endTag: typeof end_tag === "string" ? end_tag : undefined,
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

function requirePathOrNestedEditPath(path: unknown, edits: unknown): string {
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

export class FilesystemProvider {
  readonly server: SlopServer;
  private root: string;
  private focusPath: string;
  private recentLimit: number;
  private searchLimit: number;
  private readMaxBytes: number;
  private contentRefThresholdBytes: number;
  private previewBytes: number;
  private editMode: FilesystemEditMode;
  private recent: RecentFileOperation[] = [];
  private lastSearch: { pattern: string; basePath: string; results: SearchResult[] } | null = null;
  private fileVersions = new Map<string, number>();
  private cachedMtimes = new Map<string, number>();
  private writeLocks = new Map<string, Promise<unknown>>();
  private anchorSnapshots = new Map<string, AnchorSnapshot>();

  constructor(options: {
    root: string;
    focus: string;
    recentLimit: number;
    searchLimit: number;
    readMaxBytes: number;
    contentRefThresholdBytes?: number;
    previewBytes?: number;
    editMode?: FilesystemEditMode;
  }) {
    // Resolve the root through realpath so symlink-escape via a symlinked
    // root component is also blocked. Falls back to plain `resolve` if the
    // root does not exist yet (callers may create it on first use).
    const rawRoot = resolve(options.root);
    this.root = safeRealpath(rawRoot) ?? rawRoot;
    const rawFocus = resolve(options.focus || options.root);
    const candidateFocus = safeRealpath(rawFocus) ?? rawFocus;
    // Reject any focus that resolves outside the workspace root. Without
    // this, a misconfigured or malicious focus would leak listings (and
    // potentially file contents) from outside the root through /workspace.
    if (!isWithinRoot(this.root, candidateFocus)) {
      throw new Error(
        `Filesystem focus must be inside workspace root. focus=${candidateFocus} root=${this.root}`,
      );
    }
    this.focusPath = candidateFocus;
    this.recentLimit = options.recentLimit;
    this.searchLimit = options.searchLimit;
    this.readMaxBytes = options.readMaxBytes;
    this.contentRefThresholdBytes = options.contentRefThresholdBytes ?? 8192;
    this.previewBytes = options.previewBytes ?? 2048;
    this.editMode = options.editMode ?? "both";

    this.server = createSlopServer({
      id: "filesystem",
      name: "Filesystem",
    });

    this.server.register("workspace", () => this.buildWorkspaceDescriptor());
    this.server.register("search", () => this.buildSearchDescriptor());
    this.server.register("recent", () => this.buildRecentDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private recordRecent(actionName: string, path: string, detail?: string): void {
    this.recent.unshift({
      id: crypto.randomUUID(),
      action: actionName,
      path,
      detail,
    });
    this.recent = this.recent.slice(0, this.recentLimit);
  }

  private supportsReplaceEdits(): boolean {
    return this.editMode === "replace" || this.editMode === "both";
  }

  private supportsHashEdits(): boolean {
    return this.editMode === "hash" || this.editMode === "both";
  }

  private anchorKey(path: string, version: number): string {
    return `${path}\0${version}`;
  }

  private cacheAnchorLines(options: {
    path: string;
    version: number;
    totalLines?: number;
    lines: string[];
    startLine: number;
  }): void {
    if (!this.supportsHashEdits() || options.lines.length === 0) {
      return;
    }

    const key = this.anchorKey(options.path, options.version);
    const existing = this.anchorSnapshots.get(key);
    const byLine = new Map<number, AnchorLine>();
    for (const line of existing?.lines ?? []) {
      byLine.set(line.line, line);
    }
    for (let index = 0; index < options.lines.length; index += 1) {
      const line = options.startLine + index;
      const text = options.lines[index] ?? "";
      byLine.set(line, {
        line,
        text,
        tag: lineTag(text),
      });
    }

    if (existing) {
      this.anchorSnapshots.delete(key);
    }
    this.anchorSnapshots.set(key, {
      path: options.path,
      version: options.version,
      totalLines: options.totalLines ?? existing?.totalLines,
      lines: [...byLine.values()].sort((left, right) => left.line - right.line),
    });

    while (this.anchorSnapshots.size > ANCHOR_SNAPSHOT_LIMIT) {
      const oldest = this.anchorSnapshots.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.anchorSnapshots.delete(oldest);
    }
  }

  private anchorForRange(
    path: string,
    sourceVersion: number | undefined,
    edit: RangeEdit,
  ):
    | { ok: true; edit: RangeEdit & { startTag: string; endTag: string } }
    | { ok: false; error: "invalid_range" | "missing_anchor" | "anchor_not_found" } {
    if (
      !Number.isInteger(edit.startLine) ||
      !Number.isInteger(edit.endLine) ||
      edit.startLine < 1 ||
      edit.endLine < edit.startLine
    ) {
      return { ok: false, error: "invalid_range" };
    }

    if (edit.startTag && edit.endTag) {
      return { ok: true, edit: { ...edit, startTag: edit.startTag, endTag: edit.endTag } };
    }

    if (sourceVersion === undefined) {
      return { ok: false, error: "missing_anchor" };
    }

    const snapshot = this.anchorSnapshots.get(this.anchorKey(path, sourceVersion));
    if (!snapshot) {
      return { ok: false, error: "anchor_not_found" };
    }
    const start = snapshot.lines.find((line) => line.line === edit.startLine);
    const end = snapshot.lines.find((line) => line.line === edit.endLine);
    if (!start || !end) {
      return { ok: false, error: "anchor_not_found" };
    }

    return {
      ok: true,
      edit: {
        ...edit,
        startTag: start.tag,
        endTag: end.tag,
      },
    };
  }

  private normalizeInputPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    if (!trimmed || trimmed === "." || trimmed === "./") {
      return ".";
    }

    if (trimmed === "/workspace" || trimmed === "workspace") {
      return ".";
    }
    if (trimmed.startsWith("/workspace/")) {
      return trimmed.slice("/workspace/".length);
    }
    if (trimmed.startsWith("workspace/")) {
      return trimmed.slice("workspace/".length);
    }

    if (isAbsolute(trimmed)) {
      // Compare via realpath so paths that go through symlinked prefixes
      // (e.g. macOS `/var/folders/...` -> `/private/var/folders/...`) still
      // normalize correctly when the canonical root differs from the user's
      // input path.
      const trimmedReal = realpathOfPrefix(trimmed);
      const relativeToRoot = relative(this.root, trimmedReal);
      if (
        relativeToRoot === "" ||
        (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot))
      ) {
        return relativeToRoot || ".";
      }
    }

    const rootName = basename(this.root);
    if (trimmed === rootName || trimmed === `./${rootName}`) {
      return ".";
    }
    if (trimmed.startsWith(`${rootName}/`)) {
      return trimmed.slice(rootName.length + 1);
    }
    if (trimmed.startsWith(`./${rootName}/`)) {
      return trimmed.slice(rootName.length + 3);
    }

    return trimmed;
  }

  private ensureWithinRoot(inputPath: string): string {
    const normalizedPath = this.normalizeInputPath(inputPath);
    const resolved = resolve(this.root, normalizedPath);
    // Realpath the longest existing prefix so a symlink anywhere along the
    // path (e.g. `${root}/escape -> /etc`) is rejected before any read or
    // write. The unresolved tail is re-appended so write-on-nonexistent
    // still works for first-creation paths.
    const realResolved = realpathOfPrefix(resolved);
    const escapes = realResolved !== this.root && !realResolved.startsWith(`${this.root}/`);
    if (escapes) {
      throw invalidInput(
        `Path escapes filesystem root: ${inputPath}. Use a path relative to the workspace root.`,
      );
    }
    return resolved;
  }

  private observeVersion(absolutePath: string, mtimeMs: number | null): number {
    const cachedMtime = this.cachedMtimes.get(absolutePath);
    const existing = this.fileVersions.get(absolutePath);

    if (existing === undefined) {
      if (mtimeMs == null) {
        // Never observed and doesn't exist on disk. Report version 0 so
        // `write(expected_version=0)` succeeds for first creation. Do not
        // cache — bumpVersion on the first successful write will establish
        // version 1.
        return 0;
      }
      const initial = 1;
      this.fileVersions.set(absolutePath, initial);
      this.cachedMtimes.set(absolutePath, mtimeMs);
      return initial;
    }

    // File is gone on disk. If cachedMtime is still set, this is the first
    // observation after an external deletion: bump the version so callers
    // with a stale expected_version see a conflict, drop the cached mtime.
    // If cachedMtime is already cleared, the absence was already accounted
    // for in `existing` — don't bump again on every subsequent call.
    if (mtimeMs == null) {
      if (cachedMtime == null) {
        return existing;
      }
      const next = existing + 1;
      this.fileVersions.set(absolutePath, next);
      this.cachedMtimes.delete(absolutePath);
      debug("filesystem", "external_delete", {
        path: relativePath(this.root, absolutePath),
        previous_version: existing,
        version: next,
      });
      return next;
    }

    if (cachedMtime != null && mtimeMs !== cachedMtime) {
      const next = existing + 1;
      this.fileVersions.set(absolutePath, next);
      this.cachedMtimes.set(absolutePath, mtimeMs);
      debug("filesystem", "mtime_drift", {
        path: relativePath(this.root, absolutePath),
        cached_mtime: cachedMtime,
        actual_mtime: mtimeMs,
        version: next,
      });
      return next;
    }

    if (cachedMtime == null) {
      this.cachedMtimes.set(absolutePath, mtimeMs);
    }

    return existing;
  }

  private bumpVersion(absolutePath: string, mtimeMs: number | null): number {
    const current = this.fileVersions.get(absolutePath) ?? 0;
    const next = current + 1;
    this.fileVersions.set(absolutePath, next);
    if (mtimeMs != null) {
      this.cachedMtimes.set(absolutePath, mtimeMs);
    } else {
      this.cachedMtimes.delete(absolutePath);
    }
    return next;
  }

  private async setFocus(inputPath: string): Promise<{ path: string }> {
    const nextPath = this.ensureWithinRoot(inputPath);
    const info = await Bun.file(nextPath)
      .stat()
      .catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`Focus path is not a directory: ${inputPath}`);
    }

    this.focusPath = nextPath;
    this.recordRecent("focus", relativePath(this.root, nextPath));
    this.server.refresh();
    return { path: relativePath(this.root, nextPath) };
  }

  private async readTextFile(
    inputPath: string,
    range?: {
      startLine?: number;
      endLine?: number;
      includeLineTags?: boolean;
      tagMode?: "all" | "boundary";
      includeContent?: boolean;
    },
  ): Promise<{
    path: string;
    content?: string;
    truncated: boolean;
    version: number;
    source_version?: number;
    exists: boolean;
    startLine?: number;
    endLine?: number;
    totalLines?: number;
    lines?: TaggedLine[];
    range?: TaggedRange;
    preview_only?: boolean;
    total_bytes?: number;
    ref?: { kind: "fs"; path: string; version: number; total_bytes: number; total_lines: number };
    kind?: "file" | "directory";
    entries?: Array<{ name: string; path: string; kind: "file" | "directory"; size: number }>;
    hint?: string;
  }> {
    const fullPath = this.ensureWithinRoot(inputPath);
    const stat = await Bun.file(fullPath)
      .stat()
      .catch(() => null);
    if (!stat) {
      // Read-on-nonexistent returns empty content at the current tracked
      // "void" version (0 if never observed; bumped if the file was tracked
      // then deleted externally). Callers can implement a uniform
      // read -> write(expected_version) -> retry loop with no ENOENT branch.
      return {
        path: relativePath(this.root, fullPath),
        content: "",
        truncated: false,
        version: this.observeVersion(fullPath, null),
        exists: false,
      };
    }
    const version = this.observeVersion(fullPath, stat.mtimeMs);
    const relPath = relativePath(this.root, fullPath);

    if (stat.isDirectory()) {
      const entries = readdirSync(fullPath, { withFileTypes: true })
        .sort((left, right) => {
          if (left.isDirectory() && !right.isDirectory()) return -1;
          if (!left.isDirectory() && right.isDirectory()) return 1;
          return left.name.localeCompare(right.name);
        })
        .map((entry) => {
          const entryPath = resolve(fullPath, entry.name);
          const entryInfo = statSync(entryPath);
          return {
            name: entry.name,
            path: relativePath(this.root, entryPath),
            kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
            size: entryInfo.size,
          };
        });
      this.recordRecent("read_directory", relPath, `${entries.length} entries`);

      return {
        path: relPath,
        content: entries.map((entry) => `${entry.kind}\t${entry.path}`).join("\n"),
        truncated: false,
        version,
        exists: true,
        kind: "directory",
        entries,
        hint: "This path is a directory. Use set_focus or slop_query_state for richer directory state, or read a specific file path for file contents.",
      };
    }

    const bytes = await Bun.file(fullPath).bytes();

    if (isProbablyBinary(bytes)) {
      return {
        path: relPath,
        content: `[binary file ${displayNameForPath(inputPath)} omitted]`,
        truncated: false,
        version,
        exists: true,
        kind: "file",
      };
    }

    const hasRange =
      range !== undefined && (range.startLine !== undefined || range.endLine !== undefined);

    if (hasRange) {
      const fullText = TEXT_DECODER.decode(bytes);
      const lines = fullText.split("\n");
      const totalLines = lines.length;
      const startLine = Math.max(1, range?.startLine ?? 1);
      const endLine = Math.min(totalLines, range?.endLine ?? totalLines);

      if (startLine > endLine) {
        throw new Error(`Invalid range: start_line (${startLine}) is after end_line (${endLine}).`);
      }

      const sliced = lines.slice(startLine - 1, endLine).join("\n");
      const truncated = sliced.length > this.readMaxBytes;
      const text = truncated ? truncateText(sliced, this.readMaxBytes) : sliced;
      const tagMode = range?.tagMode ?? "all";
      const sourceLines = lines.slice(startLine - 1, endLine);
      this.cacheAnchorLines({
        path: relPath,
        version,
        totalLines,
        lines: sourceLines,
        startLine,
      });
      this.recordRecent("read", relPath, `lines ${startLine}-${endLine}`);

      return {
        path: relPath,
        content: range?.includeContent === false ? undefined : text,
        truncated,
        version,
        source_version: this.supportsHashEdits() ? version : undefined,
        exists: true,
        kind: "file",
        startLine,
        endLine,
        totalLines,
        lines:
          range?.includeLineTags && tagMode === "all"
            ? buildTaggedLines(lines, startLine, endLine)
            : undefined,
        range:
          range?.includeLineTags && tagMode === "boundary"
            ? buildTaggedRange(lines, startLine, endLine)
            : undefined,
      };
    }

    // No explicit range: decide whether to return full content or a preview+ref.
    if (bytes.byteLength > this.contentRefThresholdBytes) {
      const previewText = TEXT_DECODER.decode(bytes.subarray(0, this.previewBytes));
      const totalLines = TEXT_DECODER.decode(bytes).split("\n").length;
      this.recordRecent("read", relPath, "preview+ref");

      return {
        path: relPath,
        content: truncateText(previewText, this.previewBytes),
        truncated: true,
        version,
        exists: true,
        kind: "file",
        preview_only: true,
        total_bytes: bytes.byteLength,
        totalLines,
        ref: {
          kind: "fs",
          path: relPath,
          version,
          total_bytes: bytes.byteLength,
          total_lines: totalLines,
        },
      };
    }

    const truncated = bytes.byteLength > this.readMaxBytes;
    const text = TEXT_DECODER.decode(bytes.subarray(0, this.readMaxBytes));
    if (!truncated) {
      this.cacheAnchorLines({
        path: relPath,
        version,
        totalLines: text.split("\n").length,
        lines: text.split("\n"),
        startLine: 1,
      });
    }
    this.recordRecent("read", relPath);

    return {
      path: relPath,
      content: truncated ? truncateText(text, this.readMaxBytes) : text,
      truncated,
      version,
      source_version: !truncated && this.supportsHashEdits() ? version : undefined,
      exists: true,
      kind: "file",
    };
  }

  private async writeTextFile(
    inputPath: string,
    content: string,
    expectedVersion?: number,
  ): Promise<
    | { path: string; bytes: number; version: number }
    | { error: "version_conflict"; currentVersion: number; path: string }
  > {
    const fullPath = this.ensureWithinRoot(inputPath);
    return this.withWriteLock(fullPath, async () => {
      const preStat = await Bun.file(fullPath)
        .stat()
        .catch(() => null);
      const currentVersion = this.observeVersion(fullPath, preStat?.mtimeMs ?? null);

      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        debug("filesystem", "write_version_conflict", {
          path: relativePath(this.root, fullPath),
          expected: expectedVersion,
          current: currentVersion,
        });
        return {
          error: "version_conflict" as const,
          currentVersion,
          path: relativePath(this.root, fullPath),
        };
      }

      await Bun.$`mkdir -p ${dirname(fullPath)}`;
      await Bun.write(fullPath, content);
      const postStat = await Bun.file(fullPath)
        .stat()
        .catch(() => null);
      const version = this.bumpVersion(fullPath, postStat?.mtimeMs ?? null);
      this.recordRecent("write", relativePath(this.root, fullPath), `${content.length} chars`);
      this.server.refresh();

      return {
        path: relativePath(this.root, fullPath),
        bytes: TEXT_ENCODER.encode(content).byteLength,
        version,
      };
    });
  }

  private async editTextFile(
    inputPath: string,
    edits: ReadonlyArray<{ oldText: string; newText: string }>,
    expectedVersion?: number,
  ): Promise<
    | { path: string; bytes: number; version: number; edits_applied: number }
    | { error: "version_conflict"; currentVersion: number; path: string }
    | {
        error: "no_match" | "multiple_matches" | "overlap" | "empty_old_text" | "identical_text";
        path: string;
        edit_index: number;
      }
    | { error: "empty_edits"; path: string }
    | { error: "file_not_found"; path: string }
  > {
    const fullPath = this.ensureWithinRoot(inputPath);
    const relPath = relativePath(this.root, fullPath);

    if (edits.length === 0) {
      return { error: "empty_edits" as const, path: relPath };
    }

    return this.withWriteLock(fullPath, async () => {
      const preStat = await Bun.file(fullPath)
        .stat()
        .catch(() => null);
      const currentVersion = this.observeVersion(fullPath, preStat?.mtimeMs ?? null);

      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        debug("filesystem", "edit_version_conflict", {
          path: relPath,
          expected: expectedVersion,
          current: currentVersion,
        });
        return {
          error: "version_conflict" as const,
          currentVersion,
          path: relPath,
        };
      }

      if (!preStat) {
        return { error: "file_not_found" as const, path: relPath };
      }

      const originalBytes = await Bun.file(fullPath).bytes();
      const original = TEXT_DECODER.decode(originalBytes);

      const spans: Array<{ start: number; end: number; newText: string }> = [];
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit) {
          continue;
        }
        const { oldText, newText } = edit;

        if (oldText.length === 0) {
          debug("filesystem", "edit_empty_old_text", { path: relPath, edit_index: i });
          return { error: "empty_old_text" as const, path: relPath, edit_index: i };
        }
        if (oldText === newText) {
          debug("filesystem", "edit_identical_text", { path: relPath, edit_index: i });
          return { error: "identical_text" as const, path: relPath, edit_index: i };
        }

        const first = original.indexOf(oldText);
        if (first === -1) {
          debug("filesystem", "edit_no_match", { path: relPath, edit_index: i });
          return { error: "no_match" as const, path: relPath, edit_index: i };
        }
        const second = original.indexOf(oldText, first + 1);
        if (second !== -1) {
          debug("filesystem", "edit_multiple_matches", { path: relPath, edit_index: i });
          return { error: "multiple_matches" as const, path: relPath, edit_index: i };
        }

        spans.push({ start: first, end: first + oldText.length, newText });
      }

      const sorted = [...spans].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        if (prev && curr && curr.start < prev.end) {
          const originalIndex = spans.indexOf(curr);
          debug("filesystem", "edit_overlap", { path: relPath, edit_index: originalIndex });
          return { error: "overlap" as const, path: relPath, edit_index: originalIndex };
        }
      }

      let next = original;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const span = sorted[i];
        if (!span) {
          continue;
        }
        next = next.slice(0, span.start) + span.newText + next.slice(span.end);
      }

      await Bun.write(fullPath, next);
      const postStat = await Bun.file(fullPath)
        .stat()
        .catch(() => null);
      const version = this.bumpVersion(fullPath, postStat?.mtimeMs ?? null);
      const bytes = TEXT_ENCODER.encode(next).byteLength;
      const delta = bytes - originalBytes.byteLength;
      this.recordRecent(
        "edit",
        relPath,
        `${edits.length} edit${edits.length === 1 ? "" : "s"}, ${delta >= 0 ? "+" : ""}${delta} bytes`,
      );
      debug("filesystem", "edit_applied", {
        path: relPath,
        edits: edits.length,
        bytes_delta: delta,
        version,
      });
      this.server.refresh();

      return {
        path: relPath,
        bytes,
        version,
        edits_applied: edits.length,
      };
    });
  }

  private async editRangeTextFile(
    inputPath: string,
    edits: ReadonlyArray<RangeEdit>,
    expectedVersion?: number,
    sourceVersion?: number,
  ): Promise<
    | { path: string; bytes: number; version: number; edits_applied: number }
    | { error: "version_conflict"; currentVersion: number; path: string }
    | { error: "file_not_found"; path: string }
    | { error: "empty_edits"; path: string }
    | {
        error:
          | "invalid_range"
          | "missing_anchor"
          | "anchor_not_found"
          | "tag_mismatch"
          | "ambiguous_tag"
          | "overlap"
          | "identical_text";
        path: string;
        edit_index: number;
        line?: number;
        expected_tag?: string;
        current_tag?: string;
        source_version?: number;
      }
  > {
    const fullPath = this.ensureWithinRoot(inputPath);
    const relPath = relativePath(this.root, fullPath);

    if (edits.length === 0) {
      return { error: "empty_edits" as const, path: relPath };
    }

    return this.withWriteLock(fullPath, async () => {
      const preStat = await Bun.file(fullPath)
        .stat()
        .catch(() => null);
      const currentVersion = this.observeVersion(fullPath, preStat?.mtimeMs ?? null);

      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        debug("filesystem", "edit_range_version_conflict", {
          path: relPath,
          expected: expectedVersion,
          current: currentVersion,
        });
        return {
          error: "version_conflict" as const,
          currentVersion,
          path: relPath,
        };
      }

      if (!preStat) {
        return { error: "file_not_found" as const, path: relPath };
      }

      const originalBytes = await Bun.file(fullPath).bytes();
      const original = TEXT_DECODER.decode(originalBytes);
      const lines = original.split("\n");
      const starts = buildLineStarts(original);

      const spans: Array<{ start: number; end: number; newText: string; editIndex: number }> = [];
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit) {
          continue;
        }
        const anchored = this.anchorForRange(relPath, sourceVersion, edit);
        if (!anchored.ok) {
          debug("filesystem", `edit_range_${anchored.error}`, {
            path: relPath,
            edit_index: i,
            source_version: sourceVersion,
          });
          return {
            error: anchored.error,
            path: relPath,
            edit_index: i,
            source_version: sourceVersion,
          };
        }

        const { newText } = anchored.edit;
        const range = findTaggedRangeSpan(lines, starts, anchored.edit);
        if (!range.ok && range.error === "invalid_range") {
          debug("filesystem", "edit_range_invalid_range", { path: relPath, edit_index: i });
          return { error: "invalid_range" as const, path: relPath, edit_index: i };
        }
        if (!range.ok && range.error === "ambiguous_tag") {
          debug("filesystem", "edit_range_ambiguous_tag", { path: relPath, edit_index: i });
          return { error: "ambiguous_tag" as const, path: relPath, edit_index: i };
        }
        if (!range.ok) {
          debug("filesystem", "edit_range_tag_mismatch", {
            path: relPath,
            edit_index: i,
            line: range.line,
          });
          return {
            error: "tag_mismatch" as const,
            path: relPath,
            edit_index: i,
            line: range.line,
            expected_tag: range.expectedTag,
            current_tag: range.currentTag,
          };
        }

        const { start, end } = range.span;
        if (range.span.relocated) {
          debug("filesystem", "edit_range_relocated", {
            path: relPath,
            edit_index: i,
            from_start_line: edit.startLine,
            from_end_line: edit.endLine,
            to_start_line: range.span.startLine,
            to_end_line: range.span.endLine,
          });
        }

        if (original.slice(start, end) === newText) {
          debug("filesystem", "edit_range_identical_text", { path: relPath, edit_index: i });
          return { error: "identical_text" as const, path: relPath, edit_index: i };
        }

        spans.push({ start, end, newText, editIndex: i });
      }

      const sorted = [...spans].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        if (prev && curr && curr.start < prev.end) {
          debug("filesystem", "edit_range_overlap", {
            path: relPath,
            edit_index: curr.editIndex,
          });
          return { error: "overlap" as const, path: relPath, edit_index: curr.editIndex };
        }
      }

      let next = original;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const span = sorted[i];
        if (!span) {
          continue;
        }
        next = next.slice(0, span.start) + span.newText + next.slice(span.end);
      }

      await Bun.write(fullPath, next);
      const postStat = await Bun.file(fullPath)
        .stat()
        .catch(() => null);
      const version = this.bumpVersion(fullPath, postStat?.mtimeMs ?? null);
      const bytes = TEXT_ENCODER.encode(next).byteLength;
      const delta = bytes - originalBytes.byteLength;
      this.recordRecent(
        "edit_range",
        relPath,
        `${edits.length} edit${edits.length === 1 ? "" : "s"}, ${delta >= 0 ? "+" : ""}${delta} bytes`,
      );
      debug("filesystem", "edit_range_applied", {
        path: relPath,
        edits: edits.length,
        bytes_delta: delta,
        version,
      });
      this.server.refresh();

      return {
        path: relPath,
        bytes,
        version,
        edits_applied: edits.length,
      };
    });
  }

  private async withWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const swallowed = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeLocks.set(key, swallowed);
    try {
      return await next;
    } finally {
      if (this.writeLocks.get(key) === swallowed) {
        this.writeLocks.delete(key);
      }
    }
  }

  private async makeDirectory(inputPath: string): Promise<{ path: string }> {
    const fullPath = this.ensureWithinRoot(inputPath);
    await Bun.$`mkdir -p ${fullPath}`;
    this.recordRecent("mkdir", relativePath(this.root, fullPath));
    this.server.refresh();
    return { path: relativePath(this.root, fullPath) };
  }

  private async search(
    pattern: string,
    maybePath?: string,
  ): Promise<{
    pattern: string;
    resultCount: number;
    results: Array<{
      path: string;
      line: number;
      preview: string;
      version: number;
      source_version: number;
    }>;
  }> {
    const basePath = this.ensureWithinRoot(maybePath ?? relativePath(this.root, this.focusPath));
    const process = Bun.spawn({
      cmd: [
        "rg",
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        "3",
        pattern,
        basePath,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    const exitCode = await process.exited;

    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(stderr || `Search failed with exit code ${exitCode}`);
    }

    const rootPrefix = `${this.root}/`;
    const parsedResults = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, this.searchLimit)
      .map((line) => {
        const match = line.match(/^(.*?):(\d+):(.*)$/);
        if (!match) {
          return null;
        }

        const filePath = match[1];
        const lineNumber = match[2];
        const preview = match[3];
        if (!filePath || !lineNumber || preview == null) {
          return null;
        }

        const cleanPath = filePath.startsWith(rootPrefix)
          ? filePath.slice(rootPrefix.length)
          : relativePath(this.root, filePath);

        return {
          id: entryIdForPath(cleanPath),
          path: cleanPath,
          line: Number.parseInt(lineNumber, 10),
          text: preview,
          preview: truncateText(preview.trim(), 180),
        };
      })
      .filter(
        (
          value,
        ): value is { id: string; path: string; line: number; text: string; preview: string } =>
          value !== null,
      );

    const results = await Promise.all(
      parsedResults.map(async (result) => {
        const fullPath = this.ensureWithinRoot(result.path);
        const stat = await Bun.file(fullPath)
          .stat()
          .catch(() => null);
        const version = this.observeVersion(fullPath, stat?.mtimeMs ?? null);
        this.cacheAnchorLines({
          path: result.path,
          version,
          totalLines: result.line,
          lines: [result.text],
          startLine: result.line,
        });
        return {
          id: result.id,
          path: result.path,
          line: result.line,
          preview: result.preview,
          version,
        } satisfies SearchResult;
      }),
    );

    this.lastSearch = {
      pattern,
      basePath: relativePath(this.root, basePath),
      results,
    };
    this.recordRecent("search", relativePath(this.root, basePath), pattern);

    return {
      pattern,
      resultCount: results.length,
      results: results.map((result) => ({
        path: result.path,
        line: result.line,
        preview: result.preview,
        version: result.version,
        source_version: result.version,
      })),
    };
  }

  private buildEntryEditActions(relativeToRoot: string): Record<string, Action> {
    const actions: Record<string, Action> = {};

    if (this.supportsReplaceEdits()) {
      actions.edit = action(
        {
          edits: {
            type: "array",
            description: ENTRY_EDITS_DESCRIPTION,
            items: EDIT_ITEM_SCHEMA,
          },
          expected_version: {
            type: "number",
            description:
              "Optional CAS guard. Pass the version returned by the last read. expected_version=N succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }. Edit does not create files -- use write with expected_version=0 for first creation.",
            optional: true,
          },
        },
        async ({ edits, expected_version }) =>
          this.editTextFile(
            relativeToRoot,
            coerceEdits(edits),
            typeof expected_version === "number" ? expected_version : undefined,
          ),
        {
          label: "Edit File",
          description:
            "Apply one or more small exact string replacements to this file, atomically. Prefer for short, stable, unique oldText edits; use edit_range for larger or line-oriented replacements.",
          estimate: "fast",
        },
      );
    }

    if (this.supportsHashEdits()) {
      actions.edit_range = action(
        {
          edits: {
            type: "array",
            description: ENTRY_RANGE_EDITS_DESCRIPTION,
            items: RANGE_EDIT_ITEM_SCHEMA,
          },
          expected_version: {
            type: "number",
            description:
              "Optional strict whole-file CAS guard. If omitted, edit_range only checks target line tags so unrelated file changes can still be accepted.",
            optional: true,
          },
          source_version: {
            type: "number",
            description:
              "Optional source snapshot version from a prior read/search. When provided, edits can omit start_tag/end_tag and the provider derives boundary tags from cached anchors for the requested line range.",
            optional: true,
          },
        },
        async ({ edits, expected_version, source_version }) =>
          this.editRangeTextFile(
            relativeToRoot,
            coerceRangeEdits(edits),
            typeof expected_version === "number" ? expected_version : undefined,
            typeof source_version === "number" ? source_version : undefined,
          ),
        {
          label: "Edit Tagged Range",
          description:
            "Apply one or more line-range replacements. Prefer with source_version from a prior read/search for larger blocks, repeated text, fragile generated output, or whole-line edits.",
          estimate: "fast",
        },
      );
    }

    return actions;
  }

  private buildWorkspaceEditActions(): Record<string, Action> {
    const actions: Record<string, Action> = {};

    if (this.supportsReplaceEdits()) {
      actions.edit = action(
        {
          path: {
            type: "string",
            description: WORKSPACE_FILE_PATH_DESCRIPTION,
            optional: true,
          },
          edits: {
            type: "array",
            description: EDITS_DESCRIPTION,
            items: EDIT_ITEM_SCHEMA,
          },
          expected_version: {
            type: "number",
            description:
              "Optional CAS guard. Pass the version returned by the last read. expected_version=N succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }. Edit does not create files -- use write with expected_version=0 for first creation.",
            optional: true,
          },
        },
        async ({ path, edits, expected_version }) => {
          const resolvedPath = requirePathOrNestedEditPath(path, edits);
          return this.editTextFile(
            resolvedPath,
            coerceEdits(edits),
            typeof expected_version === "number" ? expected_version : undefined,
          );
        },
        {
          label: "Edit By Path",
          description:
            "Apply one or more small exact string replacements to a file relative to the workspace root, atomically. Prefer for short, stable, unique oldText edits; use edit_range for larger or line-oriented replacements.",
          estimate: "fast",
        },
      );
    }

    if (this.supportsHashEdits()) {
      actions.edit_range = action(
        {
          path: {
            type: "string",
            description: WORKSPACE_FILE_PATH_DESCRIPTION,
            optional: true,
          },
          edits: {
            type: "array",
            description: RANGE_EDITS_DESCRIPTION,
            items: RANGE_EDIT_ITEM_SCHEMA,
          },
          expected_version: {
            type: "number",
            description:
              "Optional strict whole-file CAS guard. If omitted, edit_range only checks target line tags so unrelated file changes can still be accepted.",
            optional: true,
          },
          source_version: {
            type: "number",
            description:
              "Optional source snapshot version from a prior read/search. When provided, edits can omit start_tag/end_tag and the provider derives boundary tags from cached anchors for the requested line range.",
            optional: true,
          },
        },
        async ({ path, edits, expected_version, source_version }) => {
          const resolvedPath = requirePathOrNestedEditPath(path, edits);
          return this.editRangeTextFile(
            resolvedPath,
            coerceRangeEdits(edits),
            typeof expected_version === "number" ? expected_version : undefined,
            typeof source_version === "number" ? source_version : undefined,
          );
        },
        {
          label: "Edit Tagged Range",
          description:
            "Apply one or more line-range replacements. Prefer with source_version from a prior read/search for larger blocks, repeated text, fragile generated output, or whole-line edits.",
          estimate: "fast",
        },
      );
    }

    return actions;
  }

  private buildWorkspaceItems(): ItemDescriptor[] {
    const entries = readdirSync(this.focusPath, { withFileTypes: true });
    const sorted = [...entries].sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) {
        return -1;
      }
      if (!left.isDirectory() && right.isDirectory()) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });

    const items: ItemDescriptor[] = [];
    for (const entry of sorted) {
      const fullPath = resolve(this.focusPath, entry.name);
      const info = statSync(fullPath);
      const relativeToRoot = relativePath(this.root, fullPath);
      const relativeToFocus = relativePath(this.focusPath, fullPath);
      const version = entry.isDirectory() ? undefined : this.observeVersion(fullPath, info.mtimeMs);

      items.push({
        id: entry.name,
        props: {
          name: entry.name,
          path: relativeToRoot,
          kind: entry.isDirectory() ? "directory" : "file",
          size: info.size,
          ext: entry.isDirectory() ? undefined : extname(entry.name) || undefined,
          modified: info.mtime.toISOString(),
          version,
        },
        summary: entry.isDirectory() ? `Directory ${relativeToRoot}` : `File ${relativeToRoot}`,
        actions: entry.isDirectory()
          ? {
              focus: action(async () => this.setFocus(relativeToRoot), {
                label: "Focus Directory",
                description: "Switch the focused directory to this entry.",
                idempotent: true,
                estimate: "instant",
              }),
            }
          : {
              read: action(
                actionParams(buildReadParams(this.supportsHashEdits())),
                async (params: Record<string, unknown>) => {
                  const { start_line, end_line, include_line_tags, tag_mode, include_content } =
                    params;
                  return this.readTextFile(relativeToRoot, {
                    startLine: typeof start_line === "number" ? start_line : undefined,
                    endLine: typeof end_line === "number" ? end_line : undefined,
                    includeLineTags: include_line_tags === true,
                    tagMode: tag_mode === "boundary" ? "boundary" : "all",
                    includeContent: include_content !== false,
                  });
                },
                {
                  label: "Read File",
                  description: buildReadDescription("this file", this.supportsHashEdits()),
                  idempotent: true,
                  estimate: "fast",
                },
              ),
              write: action(
                {
                  content: "string",
                  expected_version: {
                    type: "number",
                    description:
                      "Optional CAS guard. Pass the version returned by the last read to serialize concurrent writers. expected_version=0 succeeds only if the file does not exist yet (use it for atomic first-creation). expected_version=N (N>0) succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }.",
                    optional: true,
                  },
                },
                async ({ content, expected_version }) =>
                  this.writeTextFile(
                    relativeToRoot,
                    content as string,
                    typeof expected_version === "number" ? expected_version : undefined,
                  ),
                {
                  label: "Overwrite File",
                  description: buildWriteDescription(this.editMode).replace(
                    "Write a text file relative to the workspace root.",
                    "Replace this file entirely with new text content.",
                  ),
                  estimate: "fast",
                },
              ),
              ...this.buildEntryEditActions(relativeToRoot),
            },
        children: entry.isDirectory()
          ? undefined
          : {
              path: {
                type: "document",
                props: {
                  path: relativeToRoot,
                  relativeToFocus,
                },
                summary: `Use the read affordance on ${entry.name} to fetch the contents.`,
              },
            },
      });
    }

    return items;
  }

  private buildWorkspaceDescriptor() {
    return {
      type: "collection",
      props: {
        root: this.root,
        focus: relativePath(this.root, this.focusPath),
        absolute_path: this.focusPath,
        edit_mode: this.editMode,
      },
      summary: `Focused directory ${relativePath(this.root, this.focusPath)}`,
      actions: {
        set_focus: action(
          {
            path: {
              type: "string",
              description: WORKSPACE_DIRECTORY_PATH_DESCRIPTION,
            },
          },
          async ({ path }) => this.setFocus(requireString(path, "path")),
          {
            label: "Set Focus",
            description:
              "Move the filesystem focus to a directory under the workspace root. The path is a filesystem path, not a SLOP path.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        read: action(
          actionParams({
            path: {
              type: "string",
              description:
                "File or directory path relative to the filesystem workspace root, e.g. 'todo-app/src/App.jsx' or 'todo-app/src'. Required.",
            },
            ...buildReadParams(this.supportsHashEdits()),
          }),
          async (params: Record<string, unknown>) => {
            const { path, start_line, end_line, include_line_tags, tag_mode, include_content } =
              params;
            return this.readTextFile(requireString(path, "path"), {
              startLine: typeof start_line === "number" ? start_line : undefined,
              endLine: typeof end_line === "number" ? end_line : undefined,
              includeLineTags: include_line_tags === true,
              tagMode: tag_mode === "boundary" ? "boundary" : "all",
              includeContent: include_content !== false,
            });
          },
          {
            label: "Read By Path",
            description: buildReadDescription("a path", this.supportsHashEdits()),
            idempotent: true,
            estimate: "fast",
          },
        ),
        write: action(
          {
            path: {
              type: "string",
              description: WORKSPACE_FILE_PATH_DESCRIPTION,
            },
            content: {
              type: "string",
              description:
                "Full new UTF-8 text content for the file as one valid JSON string. Required. Newlines must be escaped by the tool-call serializer; if generating a very large file is error-prone, create a minimal file first and then use edit for smaller targeted replacements.",
            },
            expected_version: {
              type: "number",
              description:
                "Optional CAS guard. Pass the version returned by the last read to serialize concurrent writers. expected_version=0 succeeds only if the file does not exist yet (use it for atomic first-creation). expected_version=N (N>0) succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }.",
              optional: true,
            },
          },
          async ({ path, content, expected_version }) =>
            this.writeTextFile(
              requireString(path, "path"),
              requireText(content, "content"),
              typeof expected_version === "number" ? expected_version : undefined,
            ),
          {
            label: "Write By Path",
            description: buildWriteDescription(this.editMode),
            estimate: "fast",
          },
        ),
        ...this.buildWorkspaceEditActions(),
        mkdir: action(
          {
            path: {
              type: "string",
              description:
                "Directory path relative to the filesystem workspace root, e.g. 'todo-app/src'. Required.",
            },
          },
          async ({ path }) => this.makeDirectory(requireString(path, "path")),
          {
            label: "Create Directory",
            description: "Create a directory under the workspace root.",
            estimate: "instant",
          },
        ),
        search: action(
          {
            pattern: "string",
            path: {
              type: "string",
              description: "Optional directory relative to the workspace root.",
              optional: true,
            },
          },
          async ({ pattern, path }) =>
            this.search(
              requireString(pattern, "pattern"),
              typeof path === "string" && path ? path : undefined,
            ),
          {
            label: "Search Workspace",
            description: "Search for matching text under the focused directory or a provided path.",
            estimate: "slow",
          },
        ),
      },
      children: {
        entries: {
          type: "collection",
          props: {
            path: relativePath(this.root, this.focusPath),
            count: this.buildWorkspaceItems().length,
          },
          items: this.buildWorkspaceItems(),
        },
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
  }

  private buildSearchDescriptor() {
    return {
      type: "collection",
      props: {
        pattern: this.lastSearch?.pattern,
        basePath: this.lastSearch?.basePath,
        count: this.lastSearch?.results.length ?? 0,
      },
      summary: this.lastSearch
        ? `Last search '${this.lastSearch.pattern}' under ${this.lastSearch.basePath}`
        : "No active search.",
      items: (this.lastSearch?.results ?? []).map((result) => ({
        id: result.id,
        props: {
          path: result.path,
          line: result.line,
          version: result.version,
          source_version: result.version,
          preview: result.preview,
        },
        actions: {
          read: action(async () => this.readTextFile(result.path), {
            label: "Read Match File",
            description: "Read the file that contains this search hit.",
            idempotent: true,
            estimate: "fast",
          }),
          focus_parent: action(async () => this.setFocus(dirname(result.path)), {
            label: "Focus Parent Directory",
            description: "Move the filesystem focus to the search result's parent directory.",
            idempotent: true,
            estimate: "instant",
          }),
        },
      })),
    };
  }

  private buildRecentDescriptor() {
    return {
      type: "collection",
      props: {
        count: this.recent.length,
      },
      summary: "Recent filesystem operations.",
      items: this.recent.map((entry) => ({
        id: entry.id,
        props: {
          action: entry.action,
          path: entry.path,
          detail: entry.detail,
        },
      })),
    };
  }
}

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { debug } from "../../../core/debug";
import {
  buildEditDiffHunks,
  buildTextDiffHunk,
  type DiffHunk,
  type EditPair,
} from "../../../core/diff";
import { isWithinRoot, realpathOfPrefix, safeRealpath } from "../../../providers/path-containment";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const SOURCE_SNAPSHOT_LIMIT = 64;

type SearchResult = {
  id: string;
  path: string;
  line: number;
  preview: string;
};

type RecentFileOperation = {
  id: string;
  action: string;
  path: string;
  detail?: string;
};

type RangeEdit = {
  startLine: number;
  endLine: number;
  newText: string;
};

type EditSuccessResult = {
  path: string;
  bytes: number;
  version: number;
  edits_applied: number;
  old_bytes: number;
  new_bytes: number;
  hunks: DiffHunk[];
};

type SourceSnapshot = {
  path: string;
  version: number;
  totalLines: number;
  lines: Map<number, string>;
};

type FileViewCoverage = "full" | "range" | "preview";

type FileView = {
  id: string;
  path: string;
  absolutePath: string;
  coverage: FileViewCoverage;
  content: string;
  version: number;
  sourceVersion?: number;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  totalBytes?: number;
  truncated: boolean;
  previewOnly?: boolean;
  createdAt: string;
  updatedAt: string;
};

type FileViewResult = {
  path: string;
  view_path: string;
  view_id: string;
  coverage: FileViewCoverage;
  truncated: boolean;
  version: number;
  exists: true;
  kind: "file";
  already_loaded?: boolean;
  stale?: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  total_bytes?: number;
  preview_only?: boolean;
  source_version?: number;
};

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
  'One or more targeted replacements. Use edit for small unique string or intra-line replacements. If replacing whole lines or blocks from a read that returned source_version, prefer edit_range. Each item must be exactly { oldText, newText }. Do not put path inside each edit; for workspace-level edit, path is a top-level argument. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally, so reason about each edit independently. (4) Keep each oldText as small as possible while still unique -- do not quote the whole function. (5) If two changes touch the same block or adjacent lines, merge them into a single edit rather than emitting overlapping ones. Example: {"path":"src/App.jsx","edits":[{"oldText":"const title = \'Old\';","newText":"const title = \'New\';"}],"expected_version":3}. Errors return { error, edit_index } identifying the offending edit.';

const ENTRY_EDITS_DESCRIPTION =
  "One or more targeted replacements. Use edit for small unique string or intra-line replacements. If replacing whole lines or blocks from a read that returned source_version, prefer edit_range. This per-file action already targets the file, so each item must be exactly { oldText, newText } and must not include a path. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally. (4) Keep each oldText as small as possible while still unique. Errors return { error, edit_index } identifying the offending edit.";

const RANGE_EDIT_ITEM_SCHEMA = {
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

const RANGE_EDITS_DESCRIPTION =
  "One or more line-range replacements against a source_version returned by a prior read. Use edit_range when replacing whole lines or blocks and you already know the line numbers from the observed file view. The provider remembers the old line text it returned, validates that the current file still has the same text at those lines, and rejects with range_conflict if the view is stale. This avoids echoing oldText or model-visible hashes while still preventing wrong-place edits.";

const ENTRY_RANGE_EDITS_DESCRIPTION =
  "One or more line-range replacements against a source_version returned by a prior read of this file. The provider remembers the old line text it returned, validates that the current file still has the same text at those lines, and rejects with range_conflict if the view is stale. Use expected_version only when whole-file CAS is required.";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  const crlfCount = text.match(/\r\n/g)?.length ?? 0;
  if (crlfCount === 0) {
    return "\n";
  }
  const lfCount = (text.match(/\n/g)?.length ?? 0) - crlfCount;
  return crlfCount >= lfCount ? "\r\n" : "\n";
}

function splitTextLines(text: string): string[] {
  return text.split(/\r?\n/);
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
  return path.replace(/[^a-zA-Z0-9_.-]+/g, "__") || "root";
}

function displayNameForPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function viewIdForPath(
  path: string,
  version: number,
  coverage: FileViewCoverage,
  range?: { startLine?: number; endLine?: number },
): string {
  const base = entryIdForPath(path);
  if (coverage === "full") {
    return `${base}__v${version}`;
  }
  if (coverage === "preview") {
    return `${base}__v${version}__preview`;
  }
  return `${base}__v${version}__L${range?.startLine ?? 1}-L${range?.endLine ?? "end"}`;
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
  private recent: RecentFileOperation[] = [];
  private lastSearch: { pattern: string; basePath: string; results: SearchResult[] } | null = null;
  private fileVersions = new Map<string, number>();
  private cachedMtimes = new Map<string, number>();
  private writeLocks = new Map<string, Promise<unknown>>();
  private sourceSnapshots = new Map<string, SourceSnapshot>();
  private fileViews = new Map<string, FileView>();

  constructor(options: {
    root: string;
    focus: string;
    recentLimit: number;
    searchLimit: number;
    readMaxBytes: number;
    contentRefThresholdBytes?: number;
    previewBytes?: number;
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

    this.server = createSlopServer({
      id: "filesystem",
      name: "Filesystem",
    });

    this.server.register("workspace", () => this.buildWorkspaceDescriptor());
    this.server.register("views", () => this.buildViewsDescriptor());
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

  private sourceSnapshotKey(path: string, version: number): string {
    return `${path}\0${version}`;
  }

  private rememberSourceLines(
    relPath: string,
    version: number,
    lines: string[],
    startLine: number,
    endLine: number,
  ): void {
    const key = this.sourceSnapshotKey(relPath, version);
    const existing = this.sourceSnapshots.get(key);
    const snapshot =
      existing ??
      ({
        path: relPath,
        version,
        totalLines: lines.length,
        lines: new Map<number, string>(),
      } satisfies SourceSnapshot);

    snapshot.totalLines = Math.max(snapshot.totalLines, lines.length);
    for (let line = startLine; line <= endLine; line += 1) {
      snapshot.lines.set(line, lines[line - 1] ?? "");
    }

    if (existing) {
      this.sourceSnapshots.delete(key);
    }
    this.sourceSnapshots.set(key, snapshot);

    while (this.sourceSnapshots.size > SOURCE_SNAPSHOT_LIMIT) {
      const oldest = this.sourceSnapshots.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.sourceSnapshots.delete(oldest);
    }
  }

  private viewPath(viewId: string): string {
    return `/views/${viewId}`;
  }

  private fullViewFor(path: string, version: number): FileView | undefined {
    return [...this.fileViews.values()].find(
      (view) => view.path === path && view.version === version && view.coverage === "full",
    );
  }

  private upsertFileView(input: Omit<FileView, "createdAt" | "updatedAt">): FileView {
    const existing = this.fileViews.get(input.id);
    const now = new Date().toISOString();
    const view: FileView = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.fileViews.set(view.id, view);

    if (view.coverage === "full") {
      for (const [id, candidate] of this.fileViews) {
        if (
          id !== view.id &&
          candidate.path === view.path &&
          candidate.version === view.version &&
          candidate.coverage === "range"
        ) {
          this.fileViews.delete(id);
        }
      }
    }

    return view;
  }

  private fileViewResult(
    view: FileView,
    options: { alreadyLoaded?: boolean; stale?: boolean } = {},
  ): FileViewResult {
    return {
      path: view.path,
      view_path: this.viewPath(view.id),
      view_id: view.id,
      coverage: view.coverage,
      truncated: view.truncated,
      version: view.version,
      exists: true,
      kind: "file",
      ...(options.alreadyLoaded ? { already_loaded: true } : {}),
      ...(options.stale ? { stale: true } : {}),
      ...(view.startLine !== undefined ? { startLine: view.startLine } : {}),
      ...(view.endLine !== undefined ? { endLine: view.endLine } : {}),
      ...(view.totalLines !== undefined ? { totalLines: view.totalLines } : {}),
      ...(view.totalBytes !== undefined ? { total_bytes: view.totalBytes } : {}),
      ...(view.previewOnly ? { preview_only: true } : {}),
      ...(view.sourceVersion !== undefined ? { source_version: view.sourceVersion } : {}),
    };
  }

  private closeFileView(viewId: string): { view_id: string; removed: boolean } {
    const removed = this.fileViews.delete(viewId);
    this.recordRecent("close_view", viewId, removed ? "removed" : "not found");
    this.server.refresh();
    return { view_id: viewId, removed };
  }

  private closeAllFileViews(): { removed: number } {
    const removed = this.fileViews.size;
    this.fileViews.clear();
    this.recordRecent("close_views", ".", `${removed} removed`);
    this.server.refresh();
    return { removed };
  }

  private currentVersionForView(view: FileView): number {
    try {
      const stat = statSync(view.absolutePath);
      return this.observeVersion(view.absolutePath, stat.mtimeMs);
    } catch {
      return this.observeVersion(view.absolutePath, null);
    }
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
    range?: { startLine?: number; endLine?: number },
  ): Promise<
    | {
        path: string;
        content?: string;
        truncated: boolean;
        version: number;
        exists: boolean;
        startLine?: number;
        endLine?: number;
        totalLines?: number;
        preview_only?: boolean;
        total_bytes?: number;
        ref?: {
          kind: "fs";
          path: string;
          version: number;
          total_bytes: number;
          total_lines: number;
        };
        source_version?: number;
        kind?: "file" | "directory";
        entries?: Array<{ name: string; path: string; kind: "file" | "directory"; size: number }>;
        hint?: string;
      }
    | FileViewResult
  > {
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
        hint: "This path is a directory. Use set_focus or query_state for richer directory state, or read a specific file path for file contents.",
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
      const lineEnding = detectLineEnding(fullText);
      const lines = splitTextLines(fullText);
      const totalLines = lines.length;
      const startLine = Math.max(1, range?.startLine ?? 1);
      const endLine = Math.min(totalLines, range?.endLine ?? totalLines);

      if (startLine > endLine) {
        throw new Error(`Invalid range: start_line (${startLine}) is after end_line (${endLine}).`);
      }

      const sliced = lines.slice(startLine - 1, endLine).join(lineEnding);
      const truncated = sliced.length > this.readMaxBytes;
      const text = truncated ? truncateText(sliced, this.readMaxBytes) : sliced;
      const existingFullView = this.fullViewFor(relPath, version);
      if (existingFullView) {
        this.recordRecent(
          "read",
          relPath,
          `already loaded fully at ${this.viewPath(existingFullView.id)}`,
        );
        return this.fileViewResult(existingFullView, { alreadyLoaded: true });
      }
      if (!truncated) {
        this.rememberSourceLines(relPath, version, lines, startLine, endLine);
      }
      this.recordRecent("read", relPath, `lines ${startLine}-${endLine}`);
      const view = this.upsertFileView({
        id: viewIdForPath(relPath, version, "range", { startLine, endLine }),
        path: relPath,
        absolutePath: fullPath,
        coverage: "range",
        content: text,
        version,
        sourceVersion: truncated ? undefined : version,
        startLine,
        endLine,
        totalLines,
        totalBytes: bytes.byteLength,
        truncated,
      });

      return this.fileViewResult(view);
    }

    // No explicit range: decide whether to return full content or a preview+ref.
    if (bytes.byteLength > this.contentRefThresholdBytes) {
      const previewText = TEXT_DECODER.decode(bytes.subarray(0, this.previewBytes));
      const totalLines = splitTextLines(TEXT_DECODER.decode(bytes)).length;
      this.recordRecent("read", relPath, "preview+ref");
      const view = this.upsertFileView({
        id: viewIdForPath(relPath, version, "preview"),
        path: relPath,
        absolutePath: fullPath,
        coverage: "preview",
        content: truncateText(previewText, this.previewBytes),
        version,
        totalLines,
        totalBytes: bytes.byteLength,
        truncated: true,
        previewOnly: true,
      });

      return this.fileViewResult(view);
    }

    const truncated = bytes.byteLength > this.readMaxBytes;
    const text = TEXT_DECODER.decode(bytes.subarray(0, this.readMaxBytes));
    const coverage = truncated ? "preview" : "full";
    if (!truncated) {
      const lines = splitTextLines(text);
      this.rememberSourceLines(relPath, version, lines, 1, lines.length);
    }
    this.recordRecent("read", relPath);
    const totalLines = splitTextLines(text).length;
    const view = this.upsertFileView({
      id: viewIdForPath(relPath, version, coverage),
      path: relPath,
      absolutePath: fullPath,
      coverage,
      content: truncated ? truncateText(text, this.readMaxBytes) : text,
      version,
      sourceVersion: truncated ? undefined : version,
      totalLines,
      totalBytes: bytes.byteLength,
      truncated,
      previewOnly: truncated,
    });

    return this.fileViewResult(view);
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
    | EditSuccessResult
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
        old_bytes: originalBytes.byteLength,
        new_bytes: bytes,
        hunks: buildEditDiffHunks(edits),
      };
    });
  }

  private async editRangeTextFile(
    inputPath: string,
    sourceVersion: number | undefined,
    edits: ReadonlyArray<RangeEdit>,
    expectedVersion?: number,
  ): Promise<
    | EditSuccessResult
    | { error: "version_conflict"; currentVersion: number; path: string }
    | {
        error:
          | "empty_edits"
          | "file_not_found"
          | "invalid_range"
          | "missing_source"
          | "source_range_not_observed"
          | "range_conflict"
          | "overlap"
          | "identical_text";
        path: string;
        source_version?: number;
        edit_index?: number;
        line?: number;
      }
  > {
    const fullPath = this.ensureWithinRoot(inputPath);
    const relPath = relativePath(this.root, fullPath);

    if (edits.length === 0) {
      return { error: "empty_edits" as const, path: relPath };
    }
    if (sourceVersion === undefined || !Number.isInteger(sourceVersion) || sourceVersion < 1) {
      return { error: "missing_source" as const, path: relPath };
    }

    const snapshot = this.sourceSnapshots.get(this.sourceSnapshotKey(relPath, sourceVersion));
    if (!snapshot) {
      return {
        error: "missing_source" as const,
        path: relPath,
        source_version: sourceVersion,
      };
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
      const lineEnding = detectLineEnding(original);
      const currentLines = splitTextLines(original);
      const diffPairs: Array<EditPair & { startLine: number }> = [];

      const sorted = [...edits].sort((left, right) => left.startLine - right.startLine);
      for (let index = 0; index < sorted.length; index += 1) {
        const edit = sorted[index];
        if (!edit) {
          continue;
        }
        if (
          !Number.isInteger(edit.startLine) ||
          !Number.isInteger(edit.endLine) ||
          edit.startLine < 1 ||
          edit.endLine < edit.startLine
        ) {
          return {
            error: "invalid_range" as const,
            path: relPath,
            source_version: sourceVersion,
            edit_index: edits.indexOf(edit),
          };
        }
        const previous = sorted[index - 1];
        if (previous && edit.startLine <= previous.endLine) {
          return {
            error: "overlap" as const,
            path: relPath,
            source_version: sourceVersion,
            edit_index: edits.indexOf(edit),
          };
        }
      }

      for (const edit of edits) {
        const originalIndex = edits.indexOf(edit);
        const oldLines: string[] = [];
        for (let line = edit.startLine; line <= edit.endLine; line += 1) {
          const oldLine = snapshot.lines.get(line);
          if (oldLine === undefined) {
            return {
              error: "source_range_not_observed" as const,
              path: relPath,
              source_version: sourceVersion,
              edit_index: originalIndex,
              line,
            };
          }
          oldLines.push(oldLine);
        }

        for (let offset = 0; offset < oldLines.length; offset += 1) {
          const line = edit.startLine + offset;
          if (currentLines[line - 1] !== oldLines[offset]) {
            debug("filesystem", "edit_range_conflict", {
              path: relPath,
              source_version: sourceVersion,
              edit_index: originalIndex,
              line,
            });
            return {
              error: "range_conflict" as const,
              path: relPath,
              source_version: sourceVersion,
              edit_index: originalIndex,
              line,
            };
          }
        }

        const replacementLines = edit.newText.length === 0 ? [] : splitTextLines(edit.newText);
        if (oldLines.join("\n") === replacementLines.join("\n")) {
          return {
            error: "identical_text" as const,
            path: relPath,
            source_version: sourceVersion,
            edit_index: originalIndex,
          };
        }
        diffPairs.push({
          oldText: oldLines.join(lineEnding),
          newText: edit.newText,
          startLine: edit.startLine,
        });
      }

      const nextLines = [...currentLines];
      for (let index = sorted.length - 1; index >= 0; index -= 1) {
        const edit = sorted[index];
        if (!edit) {
          continue;
        }
        const replacementLines = edit.newText.length === 0 ? [] : splitTextLines(edit.newText);
        nextLines.splice(
          edit.startLine - 1,
          edit.endLine - edit.startLine + 1,
          ...replacementLines,
        );
      }

      const next = nextLines.join(lineEnding);
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
        source_version: sourceVersion,
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
        old_bytes: originalBytes.byteLength,
        new_bytes: bytes,
        hunks: diffPairs.map((pair) =>
          buildTextDiffHunk(pair.oldText, pair.newText, {
            oldStart: pair.startLine,
            newStart: pair.startLine,
          }),
        ),
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
  ): Promise<{ pattern: string; resultCount: number }> {
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
    const results = stdout
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
          preview: truncateText(preview.trim(), 180),
        } satisfies SearchResult;
      })
      .filter((value): value is SearchResult => value !== null);

    this.lastSearch = {
      pattern,
      basePath: relativePath(this.root, basePath),
      results,
    };
    this.recordRecent("search", relativePath(this.root, basePath), pattern);

    return {
      pattern,
      resultCount: results.length,
    };
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
                {
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
                },
                async ({ start_line, end_line }) =>
                  this.readTextFile(relativeToRoot, {
                    startLine: typeof start_line === "number" ? start_line : undefined,
                    endLine: typeof end_line === "number" ? end_line : undefined,
                  }),
                {
                  label: "Read File",
                  description:
                    "Load this file as a provider-owned File view under /views and return a compact reference. Pass start_line/end_line to load a slice. Use source_version with edit_range for line-range edits against this observed view.",
                  idempotent: true,
                  estimate: "fast",
                  resultKind: "code",
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
                  description:
                    "Replace this file entirely with new text content. Use `write` for new files, full rewrites, or regenerating a file from scratch; for targeted existing-file changes prefer `edit` or `edit_range`.",
                  estimate: "fast",
                },
              ),
              edit: action(
                {
                  edits: {
                    type: "array",
                    description: ENTRY_EDITS_DESCRIPTION,
                    items: EDIT_ITEM_SCHEMA,
                  },
                  expected_version: {
                    type: "number",
                    description:
                      "Optional CAS guard. Pass the version returned by the last read. expected_version=N succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }. Edit does not create files — use write with expected_version=0 for first creation.",
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
                    "Apply one or more strict string-replacements to this file, atomically. Use for small unique string or intra-line replacements. For whole-line/block edits after a read returned source_version, prefer `edit_range`.",
                  estimate: "fast",
                  resultKind: "diff",
                },
              ),
              edit_range: action(
                {
                  source_version: {
                    type: "number",
                    description:
                      "Required source view returned by a prior read of this file. The provider validates current file lines against the remembered source view before applying edits.",
                  },
                  edits: {
                    type: "array",
                    description: ENTRY_RANGE_EDITS_DESCRIPTION,
                    items: RANGE_EDIT_ITEM_SCHEMA,
                  },
                  expected_version: {
                    type: "number",
                    description:
                      "Optional strict whole-file CAS guard. Omit this to allow unrelated file changes when the edited range still matches the remembered source view.",
                    optional: true,
                  },
                },
                async ({ source_version, edits, expected_version }) =>
                  this.editRangeTextFile(
                    relativeToRoot,
                    typeof source_version === "number" ? source_version : undefined,
                    coerceRangeEdits(edits),
                    typeof expected_version === "number" ? expected_version : undefined,
                  ),
                {
                  label: "Edit Line Range",
                  description:
                    "Apply one or more line-range replacements to this file using the remembered source view from a prior read. Preferred for whole-line/block edits when line numbers are known.",
                  estimate: "fast",
                  resultKind: "diff",
                },
              ),
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
                summary: `Use the read affordance on ${entry.name} to load a File view under /views.`,
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
          {
            path: {
              type: "string",
              description:
                "File or directory path relative to the filesystem workspace root, e.g. 'todo-app/src/App.jsx' or 'todo-app/src'. Required.",
            },
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
          },
          async ({ path, start_line, end_line }) =>
            this.readTextFile(requireString(path, "path"), {
              startLine: typeof start_line === "number" ? start_line : undefined,
              endLine: typeof end_line === "number" ? end_line : undefined,
            }),
          {
            label: "Read By Path",
            description:
              "Read a path relative to the workspace root. For text files, loads a provider-owned File view under /views and returns { view_path, version, source_version, exists, kind: 'file', ... } without file content in the result. For directories, returns { kind: 'directory', entries, content } as a compact listing. For a nonexistent file returns { content: '', version: 0, exists: false } so callers can use a uniform read->write(expected_version) loop. Pass start_line/end_line to load a slice of an existing file. Use source_version with edit_range for line-range edits against the observed view.",
            idempotent: true,
            estimate: "fast",
            resultKind: "code",
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
            description:
              "Write a text file relative to the workspace root. Use `write` for new files (with expected_version=0), full rewrites, or regeneration; for targeted existing-file changes prefer `edit` or `edit_range`.",
            estimate: "fast",
          },
        ),
        edit: action(
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
                "Optional CAS guard. Pass the version returned by the last read. expected_version=N succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }. Edit does not create files — use write with expected_version=0 for first creation.",
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
              "Apply one or more strict string-replacements to a file relative to the workspace root, atomically. Use for small unique string or intra-line replacements. For whole-line/block edits after a read returned source_version, prefer `edit_range`.",
            estimate: "fast",
            resultKind: "diff",
          },
        ),
        edit_range: action(
          {
            path: {
              type: "string",
              description: WORKSPACE_FILE_PATH_DESCRIPTION,
            },
            source_version: {
              type: "number",
              description:
                "Required source view returned by a prior read of this path. The provider validates current file lines against the remembered source view before applying edits.",
            },
            edits: {
              type: "array",
              description: RANGE_EDITS_DESCRIPTION,
              items: RANGE_EDIT_ITEM_SCHEMA,
            },
            expected_version: {
              type: "number",
              description:
                "Optional strict whole-file CAS guard. Omit this to allow unrelated file changes when the edited range still matches the remembered source view.",
              optional: true,
            },
          },
          async ({ path, source_version, edits, expected_version }) =>
            this.editRangeTextFile(
              requireString(path, "path"),
              typeof source_version === "number" ? source_version : undefined,
              coerceRangeEdits(edits),
              typeof expected_version === "number" ? expected_version : undefined,
            ),
          {
            label: "Edit Line Range By Path",
            description:
              "Apply one or more line-range replacements using the remembered source view from a prior read. Preferred for whole-line/block edits when line numbers are known and oldText echoing would be noisy.",
            estimate: "fast",
            resultKind: "diff",
          },
        ),
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
    };
  }

  private buildViewsDescriptor() {
    const views = [...this.fileViews.values()].sort((left, right) => {
      const pathComparison = left.path.localeCompare(right.path);
      if (pathComparison !== 0) return pathComparison;
      const coverageComparison = left.coverage.localeCompare(right.coverage);
      if (coverageComparison !== 0) return coverageComparison;
      return left.id.localeCompare(right.id);
    });
    const items = views.map((view) => {
      const currentVersion = this.currentVersionForView(view);
      const stale = currentVersion !== view.version;
      return {
        id: view.id,
        props: {
          path: view.path,
          coverage: view.coverage,
          content: view.content,
          version: view.version,
          current_version: currentVersion,
          stale,
          truncated: view.truncated,
          preview_only: view.previewOnly ?? false,
          source_version: view.sourceVersion,
          start_line: view.startLine,
          end_line: view.endLine,
          total_lines: view.totalLines,
          total_bytes: view.totalBytes,
          created_at: view.createdAt,
          updated_at: view.updatedAt,
        },
        summary: stale
          ? `${view.path} ${view.coverage} view is stale (source v${view.version}, current v${currentVersion})`
          : `${view.path} ${view.coverage} view`,
        actions: {
          close_view: action(async () => this.closeFileView(view.id), {
            label: "Close File View",
            description:
              "Remove this loaded file view from filesystem provider state and future default projections.",
            idempotent: true,
            estimate: "instant",
          }),
        },
      } satisfies ItemDescriptor;
    });
    const staleCount = items.filter((item) => item.props.stale === true).length;

    return {
      type: "collection",
      props: {
        count: items.length,
        stale_count: staleCount,
      },
      summary:
        items.length === 0
          ? "No loaded file views."
          : `${items.length} loaded file view${items.length === 1 ? "" : "s"}${staleCount > 0 ? `, ${staleCount} stale` : ""}.`,
      actions: {
        close_view: action(
          {
            view_id: {
              type: "string",
              description: "Loaded file view id to remove.",
            },
          },
          async ({ view_id }) => this.closeFileView(requireString(view_id, "view_id")),
          {
            label: "Close File View",
            description: "Remove one loaded file view by id.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        close_all: action(async () => this.closeAllFileViews(), {
          label: "Close All File Views",
          description: "Remove all loaded file views from filesystem provider state.",
          idempotent: true,
          estimate: "instant",
        }),
      },
      items,
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
          preview: result.preview,
        },
        actions: {
          read: action(async () => this.readTextFile(result.path), {
            label: "Read Match File",
            description: "Read the file that contains this search hit.",
            idempotent: true,
            estimate: "fast",
            resultKind: "code",
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

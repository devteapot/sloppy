import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { debug } from "../../core/debug";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

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
  'One or more targeted replacements. Each item must be exactly { oldText, newText }. Do not put path inside each edit; for workspace-level edit, path is a top-level argument. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally, so reason about each edit independently. (4) Keep each oldText as small as possible while still unique -- do not quote the whole function. (5) If two changes touch the same block or adjacent lines, merge them into a single edit rather than emitting overlapping ones. Example: {"path":"src/App.jsx","edits":[{"oldText":"const title = \'Old\';","newText":"const title = \'New\';"}],"expected_version":3}. Errors return { error, edit_index } identifying the offending edit.';

const ENTRY_EDITS_DESCRIPTION =
  "One or more targeted replacements. This per-file action already targets the file, so each item must be exactly { oldText, newText } and must not include a path. Rules: (1) oldText must match EXACTLY -- no fuzzy/whitespace tolerance. (2) Each oldText must occur exactly ONCE in the original file; if it appears multiple times, expand it with surrounding context until unique. (3) All edits are matched against the ORIGINAL file content, not incrementally. (4) Keep each oldText as small as possible while still unique. Errors return { error, edit_index } identifying the offending edit.";

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

  constructor(options: {
    root: string;
    focus: string;
    recentLimit: number;
    searchLimit: number;
    readMaxBytes: number;
    contentRefThresholdBytes?: number;
    previewBytes?: number;
  }) {
    this.root = resolve(options.root);
    this.focusPath = resolve(options.focus || options.root);
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
      const relativeToRoot = relative(this.root, trimmed);
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
    if (resolved !== this.root && !resolved.startsWith(`${this.root}/`)) {
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
    range?: { startLine?: number; endLine?: number },
  ): Promise<{
    path: string;
    content: string;
    truncated: boolean;
    version: number;
    exists: boolean;
    startLine?: number;
    endLine?: number;
    totalLines?: number;
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
      this.recordRecent("read", relPath, `lines ${startLine}-${endLine}`);

      return {
        path: relPath,
        content: text,
        truncated,
        version,
        exists: true,
        kind: "file",
        startLine,
        endLine,
        totalLines,
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
    this.recordRecent("read", relPath);

    return {
      path: relPath,
      content: truncated ? truncateText(text, this.readMaxBytes) : text,
      truncated,
      version,
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
                  },
                  end_line: {
                    type: "number",
                    description: "Optional 1-based end line (inclusive).",
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
                    "Read this file as text. Returns { content, version, exists, ... }. Pass start_line/end_line to read just a slice.",
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
                    "Replace this file entirely with new text content. Prefer `edit` for targeted changes; use `write` only for full rewrites or when the file should be regenerated from scratch.",
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
                    "Apply one or more strict string-replacements to this file, atomically. Preferred over `write` for targeted changes: cheaper, safer, and each oldText being unique prevents wrong-place edits. See the `edits` parameter for the contract.",
                  estimate: "fast",
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
            },
            end_line: {
              type: "number",
              description: "Optional 1-based end line (inclusive).",
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
              "Read a path relative to the workspace root. For files, returns { content, version, exists, kind: 'file', ... }. For directories, returns { kind: 'directory', entries, content } as a compact listing. For a nonexistent file returns { content: '', version: 0, exists: false } so callers can use a uniform read->write(expected_version) loop. Pass start_line/end_line to read just a slice of an existing file.",
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
              "Write a text file relative to the workspace root. Prefer `edit` for targeted changes to existing files; use `write` for new files (with expected_version=0) or full rewrites.",
            estimate: "fast",
          },
        ),
        edit: action(
          {
            path: {
              type: "string",
              description: WORKSPACE_FILE_PATH_DESCRIPTION,
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
              "Apply one or more strict string-replacements to a file relative to the workspace root, atomically. Preferred over `write` for targeted changes: cheaper, safer, and each oldText being unique prevents wrong-place edits. See the `edits` parameter for the contract.",
            estimate: "fast",
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

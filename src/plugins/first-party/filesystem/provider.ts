import { readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createSlopServer, type SlopServer } from "@slop-ai/server";

import { debug } from "../../../core/debug";
import { buildEditDiffHunks, buildTextDiffHunk, type EditPair } from "../../../core/diff";
import { isWithinRoot, realpathOfPrefix, safeRealpath } from "../../../providers/path-containment";
import type { FilesystemDescriptorContext } from "./descriptor-context";
import { FileViewStore } from "./file-view-store";
import { invalidInput } from "./input";
import type {
  EditSuccessResult,
  FileViewResult,
  RangeEdit,
  RecentFileOperation,
  SearchResult,
} from "./model";
import {
  buildRecentDescriptor,
  buildSearchDescriptor,
  buildViewsDescriptor,
} from "./state-descriptors";
import {
  detectLineEnding,
  displayNameForPath,
  entryIdForPath,
  isProbablyBinary,
  relativePath,
  splitTextLines,
  TEXT_DECODER,
  TEXT_ENCODER,
  truncateText,
  viewIdForPath,
} from "./text";
import { buildWorkspaceDescriptor } from "./workspace-descriptor";

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
  private writeLocks = new Map<string, Promise<unknown>>();
  private views: FileViewStore;

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
    this.views = new FileViewStore(this.root);
    this.recentLimit = options.recentLimit;
    this.searchLimit = options.searchLimit;
    this.readMaxBytes = options.readMaxBytes;
    this.contentRefThresholdBytes = options.contentRefThresholdBytes ?? 8192;
    this.previewBytes = options.previewBytes ?? 2048;

    this.server = createSlopServer({
      id: "filesystem",
      name: "Filesystem",
    });

    this.server.register("workspace", () => buildWorkspaceDescriptor(this.descriptorContext()));
    this.server.register("views", () => buildViewsDescriptor(this.descriptorContext()));
    this.server.register("search", () => buildSearchDescriptor(this.descriptorContext()));
    this.server.register("recent", () => buildRecentDescriptor(this.descriptorContext()));
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

  private closeFileView(viewId: string): { view_id: string; removed: boolean } {
    const removed = this.views.closeView(viewId);
    this.recordRecent("close_view", viewId, removed ? "removed" : "not found");
    this.server.refresh();
    return { view_id: viewId, removed };
  }

  private closeAllFileViews(): { removed: number } {
    const removed = this.views.clearViews();
    this.recordRecent("close_views", ".", `${removed} removed`);
    this.server.refresh();
    return { removed };
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
        version: this.views.observeVersion(fullPath, null),
        exists: false,
      };
    }
    const version = this.views.observeVersion(fullPath, stat.mtimeMs);
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
      const existingFullView = this.views.fullViewFor(relPath, version);
      if (existingFullView) {
        this.recordRecent(
          "read",
          relPath,
          `already loaded fully at ${this.views.viewPath(existingFullView.id)}`,
        );
        return this.views.result(existingFullView, { alreadyLoaded: true });
      }
      if (!truncated) {
        this.views.rememberSourceLines(relPath, version, lines, startLine, endLine);
      }
      this.recordRecent("read", relPath, `lines ${startLine}-${endLine}`);
      const view = this.views.upsertView({
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

      return this.views.result(view);
    }

    // No explicit range: decide whether to return full content or a preview+ref.
    if (bytes.byteLength > this.contentRefThresholdBytes) {
      const previewText = TEXT_DECODER.decode(bytes.subarray(0, this.previewBytes));
      const totalLines = splitTextLines(TEXT_DECODER.decode(bytes)).length;
      this.recordRecent("read", relPath, "preview+ref");
      const view = this.views.upsertView({
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

      return this.views.result(view);
    }

    const truncated = bytes.byteLength > this.readMaxBytes;
    const text = TEXT_DECODER.decode(bytes.subarray(0, this.readMaxBytes));
    const coverage = truncated ? "preview" : "full";
    if (!truncated) {
      const lines = splitTextLines(text);
      this.views.rememberSourceLines(relPath, version, lines, 1, lines.length);
    }
    this.recordRecent("read", relPath);
    const totalLines = splitTextLines(text).length;
    const view = this.views.upsertView({
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

    return this.views.result(view);
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
      const currentVersion = this.views.observeVersion(fullPath, preStat?.mtimeMs ?? null);

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
      const version = this.views.bumpVersion(fullPath, postStat?.mtimeMs ?? null);
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
      const currentVersion = this.views.observeVersion(fullPath, preStat?.mtimeMs ?? null);

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
      const version = this.views.bumpVersion(fullPath, postStat?.mtimeMs ?? null);
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

    const snapshot = this.views.sourceSnapshot(relPath, sourceVersion);
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
      const currentVersion = this.views.observeVersion(fullPath, preStat?.mtimeMs ?? null);

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
      const version = this.views.bumpVersion(fullPath, postStat?.mtimeMs ?? null);
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

  private descriptorContext(): FilesystemDescriptorContext {
    return {
      root: this.root,
      focusPath: this.focusPath,
      recent: this.recent,
      lastSearch: this.lastSearch,
      views: this.views,
      setFocus: (path) => this.setFocus(path),
      read: (path, range) => this.readTextFile(path, range),
      write: (path, content, expectedVersion) => this.writeTextFile(path, content, expectedVersion),
      edit: (path, edits, expectedVersion) => this.editTextFile(path, edits, expectedVersion),
      editRange: (path, sourceVersion, edits, expectedVersion) =>
        this.editRangeTextFile(path, sourceVersion, edits, expectedVersion),
      makeDirectory: (path) => this.makeDirectory(path),
      search: (pattern, path) => this.search(pattern, path),
      closeView: (viewId) => this.closeFileView(viewId),
      closeAllViews: () => this.closeAllFileViews(),
    };
  }
}

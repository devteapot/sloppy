import { readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

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

  private ensureWithinRoot(inputPath: string): string {
    const resolved = resolve(this.root, inputPath);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}/`)) {
      throw new Error(`Path escapes filesystem root: ${inputPath}`);
    }
    return resolved;
  }

  private observeVersion(absolutePath: string, mtimeMs: number | null): number {
    const cachedMtime = this.cachedMtimes.get(absolutePath);
    const existing = this.fileVersions.get(absolutePath);

    if (existing === undefined) {
      const initial = 1;
      this.fileVersions.set(absolutePath, initial);
      if (mtimeMs != null) {
        this.cachedMtimes.set(absolutePath, mtimeMs);
      }
      return initial;
    }

    if (mtimeMs != null && cachedMtime != null && mtimeMs !== cachedMtime) {
      const next = existing + 1;
      this.fileVersions.set(absolutePath, next);
      this.cachedMtimes.set(absolutePath, mtimeMs);
      return next;
    }

    if (mtimeMs != null && cachedMtime == null) {
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
    startLine?: number;
    endLine?: number;
    totalLines?: number;
    preview_only?: boolean;
    total_bytes?: number;
    ref?: { kind: "fs"; path: string; version: number; total_bytes: number; total_lines: number };
  }> {
    const fullPath = this.ensureWithinRoot(inputPath);
    const bytes = await Bun.file(fullPath).bytes();
    const stat = await Bun.file(fullPath)
      .stat()
      .catch(() => null);
    const version = this.observeVersion(fullPath, stat?.mtimeMs ?? null);

    if (isProbablyBinary(bytes)) {
      return {
        path: relativePath(this.root, fullPath),
        content: `[binary file ${displayNameForPath(inputPath)} omitted]`,
        truncated: false,
        version,
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
      this.recordRecent("read", relativePath(this.root, fullPath), `lines ${startLine}-${endLine}`);

      return {
        path: relativePath(this.root, fullPath),
        content: text,
        truncated,
        version,
        startLine,
        endLine,
        totalLines,
      };
    }

    // No explicit range: decide whether to return full content or a preview+ref.
    if (bytes.byteLength > this.contentRefThresholdBytes) {
      const relPath = relativePath(this.root, fullPath);
      const previewText = TEXT_DECODER.decode(bytes.subarray(0, this.previewBytes));
      const totalLines = TEXT_DECODER.decode(bytes).split("\n").length;
      this.recordRecent("read", relPath, "preview+ref");

      return {
        path: relPath,
        content: truncateText(previewText, this.previewBytes),
        truncated: true,
        version,
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
    this.recordRecent("read", relativePath(this.root, fullPath));

    return {
      path: relativePath(this.root, fullPath),
      content: truncated ? truncateText(text, this.readMaxBytes) : text,
      truncated,
      version,
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
                    "Read this file as text. Pass start_line/end_line to read just a slice.",
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
                      "Optional CAS guard. If set, write fails with version_conflict when the file's current version does not match.",
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
                  description: "Replace this file with new text content.",
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
        set_focus: action({ path: "string" }, async ({ path }) => this.setFocus(path), {
          label: "Set Focus",
          description:
            "Move the filesystem focus to a different directory under the workspace root.",
          idempotent: true,
          estimate: "instant",
        }),
        read: action(
          {
            path: "string",
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
            this.readTextFile(path as string, {
              startLine: typeof start_line === "number" ? start_line : undefined,
              endLine: typeof end_line === "number" ? end_line : undefined,
            }),
          {
            label: "Read By Path",
            description:
              "Read a text file relative to the workspace root. Pass start_line/end_line to read just a slice.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        write: action(
          {
            path: "string",
            content: "string",
            expected_version: {
              type: "number",
              description:
                "Optional CAS guard. If set, write fails with version_conflict when the file's current version does not match.",
            },
          },
          async ({ path, content, expected_version }) =>
            this.writeTextFile(
              path as string,
              content as string,
              typeof expected_version === "number" ? expected_version : undefined,
            ),
          {
            label: "Write By Path",
            description: "Write a text file relative to the workspace root.",
            estimate: "fast",
          },
        ),
        mkdir: action({ path: "string" }, async ({ path }) => this.makeDirectory(path), {
          label: "Create Directory",
          description: "Create a directory under the workspace root.",
          estimate: "instant",
        }),
        search: action(
          {
            pattern: "string",
            path: {
              type: "string",
              description: "Optional directory relative to the workspace root.",
            },
          },
          async ({ pattern, path }) =>
            this.search(pattern, typeof path === "string" && path ? path : undefined),
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

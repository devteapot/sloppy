import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

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

function isProbablyBinary(content: Buffer): boolean {
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
  private recent: RecentFileOperation[] = [];
  private lastSearch: { pattern: string; basePath: string; results: SearchResult[] } | null = null;

  constructor(options: {
    root: string;
    focus: string;
    recentLimit: number;
    searchLimit: number;
    readMaxBytes: number;
  }) {
    this.root = resolve(options.root);
    this.focusPath = resolve(options.focus || options.root);
    this.recentLimit = options.recentLimit;
    this.searchLimit = options.searchLimit;
    this.readMaxBytes = options.readMaxBytes;

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
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  private async setFocus(inputPath: string): Promise<{ path: string }> {
    const nextPath = this.ensureWithinRoot(inputPath);
    const info = await stat(nextPath);
    if (!info.isDirectory()) {
      throw new Error(`Focus path is not a directory: ${inputPath}`);
    }

    this.focusPath = nextPath;
    this.recordRecent("focus", relativePath(this.root, nextPath));
    return { path: relativePath(this.root, nextPath) };
  }

  private async readTextFile(
    inputPath: string,
  ): Promise<{ path: string; content: string; truncated: boolean }> {
    const fullPath = this.ensureWithinRoot(inputPath);
    const buffer = await readFile(fullPath);
    if (isProbablyBinary(buffer)) {
      return {
        path: relativePath(this.root, fullPath),
        content: `[binary file ${displayNameForPath(inputPath)} omitted]`,
        truncated: false,
      };
    }

    const truncated = buffer.byteLength > this.readMaxBytes;
    const text = buffer.subarray(0, this.readMaxBytes).toString("utf8");
    this.recordRecent("read", relativePath(this.root, fullPath));

    return {
      path: relativePath(this.root, fullPath),
      content: truncated ? truncateText(text, this.readMaxBytes) : text,
      truncated,
    };
  }

  private async writeTextFile(
    inputPath: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    const fullPath = this.ensureWithinRoot(inputPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    this.recordRecent("write", relativePath(this.root, fullPath), `${content.length} chars`);
    return {
      path: relativePath(this.root, fullPath),
      bytes: Buffer.byteLength(content),
    };
  }

  private async makeDirectory(inputPath: string): Promise<{ path: string }> {
    const fullPath = this.ensureWithinRoot(inputPath);
    await mkdir(fullPath, { recursive: true });
    this.recordRecent("mkdir", relativePath(this.root, fullPath));
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

      items.push({
        id: entry.name,
        props: {
          name: entry.name,
          path: relativeToRoot,
          kind: entry.isDirectory() ? "directory" : "file",
          size: info.size,
          ext: entry.isDirectory() ? undefined : extname(entry.name) || undefined,
          modified: info.mtime.toISOString(),
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
              read: action(async () => this.readTextFile(relativeToRoot), {
                label: "Read File",
                description: "Read this file as text.",
                idempotent: true,
                estimate: "fast",
              }),
              write: action(
                { content: "string" },
                async ({ content }) => this.writeTextFile(relativeToRoot, content),
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
        read: action({ path: "string" }, async ({ path }) => this.readTextFile(path), {
          label: "Read By Path",
          description: "Read a text file relative to the workspace root.",
          idempotent: true,
          estimate: "fast",
        }),
        write: action(
          { path: "string", content: "string" },
          async ({ path, content }) => this.writeTextFile(path, content),
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

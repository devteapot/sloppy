import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./render-safety";
import { accent, bold } from "./theme";

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_ENTRIES = 6000;
const DEFAULT_MAX_DEPTH = 12;
const CACHE_TTL_MS = 2_000;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
]);

export type WorkspaceFileEntry = {
  path: string;
  name: string;
  directory: boolean;
};

export class FileAutocompleteProvider implements AutocompleteProvider {
  private workspaceRoot: string | null;
  private cache: { root: string; createdAt: number; entries: WorkspaceFileEntry[] } | null = null;

  constructor(
    workspaceRoot: string | null = null,
    private readonly options: {
      limit?: number;
      maxEntries?: number;
      maxDepth?: number;
      now?: () => number;
    } = {},
  ) {
    this.workspaceRoot = workspaceRoot;
  }

  setWorkspaceRoot(root: string | null | undefined): void {
    const next = root && root.trim().length > 0 ? resolve(root) : null;
    if (this.workspaceRoot === next) {
      return;
    }
    this.workspaceRoot = next;
    this.cache = null;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    if (options.signal.aborted || !this.workspaceRoot) {
      return null;
    }

    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const prefix = filePrefixBeforeCursor(textBeforeCursor);
    if (!prefix) {
      return null;
    }

    const query = parseFilePrefix(prefix).query;
    const entries = await this.loadEntries(options.signal);
    if (options.signal.aborted) {
      return null;
    }

    const suggestions = matchFileEntries(query, entries, this.options.limit ?? DEFAULT_LIMIT).map(
      (match): AutocompleteItem => ({
        value: completionValue(match.entry.path, match.entry.directory),
        label: highlightFileLabel(
          sanitizeTerminalText(`${match.entry.name}${match.entry.directory ? "/" : ""}`),
          match.nameMatch,
        ),
        description: sanitizeTerminalText(match.entry.path),
      }),
    );

    return suggestions.length > 0 ? { prefix, items: suggestions } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    const directory = item.label.endsWith("/");
    const suffix = directory ? "" : " ";
    const newLine = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;
    const cursorOffset =
      directory && item.value.endsWith('"') ? item.value.length - 1 : item.value.length;
    return {
      lines: newLines,
      cursorLine,
      cursorCol: beforePrefix.length + cursorOffset + suffix.length,
    };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const currentLine = lines[cursorLine] ?? "";
    return filePrefixBeforeCursor(currentLine.slice(0, cursorCol)) !== null;
  }

  private async loadEntries(signal: AbortSignal): Promise<WorkspaceFileEntry[]> {
    const root = this.workspaceRoot;
    if (!root) {
      return [];
    }

    const now = this.options.now?.() ?? Date.now();
    if (this.cache && this.cache.root === root && now - this.cache.createdAt < CACHE_TTL_MS) {
      return this.cache.entries;
    }

    const entries = await collectWorkspaceEntries(root, {
      signal,
      maxEntries: this.options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxDepth: this.options.maxDepth ?? DEFAULT_MAX_DEPTH,
    });
    this.cache = { root, createdAt: now, entries };
    return entries;
  }
}

function filePrefixBeforeCursor(textBeforeCursor: string): string | null {
  const quotedPrefix = quotedFilePrefixBeforeCursor(textBeforeCursor);
  if (quotedPrefix) {
    return quotedPrefix;
  }

  const tokenStart = lastTokenStart(textBeforeCursor);
  const token = textBeforeCursor.slice(tokenStart);
  if (!token.startsWith("@")) {
    return null;
  }
  return token;
}

function quotedFilePrefixBeforeCursor(textBeforeCursor: string): string | null {
  const start = textBeforeCursor.lastIndexOf('@"');
  if (start < 0 || !tokenBoundary(textBeforeCursor, start)) {
    return null;
  }
  const quoteBody = textBeforeCursor.slice(start + 2);
  return quoteBody.includes('"') ? null : textBeforeCursor.slice(start);
}

function lastTokenStart(value: string): number {
  const whitespace = value.match(/\s+\S*$/)?.[0];
  return whitespace ? value.length - whitespace.trimStart().length : 0;
}

function tokenBoundary(value: string, index: number): boolean {
  return index === 0 || /\s/.test(value[index - 1] ?? "");
}

function parseFilePrefix(prefix: string): { query: string } {
  if (prefix.startsWith('@"')) {
    return { query: prefix.slice(2) };
  }
  return { query: prefix.slice(1) };
}

async function collectWorkspaceEntries(
  root: string,
  options: { signal: AbortSignal; maxEntries: number; maxDepth: number },
): Promise<WorkspaceFileEntry[]> {
  const gitEntries = await collectGitWorkspaceEntries(root, options);
  if (gitEntries) {
    return gitEntries;
  }
  return collectWalkedWorkspaceEntries(root, options);
}

async function collectGitWorkspaceEntries(
  root: string,
  options: { signal: AbortSignal; maxEntries: number },
): Promise<WorkspaceFileEntry[] | null> {
  if (options.signal.aborted) {
    return [];
  }

  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn(
      ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  } catch {
    return null;
  }

  const abort = () => subprocess.kill();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const stdout = subprocess.stdout;
    const output = stdout instanceof ReadableStream ? await new Response(stdout).text() : "";
    const exitCode = await subprocess.exited;
    if (options.signal.aborted) {
      return [];
    }
    if (exitCode !== 0) {
      return null;
    }
    return entriesFromGitOutput(output, options.maxEntries);
  } catch {
    return null;
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}

async function collectWalkedWorkspaceEntries(
  root: string,
  options: { signal: AbortSignal; maxEntries: number; maxDepth: number },
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];
  const pending: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: root, relativePath: "", depth: 0 },
  ];

  while (pending.length > 0 && entries.length < options.maxEntries && !options.signal.aborted) {
    const next = pending.shift();
    if (!next || next.depth > options.maxDepth) {
      continue;
    }

    let dirents: Dirent[];
    try {
      dirents = await readdir(next.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    dirents.sort(compareDirents);

    for (const dirent of dirents) {
      if (entries.length >= options.maxEntries || options.signal.aborted) {
        break;
      }
      if (dirent.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(dirent.name)) {
        continue;
      }

      const relativePath = next.relativePath ? `${next.relativePath}/${dirent.name}` : dirent.name;
      const directory = dirent.isDirectory();
      entries.push({ path: relativePath, name: dirent.name, directory });

      if (directory) {
        pending.push({
          absolutePath: join(root, relativePath),
          relativePath,
          depth: next.depth + 1,
        });
      }
    }
  }

  return entries;
}

function entriesFromGitOutput(output: string, maxEntries: number): WorkspaceFileEntry[] {
  const entriesByPath = new Map<string, WorkspaceFileEntry>();
  const paths = output
    .split("\0")
    .map(normalizeRelativePath)
    .filter((value): value is string => value !== null)
    .filter((value) => !pathHasSkippedDirectory(value))
    .sort((left, right) => left.localeCompare(right));

  for (const filePath of paths) {
    for (const directoryPath of parentDirectories(filePath)) {
      addWorkspaceEntry(entriesByPath, directoryPath, true);
      if (entriesByPath.size >= maxEntries) {
        break;
      }
    }
    if (entriesByPath.size >= maxEntries) {
      break;
    }
    addWorkspaceEntry(entriesByPath, filePath, false);
    if (entriesByPath.size >= maxEntries) {
      break;
    }
  }

  return Array.from(entriesByPath.values()).sort(compareWorkspaceEntries).slice(0, maxEntries);
}

function addWorkspaceEntry(
  entriesByPath: Map<string, WorkspaceFileEntry>,
  relativePath: string,
  directory: boolean,
): void {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || pathHasSkippedDirectory(normalizedPath)) {
    return;
  }
  entriesByPath.set(normalizedPath, {
    path: normalizedPath,
    name: fileNameFromRelativePath(normalizedPath),
    directory,
  });
}

function parentDirectories(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    directories.push(parts.slice(0, index).join("/"));
  }
  return directories;
}

function normalizeRelativePath(relativePath: string): string | null {
  const normalized = relativePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function pathHasSkippedDirectory(relativePath: string): boolean {
  return relativePath.split("/").some((part) => SKIPPED_DIRECTORY_NAMES.has(part));
}

function fileNameFromRelativePath(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function compareDirents(left: Dirent, right: Dirent): number {
  if (left.isDirectory() && !right.isDirectory()) return -1;
  if (!left.isDirectory() && right.isDirectory()) return 1;
  return left.name.localeCompare(right.name);
}

function compareWorkspaceEntries(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  if (left.directory && !right.directory) return -1;
  if (!left.directory && right.directory) return 1;
  return left.path.localeCompare(right.path);
}

type FileMatch = {
  entry: WorkspaceFileEntry;
  score: number;
  nameMatch: number[];
};

function matchFileEntries(
  query: string,
  entries: WorkspaceFileEntry[],
  limit: number,
): FileMatch[] {
  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery === null) {
    return [];
  }

  const matches = entries
    .map((entry) => scoreFileEntry(normalizedQuery, entry))
    .filter((match): match is FileMatch => match !== null);

  matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.entry.directory !== right.entry.directory) {
      return left.entry.directory ? -1 : 1;
    }
    return left.entry.path.localeCompare(right.entry.path);
  });

  return matches.slice(0, limit);
}

function normalizeQuery(query: string): string | null {
  const normalized = query.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return normalized;
}

function scoreFileEntry(query: string, entry: WorkspaceFileEntry): FileMatch | null {
  if (query.length === 0) {
    return {
      entry,
      score: (entry.directory ? 1_000 : 900) - entry.path.length,
      nameMatch: [],
    };
  }

  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  const nameMatch = orderedMatch(query, name);
  const pathMatch = orderedMatch(query, path);
  let score = 0;

  if (name === query) {
    score = 10_000;
  } else if (name.startsWith(query)) {
    score = 8_000;
  } else if (name.includes(query)) {
    score = 6_000;
  } else if (nameMatch) {
    score = 4_000 - matchSpread(nameMatch);
  } else if (path.startsWith(query)) {
    score = 3_000;
  } else if (path.includes(query)) {
    score = 2_000;
  } else if (pathMatch) {
    score = 1_000 - matchSpread(pathMatch);
  } else {
    return null;
  }

  return {
    entry,
    score: score + (entry.directory ? 50 : 0) - Math.min(entry.path.length, 200),
    nameMatch: nameMatch ?? substringPositions(name, query) ?? [],
  };
}

function orderedMatch(query: string, candidate: string): number[] | null {
  const positions: number[] = [];
  let queryIndex = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] === query[queryIndex]) {
      positions.push(index);
      queryIndex += 1;
      if (queryIndex === query.length) {
        return positions;
      }
    }
  }
  return null;
}

function substringPositions(candidate: string, query: string): number[] | null {
  const start = candidate.indexOf(query);
  if (start < 0) {
    return null;
  }
  return Array.from({ length: query.length }, (_, index) => start + index);
}

function matchSpread(positions: number[]): number {
  if (positions.length <= 1) {
    return 0;
  }
  return (positions.at(-1) ?? 0) - positions[0];
}

function completionValue(path: string, directory: boolean): string {
  const pathValue = directory ? `${path}/` : path;
  return pathValue.includes(" ") ? `"${pathValue}"` : pathValue;
}

function highlightFileLabel(label: string, positions: number[]): string {
  if (positions.length === 0) {
    return label;
  }
  const positionSet = new Set(positions);
  let rendered = "";
  for (let index = 0; index < label.length; index += 1) {
    const char = label[index] ?? "";
    rendered += positionSet.has(index) ? accent(bold(char)) : char;
  }
  return rendered;
}

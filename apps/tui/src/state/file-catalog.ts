// Workspace file catalog used by the composer's @-autocomplete.
//
// Loads once per workspace root (lazy, cached). Prefers `git ls-files`
// when the root is a git checkout — that respects .gitignore and is
// fast on large repos. Falls back to a bounded recursive walk that
// skips common heavy directories.

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type FileSuggestion = {
  path: string;
  // Match score — lower is better. Used only for ordering.
  score: number;
};

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  "target",
  "out",
  "coverage",
  ".sloppy",
  ".venv",
  "venv",
  "__pycache__",
]);

const FALLBACK_MAX_FILES = 5000;

const cache = new Map<string, Promise<string[]>>();

export function loadWorkspaceFiles(root: string): Promise<string[]> {
  const existing = cache.get(root);
  if (existing) return existing;
  const pending = scanWorkspace(root).catch(() => [] as string[]);
  cache.set(root, pending);
  return pending;
}

export function invalidateWorkspaceFiles(root?: string): void {
  if (root === undefined) {
    cache.clear();
    return;
  }
  cache.delete(root);
}

async function scanWorkspace(root: string): Promise<string[]> {
  const fromGit = await tryGitLsFiles(root);
  if (fromGit) return fromGit;
  return walkFallback(root);
}

async function tryGitLsFiles(root: string): Promise<string[] | null> {
  const bunGlobal = typeof Bun !== "undefined" ? Bun : null;
  if (!bunGlobal) return null;
  try {
    const proc = bunGlobal.spawn(
      ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const exit = await proc.exited;
    if (exit !== 0) return null;
    const text = await new Response(proc.stdout).text();
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines;
  } catch {
    return null;
  }
}

async function walkFallback(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= FALLBACK_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= FALLBACK_MAX_FILES) return;
      if (entry.name.startsWith(".") && IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = relative(root, join(dir, entry.name));
        if (!rel || rel.startsWith("..")) continue;
        out.push(rel.split(sep).join("/"));
      }
    }
  }
  await walk(root);
  return out;
}

// Detects whether the user is currently typing an `@<query>` token in
// the composer. The token is anchored to start-of-string or whitespace
// so plain emails (foo@bar.com) don't trigger the popover.
export function detectAtMention(text: string): { query: string; start: number } | null {
  const match = text.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const lead = match[1] ?? "";
  const query = match[2] ?? "";
  const start = (match.index ?? 0) + lead.length;
  return { query, start };
}

// Score is lower-is-better: prefix > basename-prefix > basename-substring > path-substring.
export function matchFileEntries(
  files: readonly string[],
  query: string,
  limit = 8,
): FileSuggestion[] {
  if (files.length === 0) return [];
  const needle = query.toLowerCase();
  if (needle.length === 0) {
    return files.slice(0, limit).map((path) => ({ path, score: 0 }));
  }
  const matches: FileSuggestion[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const base = basename(lower);
    let score = -1;
    if (lower.startsWith(needle)) score = 0;
    else if (base.startsWith(needle)) score = 1;
    else if (base.includes(needle)) score = 2;
    else if (lower.includes(needle)) score = 3;
    if (score < 0) continue;
    matches.push({ path, score: score * 1000 + path.length });
    if (matches.length > limit * 8) break;
  }
  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, limit);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

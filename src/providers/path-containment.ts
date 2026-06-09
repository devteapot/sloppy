import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Realpath the longest existing prefix of an absolute path, then re-append
 * the unresolved tail. Lets containment checks reject symlink escapes even
 * when the target doesn't exist yet (write/mkdir/cd into a fresh path).
 */
export function realpathOfPrefix(absolutePath: string): string {
  let current = absolutePath;
  const tail: string[] = [];
  while (true) {
    const resolved = safeRealpath(current);
    if (resolved !== null) {
      return tail.length === 0 ? resolved : resolve(resolved, ...tail.reverse());
    }
    const parent = dirname(current);
    if (parent === current) {
      return absolutePath;
    }
    tail.push(basename(current));
    current = parent;
  }
}

// Roots are few and long-lived (one per provider), so cache their resolution.
// A cached entry can go stale if a symlink inside the root path is retargeted
// mid-session; that matches the existing callers, which realpath their roots
// once at construction.
const rootRealpathCache = new Map<string, string>();

/**
 * Returns true if `candidate` (after symlink resolution of its longest
 * existing prefix) is contained within `root`. The root is realpath-resolved
 * here too (cached), so a root configured with a symlink or — on
 * case-insensitive filesystems — different casing than on disk still compares
 * against the same canonical form as the candidate.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  let realRoot = rootRealpathCache.get(root);
  if (realRoot === undefined) {
    realRoot = realpathOfPrefix(root);
    rootRealpathCache.set(root, realRoot);
  }
  const real = realpathOfPrefix(candidate);
  return real === realRoot || real.startsWith(`${realRoot}/`);
}

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

/**
 * Returns true if `candidate` (after symlink resolution of its longest
 * existing prefix) is contained within `root` (which the caller should have
 * already realpath-resolved at construction time).
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const real = realpathOfPrefix(candidate);
  return real === root || real.startsWith(`${root}/`);
}

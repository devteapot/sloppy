import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// First-party plugins must consume the session layer through the public
// contract (src/session/plugins, src/session/types) rather than reaching
// into store internals. Precedent: tests/kernel-boundary.test.ts.
const FIRST_PARTY_ROOT = join(import.meta.dir, "..", "src", "plugins", "first-party");
const FORBIDDEN_IMPORT = /from\s+["'][^"']*session\/store(?:\/|["'])/;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("plugin boundary", () => {
  test("first-party plugins do not import session store internals", () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(FIRST_PARTY_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        if (FORBIDDEN_IMPORT.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

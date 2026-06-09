import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { isWithinRoot, realpathOfPrefix, safeRealpath } from "../src/providers/path-containment";

async function createTempTree(): Promise<{ root: string; realRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), "sloppy-containment-"));
  const root = join(base, "workspace");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "file.txt"), "hello", "utf8");
  return { root, realRoot: safeRealpath(root) ?? root };
}

describe("path containment", () => {
  test("contains files under the root and rejects siblings", async () => {
    const { realRoot } = await createTempTree();
    expect(isWithinRoot(realRoot, join(realRoot, "nested", "file.txt"))).toBe(true);
    expect(isWithinRoot(realRoot, join(realRoot, "..", "elsewhere"))).toBe(false);
  });

  test("non-existent candidates resolve through their existing prefix", async () => {
    const { realRoot } = await createTempTree();
    expect(isWithinRoot(realRoot, join(realRoot, "nested", "not-yet-created.txt"))).toBe(true);
    expect(realpathOfPrefix(join(realRoot, "missing", "deep"))).toBe(
      join(realRoot, "missing", "deep"),
    );
  });

  test("symlink candidates pointing outside the root are rejected", async () => {
    const { root, realRoot } = await createTempTree();
    const outside = await mkdtemp(join(tmpdir(), "sloppy-containment-outside-"));
    await symlink(outside, join(root, "escape"));
    expect(isWithinRoot(realRoot, join(realRoot, "escape", "file.txt"))).toBe(false);
  });

  test("a root configured through a symlink still contains its real children", async () => {
    const { realRoot } = await createTempTree();
    const linkBase = await mkdtemp(join(tmpdir(), "sloppy-containment-link-"));
    const linkedRoot = join(linkBase, "workspace-link");
    await symlink(realRoot, linkedRoot);
    // The root itself was not pre-realpath'd by the caller; isWithinRoot
    // canonicalizes it before comparing.
    expect(isWithinRoot(linkedRoot, join(realRoot, "nested", "file.txt"))).toBe(true);
    expect(isWithinRoot(linkedRoot, join(linkBase, "elsewhere"))).toBe(false);
  });

  test.if(platform === "darwin")(
    "a root configured with different casing matches on-disk casing",
    async () => {
      const { realRoot } = await createTempTree();
      const upperRoot = join(
        realRoot.slice(0, realRoot.lastIndexOf("/")),
        realRoot.slice(realRoot.lastIndexOf("/") + 1).toUpperCase(),
      );
      expect(isWithinRoot(upperRoot, join(realRoot, "nested", "file.txt"))).toBe(true);
    },
  );
});

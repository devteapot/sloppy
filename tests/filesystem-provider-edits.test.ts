import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer, type SlopNode } from "@slop-ai/consumer/browser";

import { FilesystemProvider } from "../src/plugins/first-party/filesystem/provider";
import { InProcessTransport } from "../src/providers/in-process";

const tempPaths: string[] = [];

async function loadedFileView(
  consumer: SlopConsumer,
  result: { data?: unknown },
): Promise<SlopNode> {
  const data = result.data as { view_path?: string };
  if (typeof data.view_path !== "string") {
    throw new Error(
      `Expected read result to include view_path, got ${JSON.stringify(result.data)}`,
    );
  }
  return consumer.query(data.view_path, 1);
}

async function loadedFileContent(
  consumer: SlopConsumer,
  result: { data?: unknown },
): Promise<string> {
  const data = result.data as { content?: string };
  if (typeof data.content === "string") {
    return data.content;
  }
  const view = await loadedFileView(consumer, result);
  return String(view.properties?.content ?? "");
}

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

describe("FilesystemProvider — edits", () => {
  test("edit applies a single strict string-replacement and bumps version", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-"));
    tempPaths.push(root);
    await writeFile(join(root, "src.ts"), "hello world", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const read = await consumer.invoke("/workspace", "read", { path: "src.ts" });
      const v1 = (read.data as { version: number }).version;
      const workspace = await consumer.query("/workspace", 1);
      const readAffordance = workspace.affordances?.find((item) => item.action === "read") as
        | { resultKind?: string }
        | undefined;
      expect(readAffordance?.resultKind).toBe("code");

      const result = await consumer.invoke("/workspace", "edit", {
        path: "src.ts",
        edits: [{ oldText: "world", newText: "there" }],
      });
      expect(result.status).toBe("ok");
      const data = result.data as { version: number; edits_applied: number; bytes: number };
      expect(data.edits_applied).toBe(1);
      expect(data.version).toBeGreaterThan(v1);
      const diffData = result.data as {
        hunks: Array<{
          lines: Array<{ kind: string; text: string; oldLine?: number; newLine?: number }>;
        }>;
      };
      expect(diffData.hunks[0]?.lines).toContainEqual({
        kind: "remove",
        text: "world",
        oldLine: 1,
      });
      expect(diffData.hunks[0]?.lines).toContainEqual({ kind: "add", text: "there", newLine: 1 });

      const editAffordance = workspace.affordances?.find((item) => item.action === "edit") as
        | { resultKind?: string }
        | undefined;
      expect(editAffordance?.resultKind).toBe("diff");

      const after = await consumer.invoke("/workspace", "read", { path: "src.ts" });
      expect(await loadedFileContent(consumer, after)).toBe("hello there");
    } finally {
      provider.stop();
    }
  });

  test("edit applies batched replacements against original content (not incremental)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-batch-"));
    tempPaths.push(root);
    const original = "alpha\nbeta\ngamma\ndelta\n";
    await writeFile(join(root, "f.txt"), original, "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      // Each oldText is matched against the ORIGINAL file. Order in the
      // array should not matter (apply strategy splices right-to-left).
      const result = await consumer.invoke("/workspace", "edit", {
        path: "f.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
          { oldText: "delta", newText: "DELTA" },
        ],
      });
      expect(result.status).toBe("ok");
      const data = result.data as { edits_applied: number };
      expect(data.edits_applied).toBe(3);

      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("ALPHA\nbeta\nGAMMA\nDELTA\n");
    } finally {
      provider.stop();
    }
  });

  test("edit returns no_match with edit_index when oldText is not found", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-nomatch-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "hello", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/workspace", "edit", {
        path: "f.txt",
        edits: [
          { oldText: "hello", newText: "hi" },
          { oldText: "nope", newText: "x" },
        ],
      });
      expect(result.status).toBe("ok");
      const data = result.data as { error?: string; edit_index?: number };
      expect(data.error).toBe("no_match");
      expect(data.edit_index).toBe(1);

      // File is unchanged.
      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("hello");
    } finally {
      provider.stop();
    }
  });

  test("edit returns multiple_matches when oldText appears more than once", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-multi-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "foo foo", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/workspace", "edit", {
        path: "f.txt",
        edits: [{ oldText: "foo", newText: "bar" }],
      });
      const data = result.data as { error?: string; edit_index?: number };
      expect(data.error).toBe("multiple_matches");
      expect(data.edit_index).toBe(0);

      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("foo foo");
    } finally {
      provider.stop();
    }
  });

  test("edit returns overlap when two edits touch the same region", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-overlap-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "abcdef", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/workspace", "edit", {
        path: "f.txt",
        edits: [
          { oldText: "abcd", newText: "X" },
          { oldText: "cdef", newText: "Y" },
        ],
      });
      const data = result.data as { error?: string };
      expect(data.error).toBe("overlap");

      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("abcdef");
    } finally {
      provider.stop();
    }
  });

  test("edit enforces expected_version for CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-cas-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "hello", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const first = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      const v1 = (first.data as { version: number }).version;

      await consumer.invoke("/workspace", "write", { path: "f.txt", content: "goodbye" });

      const stale = await consumer.invoke("/workspace", "edit", {
        path: "f.txt",
        edits: [{ oldText: "goodbye", newText: "ciao" }],
        expected_version: v1,
      });
      const data = stale.data as { error?: string; currentVersion?: number };
      expect(data.error).toBe("version_conflict");
      expect(data.currentVersion).toBeGreaterThan(v1);

      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("goodbye");
    } finally {
      provider.stop();
    }
  });

  test("edit works via the focused-file action (per-entry)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-focused-"));
    tempPaths.push(root);
    await writeFile(join(root, "per-entry.txt"), "keep me", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/workspace/entries/per-entry.txt", "edit", {
        edits: [{ oldText: "keep", newText: "kept" }],
      });
      expect(result.status).toBe("ok");
      expect((result.data as { edits_applied: number }).edits_applied).toBe(1);

      const after = await consumer.invoke("/workspace", "read", { path: "per-entry.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("kept me");
    } finally {
      provider.stop();
    }
  });

  test("workspace edit accepts a path mistakenly nested inside every edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-edit-nested-path-"));
    tempPaths.push(root);
    await writeFile(join(root, "postcss.config.js"), "tailwindcss: {},\n", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/workspace", "edit", {
        edits: [
          {
            path: "postcss.config.js",
            oldText: "tailwindcss: {},",
            newText: "'@tailwindcss/postcss': {},",
          },
        ],
      });
      expect(result.status).toBe("ok");
      expect((result.data as { edits_applied: number }).edits_applied).toBe(1);

      const after = await consumer.invoke("/workspace", "read", { path: "postcss.config.js" });
      expect(await loadedFileContent(consumer, after)).toBe("'@tailwindcss/postcss': {},\n");
    } finally {
      provider.stop();
    }
  });

  test("nonexistent file reads as empty at version 0 and write(expected_version=0) creates it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-"));
    tempPaths.push(root);

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 2);

      const readMissing = await consumer.invoke("/workspace", "read", { path: "new.txt" });
      expect(readMissing.status).toBe("ok");
      const readData = readMissing.data as { content: string; version: number; exists: boolean };
      expect(readData.content).toBe("");
      expect(readData.version).toBe(0);
      expect(readData.exists).toBe(false);

      const writeNew = await consumer.invoke("/workspace", "write", {
        path: "new.txt",
        content: "hello",
        expected_version: 0,
      });
      expect(writeNew.status).toBe("ok");
      const writeData = writeNew.data as { version: number };
      expect(writeData.version).toBe(1);

      const stale = await consumer.invoke("/workspace", "write", {
        path: "new.txt",
        content: "oops",
        expected_version: 0,
      });
      const staleData = stale.data as { error?: string; currentVersion?: number };
      expect(staleData.error).toBe("version_conflict");
      expect(staleData.currentVersion).toBe(1);
    } finally {
      provider.stop();
    }
  });

  test("detects external deletion by bumping the version and marking exists=false", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-delete-"));
    tempPaths.push(root);

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    try {
      await consumer.connect();
      await consumer.subscribe("/", 2);

      const created = await consumer.invoke("/workspace", "write", {
        path: "ephemeral.txt",
        content: "hello",
      });
      const v1 = (created.data as { version: number }).version;
      expect(v1).toBe(1);

      // External agent deletes the file (not via the provider).
      await rm(join(root, "ephemeral.txt"));

      const afterDelete = await consumer.invoke("/workspace", "read", {
        path: "ephemeral.txt",
      });
      const readData = afterDelete.data as { content: string; version: number; exists: boolean };
      expect(readData.exists).toBe(false);
      expect(readData.content).toBe("");
      // Version must be strictly greater than v1 to preserve monotonicity and
      // invalidate any stale expected_version a concurrent writer holds.
      expect(readData.version).toBeGreaterThan(v1);

      // A write with the pre-delete version must conflict.
      const staleWrite = await consumer.invoke("/workspace", "write", {
        path: "ephemeral.txt",
        content: "stale",
        expected_version: v1,
      });
      expect((staleWrite.data as { error?: string }).error).toBe("version_conflict");

      // Writing with the new version succeeds (recreates the file).
      const recreate = await consumer.invoke("/workspace", "write", {
        path: "ephemeral.txt",
        content: "reborn",
        expected_version: readData.version,
      });
      const recreated = recreate.data as { version: number };
      expect(recreated.version).toBeGreaterThan(readData.version);
    } finally {
      provider.stop();
    }
  });

  test("rejects writes through symlinks that escape the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-symlink-"));
    tempPaths.push(root);
    const outside = await mkdtemp(join(tmpdir(), "sloppy-fs-escape-"));
    tempPaths.push(outside);
    // A symlink under the workspace root pointing at an unrelated temp dir.
    await symlink(outside, join(root, "link"));

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const escaped = await consumer.invoke("/workspace", "write", {
        path: "link/escaped.txt",
        content: "should not exist",
      });
      expect(escaped.status).toBe("error");
      expect(escaped.error?.message ?? "").toMatch(/escapes filesystem root/);

      const escapedMkdir = await consumer.invoke("/workspace", "mkdir", {
        path: "link/sub",
      });
      expect(escapedMkdir.status).toBe("error");

      const escapedRead = await consumer.invoke("/workspace", "read", {
        path: "link/anything",
      });
      expect(escapedRead.status).toBe("error");
    } finally {
      provider.stop();
    }
  });
});

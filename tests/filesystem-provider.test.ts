import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { FilesystemProvider } from "../src/providers/builtin/filesystem";
import { InProcessTransport } from "../src/providers/builtin/in-process";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

describe("FilesystemProvider", () => {
  test("rejects a focus that resolves outside the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-root-"));
    tempPaths.push(root);
    const outside = await mkdtemp(join(tmpdir(), "sloppy-fs-outside-"));
    tempPaths.push(outside);
    await writeFile(join(outside, "leak.txt"), "leak", "utf8");

    expect(() =>
      new FilesystemProvider({
        root,
        focus: outside,
        recentLimit: 10,
        searchLimit: 20,
        readMaxBytes: 65536,
      }),
    ).toThrow(/focus must be inside workspace root/);
  });

  test("writes files and exposes them back through state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-"));
    tempPaths.push(root);
    await writeFile(join(root, "seed.txt"), "seed", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    await consumer.connect();
    await consumer.subscribe("/", 3);

    const writeResult = await consumer.invoke("/workspace", "write", {
      path: "hello.txt",
      content: "Hello World",
    });

    expect(writeResult.status).toBe("ok");

    const entries = await consumer.query("/workspace/entries", 2);
    expect(entries.children?.some((child) => child.id === "hello.txt")).toBe(true);

    const readResult = await consumer.invoke("/workspace/entries/hello.txt", "read", {});
    expect(readResult.status).toBe("ok");
    expect((readResult.data as { content: string }).content).toBe("Hello World");
  });

  test("normalizes paths that include the workspace directory name", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-normalize-"));
    tempPaths.push(root);
    await mkdir(join(root, "todo-app"), { recursive: true });
    await writeFile(join(root, "todo-app", "README.md"), "hello", "utf8");

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

      const withRootName = await consumer.invoke("/workspace", "set_focus", {
        path: `${root.split("/").at(-1)}/todo-app`,
      });
      expect(withRootName.status).toBe("ok");
      expect((withRootName.data as { path: string }).path).toBe("todo-app");

      const absoluteRead = await consumer.invoke("/workspace", "read", {
        path: join(root, "todo-app", "README.md"),
      });
      expect(absoluteRead.status).toBe("ok");
      expect((absoluteRead.data as { path: string; content: string }).path).toBe(
        "todo-app/README.md",
      );
      expect((absoluteRead.data as { content: string }).content).toBe("hello");
    } finally {
      provider.stop();
    }
  });

  test("returns actionable invalid-input errors for missing required filesystem paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-invalid-"));
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
      await consumer.subscribe("/", 3);

      const read = await consumer.invoke("/workspace", "read", {});
      expect(read.status).toBe("error");
      // SLOP 0.2 SDK rejects missing required params before reaching the handler.
      expect(read.error?.code).toBe("invalid_params");
      expect(read.error?.message).toContain("path");
    } finally {
      provider.stop();
    }
  });

  test("exposes per-file version and enforces expected_version on write (CAS)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-cas-"));
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
      await consumer.subscribe("/", 3);

      const firstWrite = await consumer.invoke("/workspace", "write", {
        path: "notes.md",
        content: "v1",
      });
      expect(firstWrite.status).toBe("ok");
      const firstData = firstWrite.data as { version: number; bytes: number };
      expect(typeof firstData.version).toBe("number");
      const v1 = firstData.version;

      const readResult = await consumer.invoke("/workspace", "read", { path: "notes.md" });
      const readData = readResult.data as { content: string; version: number };
      expect(readData.content).toBe("v1");
      expect(readData.version).toBe(v1);

      const goodWrite = await consumer.invoke("/workspace", "write", {
        path: "notes.md",
        content: "v2",
        expected_version: v1,
      });
      expect(goodWrite.status).toBe("ok");
      const v2 = (goodWrite.data as { version: number }).version;
      expect(v2).toBeGreaterThan(v1);

      const staleWrite = await consumer.invoke("/workspace", "write", {
        path: "notes.md",
        content: "v-stale",
        expected_version: v1,
      });
      expect(staleWrite.status).toBe("ok");
      const staleData = staleWrite.data as {
        error?: string;
        currentVersion?: number;
      };
      expect(staleData.error).toBe("version_conflict");
      expect(staleData.currentVersion).toBe(v2);

      const confirm = await consumer.invoke("/workspace", "read", { path: "notes.md" });
      expect((confirm.data as { content: string }).content).toBe("v2");
    } finally {
      provider.stop();
    }
  });

  test("CAS serializes concurrent writes with the same expected_version", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-race-"));
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
      await consumer.subscribe("/", 3);

      await consumer.invoke("/workspace", "write", { path: "race.md", content: "v1" });
      const read = await consumer.invoke("/workspace", "read", { path: "race.md" });
      const version = (read.data as { version: number }).version;

      const [a, b] = await Promise.all([
        consumer.invoke("/workspace", "write", {
          path: "race.md",
          content: "A-wins",
          expected_version: version,
        }),
        consumer.invoke("/workspace", "write", {
          path: "race.md",
          content: "B-wins",
          expected_version: version,
        }),
      ]);

      const results = [a.data, b.data] as Array<
        { version: number; bytes: number } | { error: string; currentVersion: number }
      >;
      const successes = results.filter((r) => !("error" in r));
      const conflicts = results.filter(
        (r): r is { error: string; currentVersion: number } => "error" in r,
      );
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.error).toBe("version_conflict");
    } finally {
      provider.stop();
    }
  });

  test("returns preview + content ref when file exceeds threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-ref-"));
    tempPaths.push(root);
    // 20KB body, 1000 lines
    const body = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}`.padEnd(20, "x")).join("\n");
    await writeFile(join(root, "big.log"), body, "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 4096,
      previewBytes: 512,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const noRange = await consumer.invoke("/workspace", "read", { path: "big.log" });
      const data = noRange.data as {
        content: string;
        truncated: boolean;
        preview_only?: boolean;
        total_bytes?: number;
        totalLines?: number;
        ref?: {
          kind: string;
          path: string;
          version: number;
          total_bytes: number;
          total_lines: number;
        };
      };
      expect(data.preview_only).toBe(true);
      expect(data.truncated).toBe(true);
      expect(data.content.length).toBeLessThanOrEqual(512);
      expect(data.total_bytes).toBe(Buffer.byteLength(body, "utf8"));
      expect(data.ref).toBeDefined();
      expect(data.ref?.path).toBe("big.log");
      expect(data.ref?.kind).toBe("fs");
      expect(data.ref?.total_lines).toBe(1000);

      // Dereferencing via a range returns the exact slice, not the preview.
      const slice = await consumer.invoke("/workspace", "read", {
        path: "big.log",
        start_line: 50,
        end_line: 52,
      });
      const sliceData = slice.data as { content: string; preview_only?: boolean };
      expect(sliceData.preview_only).toBeUndefined();
      expect(sliceData.content.split("\n")).toHaveLength(3);
      expect(sliceData.content).toContain("line-50");
    } finally {
      provider.stop();
    }
  });

  test("returns full content when file is under threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-small-"));
    tempPaths.push(root);
    await writeFile(join(root, "small.txt"), "hello world", "utf8");

    const provider = new FilesystemProvider({
      root,
      focus: root,
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 4096,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/workspace", "read", { path: "small.txt" });
      const data = result.data as {
        content: string;
        preview_only?: boolean;
        ref?: unknown;
      };
      expect(data.content).toBe("hello world");
      expect(data.preview_only).toBeUndefined();
      expect(data.ref).toBeUndefined();
    } finally {
      provider.stop();
    }
  });

  test("read returns a compact listing for directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-dir-read-"));
    tempPaths.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "App.jsx"), "export default function App() {}\n", "utf8");

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

      const result = await consumer.invoke("/workspace", "read", { path: "src" });
      expect(result.status).toBe("ok");
      const data = result.data as {
        kind?: string;
        content: string;
        entries?: Array<{ name: string; path: string; kind: string; size: number }>;
        hint?: string;
      };
      expect(data.kind).toBe("directory");
      expect(data.entries).toEqual([
        {
          name: "App.jsx",
          path: "src/App.jsx",
          kind: "file",
          size: Buffer.byteLength("export default function App() {}\n", "utf8"),
        },
      ]);
      expect(data.content).toContain("file\tsrc/App.jsx");
      expect(data.hint).toContain("Use set_focus or slop_query_state");
    } finally {
      provider.stop();
    }
  });

  test("reads a line range without returning the whole file", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-range-"));
    tempPaths.push(root);
    const body = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
    await writeFile(join(root, "big.txt"), body, "utf8");

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

      const slice = await consumer.invoke("/workspace", "read", {
        path: "big.txt",
        start_line: 5,
        end_line: 7,
      });
      expect(slice.status).toBe("ok");
      const data = slice.data as {
        content: string;
        startLine: number;
        endLine: number;
        totalLines: number;
      };
      expect(data.content).toBe("line-5\nline-6\nline-7");
      expect(data.startLine).toBe(5);
      expect(data.endLine).toBe(7);
      expect(data.totalLines).toBe(20);

      const full = await consumer.invoke("/workspace", "read", { path: "big.txt" });
      expect((full.data as { content: string }).content).toBe(body);
      expect((full.data as { startLine?: number }).startLine).toBeUndefined();

      const rejected = await consumer.invoke("/workspace", "read", {
        path: "big.txt",
        start_line: 10,
        end_line: 2,
      });
      expect(rejected.status).toBe("error");
      expect(rejected.error?.message).toContain("Invalid range");
    } finally {
      provider.stop();
    }
  });

  test("bumps version on external mtime drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-drift-"));
    tempPaths.push(root);
    const filePath = join(root, "external.txt");
    await writeFile(filePath, "initial", "utf8");

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

      const first = await consumer.invoke("/workspace", "read", { path: "external.txt" });
      const v1 = (first.data as { version: number }).version;

      await Bun.sleep(20);
      await writeFile(filePath, "edited-externally", "utf8");

      const second = await consumer.invoke("/workspace", "read", { path: "external.txt" });
      const v2 = (second.data as { version: number; content: string }).version;
      expect((second.data as { content: string }).content).toBe("edited-externally");
      expect(v2).toBeGreaterThan(v1);
    } finally {
      provider.stop();
    }
  });

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

      const result = await consumer.invoke("/workspace", "edit", {
        path: "src.ts",
        edits: [{ oldText: "world", newText: "there" }],
      });
      expect(result.status).toBe("ok");
      const data = result.data as { version: number; edits_applied: number; bytes: number };
      expect(data.edits_applied).toBe(1);
      expect(data.version).toBeGreaterThan(v1);

      const after = await consumer.invoke("/workspace", "read", { path: "src.ts" });
      expect((after.data as { content: string }).content).toBe("hello there");
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
      expect((after.data as { content: string }).content).toBe("ALPHA\nbeta\nGAMMA\nDELTA\n");
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
      expect((after.data as { content: string }).content).toBe("hello");
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
      expect((after.data as { content: string }).content).toBe("foo foo");
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
      expect((after.data as { content: string }).content).toBe("abcdef");
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
      expect((after.data as { content: string }).content).toBe("goodbye");
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
      expect((after.data as { content: string }).content).toBe("kept me");
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
      expect((after.data as { content: string }).content).toBe("'@tailwindcss/postcss': {},\n");
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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("FilesystemProvider — paths and views", () => {
  test("rejects a focus that resolves outside the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-root-"));
    tempPaths.push(root);
    const outside = await mkdtemp(join(tmpdir(), "sloppy-fs-outside-"));
    tempPaths.push(outside);
    await writeFile(join(outside, "leak.txt"), "leak", "utf8");

    expect(
      () =>
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
    expect(await loadedFileContent(consumer, readResult)).toBe("Hello World");
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
      expect(await loadedFileContent(consumer, absoluteRead)).toBe("hello");
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
      const readData = readResult.data as { version: number };
      expect(await loadedFileContent(consumer, readResult)).toBe("v1");
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
      expect(await loadedFileContent(consumer, confirm)).toBe("v2");
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

  test("loads a preview File view when file exceeds threshold", async () => {
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
        truncated: boolean;
        preview_only?: boolean;
        total_bytes?: number;
        totalLines?: number;
        view_path?: string;
        coverage?: string;
      };
      expect(data.preview_only).toBe(true);
      expect(data.truncated).toBe(true);
      expect(data.coverage).toBe("preview");
      expect(data).not.toHaveProperty("content");
      expect(data.total_bytes).toBe(Buffer.byteLength(body, "utf8"));
      expect(data.view_path).toMatch(/^\/views\//);
      const previewView = await loadedFileView(consumer, noRange);
      expect(previewView.properties?.path).toBe("big.log");
      expect(previewView.properties?.coverage).toBe("preview");
      expect(String(previewView.properties?.content).length).toBeLessThanOrEqual(512);
      expect(previewView.properties?.total_lines).toBe(1000);

      // Dereferencing via a range returns the exact slice, not the preview.
      const slice = await consumer.invoke("/workspace", "read", {
        path: "big.log",
        start_line: 50,
        end_line: 52,
      });
      const sliceData = slice.data as { preview_only?: boolean; coverage?: string };
      expect(sliceData.preview_only).toBeUndefined();
      expect(sliceData.coverage).toBe("range");
      const sliceContent = await loadedFileContent(consumer, slice);
      expect(sliceContent.split("\n")).toHaveLength(3);
      expect(sliceContent).toContain("line-50");
    } finally {
      provider.stop();
    }
  });

  test("loads a full File view when file is under threshold", async () => {
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
        preview_only?: boolean;
        coverage?: string;
        view_path?: string;
      };
      expect(data).not.toHaveProperty("content");
      expect(data.coverage).toBe("full");
      expect(data.view_path).toMatch(/^\/views\//);
      expect(await loadedFileContent(consumer, result)).toBe("hello world");
      expect(data.preview_only).toBeUndefined();
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
      expect(data.hint).toContain("Use set_focus or query_state");
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
        coverage: string;
        startLine: number;
        endLine: number;
        totalLines: number;
      };
      expect(data.coverage).toBe("range");
      expect(await loadedFileContent(consumer, slice)).toBe("line-5\nline-6\nline-7");
      expect(data.startLine).toBe(5);
      expect(data.endLine).toBe(7);
      expect(data.totalLines).toBe(20);

      const full = await consumer.invoke("/workspace", "read", { path: "big.txt" });
      expect((full.data as { coverage: string }).coverage).toBe("full");
      expect(await loadedFileContent(consumer, full)).toBe(body);
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

  test("full File views supersede same-version range views", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-supersede-"));
    tempPaths.push(root);
    const body = Array.from({ length: 5 }, (_, i) => `line-${i + 1}`).join("\n");
    await writeFile(join(root, "notes.txt"), body, "utf8");

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

      const range = await consumer.invoke("/workspace", "read", {
        path: "notes.txt",
        start_line: 2,
        end_line: 3,
      });
      expect((range.data as { coverage: string }).coverage).toBe("range");

      const rangeViews = await consumer.query("/views", 2);
      expect(rangeViews.children?.map((child) => child.properties?.coverage)).toEqual(["range"]);

      const full = await consumer.invoke("/workspace", "read", { path: "notes.txt" });
      const fullData = full.data as { coverage: string; view_id: string };
      expect(fullData.coverage).toBe("full");

      const viewsAfterFull = await consumer.query("/views", 2);
      expect(viewsAfterFull.children?.map((child) => child.id)).toEqual([fullData.view_id]);
      expect(viewsAfterFull.children?.map((child) => child.properties?.coverage)).toEqual(["full"]);

      const redundantRange = await consumer.invoke("/workspace", "read", {
        path: "notes.txt",
        start_line: 4,
        end_line: 4,
      });
      const redundantData = redundantRange.data as {
        already_loaded?: boolean;
        coverage: string;
        view_id: string;
      };
      expect(redundantData.already_loaded).toBe(true);
      expect(redundantData.coverage).toBe("full");
      expect(redundantData.view_id).toBe(fullData.view_id);

      const finalViews = await consumer.query("/views", 2);
      expect(finalViews.children).toHaveLength(1);
    } finally {
      provider.stop();
    }
  });

  test("marks loaded File views stale after the backing file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-stale-"));
    tempPaths.push(root);
    await writeFile(join(root, "state.txt"), "before", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", { path: "state.txt" });
      const readData = read.data as { version: number; view_path: string };
      expect(await loadedFileContent(consumer, read)).toBe("before");

      await Bun.sleep(20);
      await consumer.invoke("/workspace", "write", { path: "state.txt", content: "after" });

      const staleView = await consumer.query(readData.view_path, 1);
      expect(staleView.properties?.content).toBe("before");
      expect(staleView.properties?.stale).toBe(true);
      expect(staleView.properties?.version).toBe(readData.version);
      expect(Number(staleView.properties?.current_version)).toBeGreaterThan(readData.version);
    } finally {
      provider.stop();
    }
  });

  test("edit_range applies a snapshot-validated line replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\ndelta", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", {
        path: "f.txt",
        start_line: 2,
        end_line: 3,
      });
      const readData = read.data as {
        source_version: number;
        version: number;
      };
      expect(readData.source_version).toBe(readData.version);

      const result = await consumer.invoke("/workspace", "edit_range", {
        path: "f.txt",
        source_version: readData.source_version,
        edits: [
          {
            start_line: 2,
            end_line: 3,
            new_text: "BETA\nGAMMA",
          },
        ],
      });

      expect(result.status).toBe("ok");
      expect((result.data as { edits_applied: number }).edits_applied).toBe(1);

      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("alpha\nBETA\nGAMMA\ndelta");
    } finally {
      provider.stop();
    }
  });

  test("edit_range preserves CRLF line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-crlf-"));
    tempPaths.push(root);
    const filePath = join(root, "crlf.txt");
    await writeFile(filePath, "alpha\r\nbeta\r\ngamma\r\ndelta\r\n", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", {
        path: "crlf.txt",
        start_line: 2,
        end_line: 2,
      });
      expect(await loadedFileContent(consumer, read)).toBe("beta");
      const sourceVersion = (read.data as { source_version: number }).source_version;

      const result = await consumer.invoke("/workspace", "edit_range", {
        path: "crlf.txt",
        source_version: sourceVersion,
        edits: [
          {
            start_line: 2,
            end_line: 2,
            new_text: "BETA",
          },
        ],
      });

      expect(result.status).toBe("ok");
      expect(await readFile(filePath, "utf8")).toBe("alpha\r\nBETA\r\ngamma\r\ndelta\r\n");
    } finally {
      provider.stop();
    }
  });

  test("edit_range allows unrelated external changes when the observed lines still match", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-drift-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\ndelta", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", {
        path: "f.txt",
        start_line: 2,
        end_line: 3,
      });
      const sourceVersion = (read.data as { source_version: number }).source_version;

      await Bun.sleep(20);
      await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\ndelta!", "utf8");

      const result = await consumer.invoke("/workspace", "edit_range", {
        path: "f.txt",
        source_version: sourceVersion,
        edits: [
          {
            start_line: 2,
            end_line: 3,
            new_text: "BETA\nGAMMA",
          },
        ],
      });

      expect(result.status).toBe("ok");
      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("alpha\nBETA\nGAMMA\ndelta!");
    } finally {
      provider.stop();
    }
  });

  test("edit_range rejects stale line numbers when the current range no longer matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-conflict-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\ndelta", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", {
        path: "f.txt",
        start_line: 2,
        end_line: 3,
      });
      const sourceVersion = (read.data as { source_version: number }).source_version;

      await Bun.sleep(20);
      const moved = "inserted\nalpha\nbeta\ngamma\ndelta";
      await writeFile(join(root, "f.txt"), moved, "utf8");

      const result = await consumer.invoke("/workspace", "edit_range", {
        path: "f.txt",
        source_version: sourceVersion,
        edits: [
          {
            start_line: 2,
            end_line: 3,
            new_text: "BETA\nGAMMA",
          },
        ],
      });

      expect((result.data as { error?: string; line?: number }).error).toBe("range_conflict");
      expect((result.data as { line?: number }).line).toBe(2);
      const after = await consumer.invoke("/workspace", "read", { path: "f.txt" });
      expect(await loadedFileContent(consumer, after)).toBe(moved);
    } finally {
      provider.stop();
    }
  });

  test("edit_range rejects ranges outside the remembered source view", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-missing-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\ndelta", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", {
        path: "f.txt",
        start_line: 2,
        end_line: 2,
      });
      const sourceVersion = (read.data as { source_version: number }).source_version;

      const result = await consumer.invoke("/workspace", "edit_range", {
        path: "f.txt",
        source_version: sourceVersion,
        edits: [
          {
            start_line: 3,
            end_line: 3,
            new_text: "GAMMA",
          },
        ],
      });

      expect((result.data as { error?: string; line?: number }).error).toBe(
        "source_range_not_observed",
      );
      expect((result.data as { line?: number }).line).toBe(3);
    } finally {
      provider.stop();
    }
  });

  test("edit_range enforces expected_version when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-cas-"));
    tempPaths.push(root);
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma", "utf8");

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

      const read = await consumer.invoke("/workspace", "read", {
        path: "f.txt",
        start_line: 2,
        end_line: 2,
      });
      const readData = read.data as { source_version: number; version: number };

      await Bun.sleep(20);
      await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma!", "utf8");

      const result = await consumer.invoke("/workspace", "edit_range", {
        path: "f.txt",
        source_version: readData.source_version,
        expected_version: readData.version,
        edits: [
          {
            start_line: 2,
            end_line: 2,
            new_text: "BETA",
          },
        ],
      });

      const data = result.data as { error?: string; currentVersion?: number };
      expect(data.error).toBe("version_conflict");
      expect(data.currentVersion).toBeGreaterThan(readData.version);
    } finally {
      provider.stop();
    }
  });

  test("edit_range works via the focused-file action", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-edit-focused-"));
    tempPaths.push(root);
    await writeFile(join(root, "per-entry.txt"), "alpha\nbeta", "utf8");

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

      const read = await consumer.invoke("/workspace/entries/per-entry.txt", "read", {
        start_line: 2,
        end_line: 2,
      });
      const sourceVersion = (read.data as { source_version: number }).source_version;

      const result = await consumer.invoke("/workspace/entries/per-entry.txt", "edit_range", {
        source_version: sourceVersion,
        edits: [
          {
            start_line: 2,
            end_line: 2,
            new_text: "BETA",
          },
        ],
      });

      expect((result.data as { edits_applied: number }).edits_applied).toBe(1);
      const after = await consumer.invoke("/workspace", "read", { path: "per-entry.txt" });
      expect(await loadedFileContent(consumer, after)).toBe("alpha\nBETA");
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
      const v2 = (second.data as { version: number }).version;
      expect(await loadedFileContent(consumer, second)).toBe("edited-externally");
      expect(v2).toBeGreaterThan(v1);
    } finally {
      provider.stop();
    }
  });
});

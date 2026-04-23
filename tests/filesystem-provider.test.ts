import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});

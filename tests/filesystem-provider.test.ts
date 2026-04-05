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
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { TerminalProvider } from "../src/providers/builtin/terminal";

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

describe("TerminalProvider", () => {
  test("executes a synchronous command and records it in history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    await consumer.connect();
    await consumer.subscribe("/", 3);

    const result = await consumer.invoke("/session", "execute", {
      command: "printf hello",
      background: false,
      confirmed: false,
    });

    expect(result.status).toBe("ok");
    expect((result.data as { stdout: string }).stdout).toBe("hello");

    const history = await consumer.query("/history", 2);
    expect(history.children?.length).toBeGreaterThan(0);
  });
});

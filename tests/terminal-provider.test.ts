import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

  test("normalizes cd paths that include the workspace directory name", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);
    await mkdir(join(cwd, "sprint-board"));
    await writeFile(join(cwd, "sprint-board", ".keep"), "hello", "utf8");

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const result = await consumer.invoke("/session", "cd", {
        path: `${basename(cwd)}/sprint-board`,
      });
      expect(result.status).toBe("ok");
      expect((result.data as { cwd: string }).cwd).toBe(join(cwd, "sprint-board"));

      const repeat = await consumer.invoke("/session", "cd", {
        path: `${basename(cwd)}/sprint-board`,
      });
      expect(repeat.status).toBe("ok");
      expect((repeat.data as { cwd: string }).cwd).toBe(join(cwd, "sprint-board"));
    } finally {
      provider.stop();
    }
  });

  test("creates a provider-native approval for destructive commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);
    await writeFile(join(cwd, "remove-me.txt"), "hello", "utf8");

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    await consumer.connect();
    await consumer.subscribe("/", 4);

    const result = await consumer.invoke("/session", "execute", {
      command: "rm remove-me.txt",
      background: false,
      confirmed: false,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("approval_required");

    const approvals = await consumer.query("/approvals", 2);
    expect(approvals.children?.length).toBe(1);
    expect(approvals.children?.[0]?.properties?.status).toBe("pending");
    expect(approvals.children?.[0]?.properties?.action).toBe("execute");
    expect(approvals.children?.[0]?.properties?.reason).toContain(
      "destructive shell command pattern",
    );
    expect(approvals.children?.[0]?.properties?.params_preview).toContain("rm remove-me.txt");

    const approvalId = approvals.children?.[0]?.id;
    expect(typeof approvalId).toBe("string");
    const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
    expect(approveResult.status).toBe("ok");
    expect(await Bun.file(join(cwd, "remove-me.txt")).exists()).toBe(false);

    const updatedApprovals = await consumer.query("/approvals", 2);
    expect(updatedApprovals.children?.[0]?.properties?.status).toBe("approved");
  });

  test("rejecting a provider-native approval leaves state unchanged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);
    await writeFile(join(cwd, "keep-me.txt"), "hello", "utf8");

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    await consumer.connect();
    await consumer.subscribe("/", 4);

    await consumer.invoke("/session", "execute", {
      command: "rm keep-me.txt",
      background: false,
      confirmed: false,
    });

    const approvals = await consumer.query("/approvals", 2);
    const approvalId = approvals.children?.[0]?.id;
    expect(typeof approvalId).toBe("string");

    const rejectResult = await consumer.invoke(`/approvals/${approvalId}`, "reject", {
      reason: "keep the file",
    });
    expect(rejectResult.status).toBe("ok");
    expect(await Bun.file(join(cwd, "keep-me.txt")).exists()).toBe(true);

    const updatedApprovals = await consumer.query("/approvals", 2);
    expect(updatedApprovals.children?.[0]?.properties?.status).toBe("rejected");
  });

  test("approval metadata explains file output redirection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 4);

      const result = await consumer.invoke("/session", "execute", {
        command: "printf hello > out.txt",
        background: false,
        confirmed: false,
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children?.[0]?.properties?.reason).toContain("file output redirection");
      expect(approvals.children?.[0]?.properties?.params_preview).toContain(
        "printf hello > out.txt",
      );
    } finally {
      provider.stop();
    }
  });

  test("allows harmless file descriptor redirection without approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 4);

      const result = await consumer.invoke("/session", "execute", {
        command: "printf hello 2>&1",
        background: false,
        confirmed: false,
      });

      expect(result.status).toBe("ok");
      expect((result.data as { stdout: string }).stdout).toBe("hello");

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
    }
  });

  test("rejects cd attempts that escape the workspace root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const traversal = await consumer.invoke("/session", "cd", {
        path: "../../../etc",
      });
      expect(traversal.status).toBe("error");
      expect(traversal.error?.message ?? "").toContain("outside workspace root");

      const absolute = await consumer.invoke("/session", "cd", {
        path: "/etc",
      });
      expect(absolute.status).toBe("error");
      expect(absolute.error?.message ?? "").toContain("outside workspace root");

      const session = await consumer.query("/session", 1);
      expect(session.properties?.cwd).toBe(cwd);
    } finally {
      provider.stop();
    }
  });

  test("allows stderr redirection to /dev/null without approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 4);

      const result = await consumer.invoke("/session", "execute", {
        command: "find missing-directory -type f 2>/dev/null || true",
        background: false,
        confirmed: false,
      });

      expect(result.status).toBe("ok");

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
    }
  });
});

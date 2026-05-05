import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { terminalSafetyRule } from "../src/core/policy/rules";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { TerminalProvider } from "../src/providers/builtin/terminal";

// Minimal hub config sufficient for connecting an in-process provider.
const HUB_CONFIG: SloppyConfig = {
  llm: { provider: "openai", model: "gpt-5.4", profiles: [], maxTokens: 4096 },
  agent: {
    maxIterations: 12,
    contextBudgetTokens: 24000,
    minSalience: 0.2,
    overviewDepth: 2,
    overviewMaxNodes: 200,
    detailDepth: 4,
    detailMaxNodes: 200,
    historyTurns: 8,
    toolResultMaxChars: 16000,
  },
  maxToolResultSize: 4096,
  providers: {
    builtin: {
      terminal: false,
      filesystem: false,
      memory: false,
      skills: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
      metaRuntime: false,
      spec: false,
      vision: false,
    },
    discovery: { enabled: false, paths: [] },
    terminal: { cwd: ".", historyLimit: 10, syncTimeoutMs: 30000 },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: { maxMemories: 500, defaultWeight: 0.5, compactThreshold: 0.2 },
    skills: { skillsDir: "~/.hermes/skills" },
    web: { historyLimit: 10 },
    browser: { viewportWidth: 1280, viewportHeight: 800 },
    cron: { maxJobs: 16 },
    messaging: { maxMessages: 100 },
    delegation: { maxAgents: 4 },
    metaRuntime: { globalRoot: "~/.sloppy/meta-runtime", workspaceRoot: ".sloppy/meta-runtime" },
    vision: { maxImages: 16, defaultWidth: 1024, defaultHeight: 768 },
  },
} as unknown as SloppyConfig;

async function attachTerminalToHub(provider: TerminalProvider): Promise<{
  hub: ConsumerHub;
  consumer: SlopConsumer;
}> {
  const hub = new ConsumerHub([], HUB_CONFIG);
  await hub.connect();
  hub.addPolicyRule(terminalSafetyRule);
  await hub.addProvider({
    id: "terminal",
    name: "Terminal",
    kind: "builtin",
    transport: new InProcessTransport(provider.server),
    transportLabel: "in-process",
    stop: () => provider.stop(),
    approvals: provider.approvals,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await consumer.connect();
  await consumer.subscribe("/", 4);
  return { hub, consumer };
}

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
    const realCwd = realpathSync(cwd);

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
      expect((result.data as { cwd: string }).cwd).toBe(join(realCwd, "sprint-board"));

      const repeat = await consumer.invoke("/session", "cd", {
        path: `${basename(cwd)}/sprint-board`,
      });
      expect(repeat.status).toBe("ok");
      expect((repeat.data as { cwd: string }).cwd).toBe(join(realCwd, "sprint-board"));
    } finally {
      provider.stop();
    }
  });

  test("creates a hub-mediated approval for destructive commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);
    await writeFile(join(cwd, "remove-me.txt"), "hello", "utf8");

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const { hub, consumer } = await attachTerminalToHub(provider);

    try {
      const result = await hub.invoke("terminal", "/session", "execute", {
        command: "rm remove-me.txt",
        background: false,
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
    } finally {
      hub.shutdown();
    }
  });

  test("rejecting a hub-mediated approval leaves state unchanged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);
    await writeFile(join(cwd, "keep-me.txt"), "hello", "utf8");

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const { hub, consumer } = await attachTerminalToHub(provider);

    try {
      await hub.invoke("terminal", "/session", "execute", {
        command: "rm keep-me.txt",
        background: false,
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
    } finally {
      hub.shutdown();
    }
  });

  test("approval metadata explains file output redirection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const { hub, consumer } = await attachTerminalToHub(provider);

    try {
      const result = await hub.invoke("terminal", "/session", "execute", {
        command: "printf hello > out.txt",
        background: false,
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children?.[0]?.properties?.reason).toContain("file output redirection");
      expect(approvals.children?.[0]?.properties?.params_preview).toContain(
        "printf hello > out.txt",
      );
    } finally {
      hub.shutdown();
    }
  });

  test("requires approval for append redirection (>>)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const { hub, consumer } = await attachTerminalToHub(provider);

    try {
      const result = await hub.invoke("terminal", "/session", "execute", {
        command: "echo more >> out.txt",
        background: false,
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children?.[0]?.properties?.reason).toContain("file output redirection");
    } finally {
      hub.shutdown();
    }
  });

  test("requires approval for combined-redirection forms (&>, &>>, > x 2>&1)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const { hub } = await attachTerminalToHub(provider);

    try {
      for (const command of [
        "printf x &> combined.txt",
        "printf x &>> combined.txt",
        "printf x > combined.txt 2>&1",
      ]) {
        const result = await hub.invoke("terminal", "/session", "execute", {
          command,
          background: false,
        });
        expect(result.status).toBe("error");
        expect(result.error?.code).toBe("approval_required");
      }
    } finally {
      hub.shutdown();
    }
  });

  test("requires approval for `tee` to a non-/dev/null target", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const { hub } = await attachTerminalToHub(provider);

    try {
      for (const command of ["tee tee-out.txt", "printf hi | tee out.txt", "tee -a log.txt"]) {
        const result = await hub.invoke("terminal", "/session", "execute", {
          command,
          background: false,
        });
        expect(result.status).toBe("error");
        expect(result.error?.code).toBe("approval_required");
      }

      // tee /dev/null is harmless and should be allowed.
      const okResult = await hub.invoke("terminal", "/session", "execute", {
        command: "printf hi | tee /dev/null",
        background: false,
      });
      expect(okResult.status).toBe("ok");
    } finally {
      hub.shutdown();
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
    const { hub, consumer } = await attachTerminalToHub(provider);

    try {
      const result = await hub.invoke("terminal", "/session", "execute", {
        command: "printf hello 2>&1",
        background: false,
      });

      expect(result.status).toBe("ok");
      expect((result.data as { stdout: string }).stdout).toBe("hello");

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children ?? []).toHaveLength(0);
    } finally {
      hub.shutdown();
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
      expect(session.properties?.cwd).toBe(realpathSync(cwd));
    } finally {
      provider.stop();
    }
  });

  test("rejects cd into a symlink that points outside the workspace root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);
    const outside = await mkdtemp(join(tmpdir(), "sloppy-terminal-outside-"));
    tempPaths.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(cwd, "escape"));

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 5000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const escapeResult = await consumer.invoke("/session", "cd", {
        path: "escape",
      });
      expect(escapeResult.status).toBe("error");
      expect(escapeResult.error?.message ?? "").toContain("outside workspace root");

      const session = await consumer.query("/session", 1);
      expect(session.properties?.cwd).toBe(realpathSync(cwd));
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

  test("cancelling a background task preserves cancelled status after process exit", async () => {
    // Regression: cancelTask() killed the process and set status to
    // "cancelled", but the process completion handler later overwrote it
    // with "done"/"failed" once `process.exited` resolved.
    const cwd = await mkdtemp(join(tmpdir(), "sloppy-terminal-"));
    tempPaths.push(cwd);

    const provider = new TerminalProvider({
      cwd,
      historyLimit: 10,
      syncTimeoutMs: 30000,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 4);

      const start = await consumer.invoke("/session", "execute", {
        command: "sleep 30",
        background: true,
      });
      expect(start.status).toBe("accepted");
      const taskId = (start.data as { taskId: string }).taskId;

      const cancel = await consumer.invoke(`/tasks/${taskId}`, "cancel", {});
      expect(cancel.status).toBe("ok");
      expect((cancel.data as { status: string }).status).toBe("cancelled");

      // Wait for the killed process to fully exit and the completion handler
      // to run. Polling avoids a fixed sleep — once status flips it's stable.
      const deadline = Date.now() + 5000;
      let finalStatus: string | undefined;
      while (Date.now() < deadline) {
        const tasks = await consumer.query("/tasks", 3);
        const node = tasks.children?.find((child) => child.id === taskId);
        finalStatus = node?.properties?.status as string | undefined;
        // Cancel removed; only show_output remains. Once the process has
        // exited, exit_code transitions away from null.
        if (node && node.properties?.exit_code !== null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(finalStatus).toBe("cancelled");
    } finally {
      provider.stop();
    }
  });
});

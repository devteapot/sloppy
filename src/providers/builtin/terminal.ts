import { basename, resolve } from "node:path";
import { AsyncActionResult as CoreAsyncActionResult } from "@slop-ai/core";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { ProviderApprovalManager } from "../approvals";
import { isWithinRoot, safeRealpath } from "./path-containment";

type CommandRecord = {
  id: string;
  command: string;
  cwd: string;
  status: "ok" | "error" | "running" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type RunningTask = {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  message: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
};

function truncateOutput(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

function buildTaskId(): string {
  return `task-${crypto.randomUUID()}`;
}

export class TerminalProvider {
  readonly server: SlopServer;
  private root: string;
  private cwd: string;
  private historyLimit: number;
  private syncTimeoutMs: number;
  readonly approvals: ProviderApprovalManager;
  private history: CommandRecord[] = [];
  private tasks = new Map<string, RunningTask>();

  constructor(options: { cwd: string; historyLimit: number; syncTimeoutMs: number }) {
    const rawRoot = resolve(options.cwd);
    this.root = safeRealpath(rawRoot) ?? rawRoot;
    this.cwd = this.root;
    this.historyLimit = options.historyLimit;
    this.syncTimeoutMs = options.syncTimeoutMs;

    this.server = createSlopServer({
      id: "terminal",
      name: "Terminal",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("history", () => this.buildHistoryDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.process.kill();
    }
    this.server.stop();
  }

  private pushHistory(record: CommandRecord): void {
    this.history.unshift(record);
    this.history = this.history.slice(0, this.historyLimit);
  }

  private async changeDirectory(path: string): Promise<{ cwd: string }> {
    const next = this.resolveDirectoryInput(path);
    this.assertWithinRoot(next, path);
    const info = await Bun.file(next)
      .stat()
      .catch(() => null);
    if (!info) {
      throw new Error(`Directory does not exist: ${path}`);
    }

    if (!info.isDirectory()) {
      throw new Error(`Directory does not exist: ${path}`);
    }

    this.cwd = next;
    return { cwd: this.cwd };
  }

  private assertWithinRoot(candidate: string, original: string): void {
    // Resolve symlinks along the path so a symlink inside the workspace
    // pointing outside (e.g. `${root}/escape -> /tmp/elsewhere`) can't be
    // used to cd out of the root.
    if (!isWithinRoot(this.root, candidate)) {
      throw new Error(`Refusing to cd outside workspace root (${this.root}): ${original}`);
    }
  }

  private resolveDirectoryInput(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === "." || trimmed === "./") {
      return this.cwd;
    }

    if (trimmed === "/workspace" || trimmed === "workspace") {
      return this.root;
    }
    if (trimmed.startsWith("/workspace/")) {
      return resolve(this.root, trimmed.slice("/workspace/".length));
    }
    if (trimmed.startsWith("workspace/")) {
      return resolve(this.root, trimmed.slice("workspace/".length));
    }

    const rootName = basename(this.root);
    if (trimmed === rootName || trimmed === `./${rootName}`) {
      return this.root;
    }
    if (trimmed.startsWith(`${rootName}/`)) {
      return resolve(this.root, trimmed.slice(rootName.length + 1));
    }
    if (trimmed.startsWith(`./${rootName}/`)) {
      return resolve(this.root, trimmed.slice(rootName.length + 3));
    }

    return resolve(this.cwd, trimmed);
  }

  private spawnCommand(command: string) {
    return Bun.spawn({
      cmd: [Bun.env.SHELL ?? "/bin/sh", "-lc", command],
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: Bun.env,
    });
  }

  private async runSyncCommand(command: string): Promise<CommandRecord> {
    const startedAt = Date.now();
    const process = this.spawnCommand(command);
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => {
        process.kill();
        reject(new Error(`Command timed out after ${this.syncTimeoutMs}ms`));
      }, this.syncTimeoutMs);

      process.exited.finally(() => {
        clearTimeout(timeout);
      });
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]),
        timeoutPromise,
      ]);

      const record: CommandRecord = {
        id: buildTaskId(),
        command,
        cwd: this.cwd,
        status: exitCode === 0 ? "ok" : "error",
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
      this.pushHistory(record);
      return record;
    } catch (error) {
      const record: CommandRecord = {
        id: buildTaskId(),
        command,
        cwd: this.cwd,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
      this.pushHistory(record);
      return record;
    }
  }

  private startBackgroundCommand(command: string): CoreAsyncActionResult {
    const taskId = buildTaskId();
    const process = this.spawnCommand(command);
    const task: RunningTask = {
      id: taskId,
      command,
      cwd: this.cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      message: "Running",
      stdout: "",
      stderr: "",
      exitCode: null,
      process,
    };
    this.tasks.set(taskId, task);

    void Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
      .then(([stdout, stderr, exitCode]) => {
        const existing = this.tasks.get(taskId);
        if (!existing) {
          return;
        }

        existing.stdout = stdout;
        existing.stderr = stderr;
        existing.exitCode = exitCode;
        // Preserve a prior cancellation: cancelTask() flips status to
        // "cancelled" and kills the process, but the killed process still
        // resolves `exited` after, which would otherwise overwrite the
        // status back to done/failed.
        if (existing.status !== "cancelled") {
          existing.status = exitCode === 0 ? "done" : "failed";
          existing.message = exitCode === 0 ? "Completed" : "Failed";
        }

        this.pushHistory({
          id: taskId,
          command,
          cwd: existing.cwd,
          status: existing.status === "cancelled" ? "cancelled" : exitCode === 0 ? "ok" : "error",
          exitCode,
          stdout,
          stderr,
          durationMs: 0,
        });

        this.server.refresh();
      })
      .catch((error) => {
        const existing = this.tasks.get(taskId);
        if (!existing) {
          return;
        }

        if (existing.status !== "cancelled") {
          existing.status = "failed";
          existing.message = error instanceof Error ? error.message : String(error);
        }
        existing.stderr = error instanceof Error ? error.message : String(error);
        existing.exitCode = null;
        this.server.refresh();
      });

    return new CoreAsyncActionResult(taskId, { taskId, cwd: this.cwd });
  }

  private cancelTask(taskId: string): { taskId: string; status: string } {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    task.process.kill();
    task.status = "cancelled";
    task.message = "Cancelled";
    return { taskId, status: task.status };
  }

  private showTaskOutput(taskId: string): { taskId: string; stdout: string; stderr: string } {
    const historyEntry = this.history.find((entry) => entry.id === taskId);
    if (historyEntry) {
      return {
        taskId,
        stdout: historyEntry.stdout,
        stderr: historyEntry.stderr,
      };
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    return {
      taskId,
      stdout: task.stdout,
      stderr: task.stderr,
    };
  }

  private buildSessionDescriptor() {
    return {
      type: "context",
      props: {
        cwd: this.cwd,
        shell: Bun.env.SHELL ?? "/bin/sh",
        running_tasks: [...this.tasks.values()].filter((task) => task.status === "running").length,
      },
      summary: "Current shell session and command affordances.",
      actions: {
        execute: action(
          {
            command: "string",
            background: {
              type: "boolean",
              description:
                "Optional. Run the command asynchronously and expose progress via the tasks collection.",
              optional: true,
            },
          },
          async ({ command, background }) => {
            // Destructive-command gating lives in the hub-level
            // `terminalSafetyRule`. On approval the hub re-invokes with
            // `preApproved: true` (out-of-band on `InvokeContext`), so the
            // descriptor exposes no caller-controlled bypass parameter.
            if (background) {
              return this.startBackgroundCommand(command);
            }

            return this.runSyncCommand(command);
          },
          {
            label: "Execute Command",
            description: "Run a shell command in the current working directory.",
            estimate: "slow",
          },
        ),
        cd: action({ path: "string" }, async ({ path }) => this.changeDirectory(path), {
          label: "Change Directory",
          description: "Update the terminal working directory.",
          idempotent: true,
          estimate: "instant",
        }),
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
  }

  private buildHistoryDescriptor() {
    const items: ItemDescriptor[] = this.history.map((entry) => ({
      id: entry.id,
      props: {
        command: entry.command,
        cwd: entry.cwd,
        status: entry.status,
        exitCode: entry.exitCode,
        durationMs: entry.durationMs,
        stdoutPreview: truncateOutput(entry.stdout),
        stderrPreview: truncateOutput(entry.stderr),
      },
      actions: {
        show_output: action(async () => this.showTaskOutput(entry.id), {
          label: "Show Output",
          description: "Return the full stdout and stderr for this command.",
          idempotent: true,
          estimate: "fast",
        }),
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Recent terminal command history.",
      items,
    };
  }

  private buildTasksDescriptor() {
    const items: ItemDescriptor[] = [...this.tasks.values()].map((task) => ({
      id: task.id,
      props: {
        command: task.command,
        cwd: task.cwd,
        status: task.status,
        message: task.message,
        started_at: task.startedAt,
        exit_code: task.exitCode,
      },
      actions: {
        ...(task.status === "running"
          ? {
              cancel: action(async () => this.cancelTask(task.id), {
                label: "Cancel Task",
                description: "Terminate the running command.",
                dangerous: true,
                estimate: "instant",
              }),
            }
          : {}),
        show_output: action(async () => this.showTaskOutput(task.id), {
          label: "Show Task Output",
          description: "Return the captured stdout and stderr for this task.",
          idempotent: true,
          estimate: "fast",
        }),
      },
      meta: {
        salience: task.status === "running" ? 0.9 : task.status === "failed" ? 1 : 0.5,
        urgency: task.status === "failed" ? "high" : task.status === "running" ? "medium" : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Background terminal tasks and recent completions.",
      items,
    };
  }
}

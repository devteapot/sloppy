import { type ChildProcessByStdio, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { AgentCallbacks, AgentRunResult, ResolvedApprovalToolResult } from "../../core/agent";
import type { SessionAgent } from "../../session/runtime";

export type CliAdapterConfig = {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  appendPrompt?: boolean;
};

export type CliSessionAgentOptions = {
  adapterId: string;
  adapter: CliAdapterConfig;
  callbacks: AgentCallbacks;
  workspaceRoot: string;
  defaultTimeoutMs?: number;
};

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 16)}...[truncated]`;
}

function commandWithPrompt(adapter: CliAdapterConfig, userMessage: string): string[] {
  const command = [...adapter.command];
  const replaced = command.map((part) => part.replaceAll("{prompt}", userMessage));
  if (adapter.appendPrompt === false || replaced.some((part, index) => part !== command[index])) {
    return replaced;
  }
  return [...replaced, userMessage];
}

export class CliSessionAgent implements SessionAgent {
  private readonly adapterId: string;
  private readonly adapter: CliAdapterConfig;
  private readonly callbacks: AgentCallbacks;
  private readonly workspaceRoot: string;
  private readonly timeoutMs?: number;
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private started = false;
  private activeReject: ((error: Error) => void) | null = null;

  constructor(options: CliSessionAgentOptions) {
    this.adapterId = options.adapterId;
    this.adapter = options.adapter;
    this.callbacks = options.callbacks;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.timeoutMs = options.adapter.timeoutMs ?? options.defaultTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.adapter.command.length === 0 || !this.adapter.command[0]) {
      throw new Error(`CLI adapter '${this.adapterId}' has no command configured.`);
    }
    this.started = true;
  }

  async chat(userMessage: string): Promise<AgentRunResult> {
    await this.start();
    if (this.child) {
      throw new Error(`CLI adapter '${this.adapterId}' already has an active turn.`);
    }

    const command = commandWithPrompt(this.adapter, userMessage);
    const executable = command[0];
    if (!executable) {
      throw new Error(`CLI adapter '${this.adapterId}' has no command configured.`);
    }

    const args = command.slice(1);
    let stdout = "";
    let stderr = "";
    let timeout: ReturnType<typeof setTimeout> | null = null;

    return new Promise<AgentRunResult>((resolvePromise, rejectPromise) => {
      const fail = (error: Error) => {
        this.activeReject = null;
        rejectPromise(error);
      };
      this.activeReject = fail;
      const child = spawn(executable, args, {
        cwd: resolve(this.adapter.cwd ?? this.workspaceRoot),
        env: {
          ...process.env,
          ...(this.adapter.env ?? {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        this.callbacks.onText?.(text);
      });

      child.stderr.on("data", (chunk) => {
        stderr = truncate(`${stderr}${String(chunk)}`, 8000);
      });

      child.once("error", (error) => {
        if (timeout) clearTimeout(timeout);
        this.child = null;
        fail(error);
      });

      child.once("close", (code, signal) => {
        if (timeout) clearTimeout(timeout);
        this.child = null;
        this.activeReject = null;
        if (signal) {
          rejectPromise(new Error(`CLI adapter '${this.adapterId}' exited by signal ${signal}.`));
          return;
        }
        if (code !== 0) {
          rejectPromise(
            new Error(
              `CLI adapter '${this.adapterId}' exited with code ${code ?? "unknown"}.${stderr ? ` stderr: ${stderr}` : ""}`,
            ),
          );
          return;
        }
        resolvePromise({
          status: "completed",
          response: stdout.trim(),
        });
      });

      if (this.timeoutMs) {
        timeout = setTimeout(() => {
          this.cancelActiveTurn();
          fail(new Error(`CLI adapter '${this.adapterId}' timed out after ${this.timeoutMs}ms.`));
        }, this.timeoutMs);
      }
    });
  }

  async resumeWithToolResult(_result: ResolvedApprovalToolResult): Promise<AgentRunResult> {
    throw new Error("CLI-backed session agents do not support approval resume.");
  }

  async invokeProvider(): Promise<ResultMessage> {
    return {
      type: "result",
      id: crypto.randomUUID(),
      status: "error",
      error: {
        code: "unsupported",
        message: "CLI-backed session agents do not expose provider invocation.",
      },
    };
  }

  async resolveApprovalDirect(approvalId: string): Promise<ResultMessage> {
    return {
      type: "result",
      id: approvalId,
      status: "error",
      error: {
        code: "unsupported",
        message: "CLI-backed session agents do not expose direct approval resolution.",
      },
    };
  }

  rejectApprovalDirect(): void {}

  cancelActiveTurn(): boolean {
    if (!this.child) {
      return false;
    }
    const child = this.child;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 1000).unref();
    this.child = null;
    const reject = this.activeReject;
    this.activeReject = null;
    reject?.(new Error(`CLI adapter '${this.adapterId}' turn cancelled.`));
    return true;
  }

  clearPendingApproval(): void {}

  shutdown(): void {
    this.cancelActiveTurn();
    this.started = false;
  }
}

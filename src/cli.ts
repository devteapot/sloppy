#!/usr/bin/env bun

import { defaultConfigPromise } from "./config/load";
import { Agent, type AgentRunResult } from "./core/agent";

const DEFAULT_CONFIG = await defaultConfigPromise;
const stdout = Bun.stdout.writer();
const stderr = Bun.stderr.writer();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeStdout(text: string): void {
  stdout.write(text);
}

function writeStderr(text: string): void {
  stderr.write(text);
}

function writeProviderNotice(agent: Agent): void {
  const providers = agent.listConnectedProviders();
  const ids = providers.map((p) => p.id).join(", ");
  writeStderr(`[sloppy] providers: ${ids} (${providers.length})\n`);
}

function summarizeApprovalResult(result: AgentRunResult | null): void {
  if (!result) {
    writeStdout("[approval] resolved (no matching pending turn)\n");
    return;
  }
  if (result.status === "waiting_approval") {
    writeStdout("\n[approval] turn is waiting on another approval\n");
  }
}

async function runSingleShot(prompt: string): Promise<number> {
  let streamed = false;
  const agent = new Agent({
    config: DEFAULT_CONFIG,
    onText: (chunk) => {
      streamed = true;
      writeStdout(chunk);
    },
    onToolCall: (summary) => {
      writeStdout(`\n[tool] ${summary}\n`);
    },
    onToolResult: (summary) => {
      writeStdout(`[result] ${summary}\n`);
    },
  });

  try {
    await agent.start();
    writeProviderNotice(agent);
    const response = await agent.chat(prompt);
    if (response.status === "completed") {
      if (!streamed && response.response) {
        writeStdout(response.response);
      }
      writeStdout("\n");
      return 0;
    }
    // Single-shot cannot resolve the approval (the agent and its hub are
    // about to be torn down in `finally`). Reject the queued approval so
    // we don't leave a live, approvable destructive command behind, then
    // tell the user accurately that the turn was dropped.
    const approvalId = agent.getPendingApprovalSourceId();
    if (approvalId) {
      try {
        agent.rejectApprovalDirect(approvalId, "Single-shot CLI cannot resolve approvals.");
      } catch {
        // best-effort
      }
    }
    writeStdout(
      `\n[approval] turn was dropped — single-shot CLI cannot resolve approvals${approvalId ? ` (${approvalId})` : ""}. Run \`bun src/cli.ts\` interactively to handle approvals.\n`,
    );
    return 2;
  } catch (error) {
    writeStderr(`[error] ${errorMessage(error)}\n`);
    return 1;
  } finally {
    agent.shutdown();
  }
}

const REPL_HELP = [
  "Commands:",
  "  /help                — show this help",
  "  /approvals           — list pending approvals",
  "  /approve <id>        — approve and resume the paused turn",
  "  /reject <id> [reason]— reject and resume the paused turn",
  "  exit | quit          — leave the REPL",
  "",
].join("\n");

function listApprovalsLine(agent: Agent): string {
  const items = agent.listApprovals();
  const pending = items.filter((a) => a.status === "pending");
  if (pending.length === 0) {
    return "[approvals] no pending approvals\n";
  }
  return pending
    .map(
      (a) =>
        `  ${a.id}  ${a.providerId}:${a.action} ${a.path}\n    reason: ${a.reason}${
          a.paramsPreview ? `\n    params: ${a.paramsPreview}` : ""
        }`,
    )
    .join("\n")
    .concat("\n");
}

async function handleSlashCommand(agent: Agent, line: string): Promise<boolean> {
  const [command, ...rest] = line.slice(1).split(/\s+/);
  switch (command) {
    case "help": {
      writeStdout(REPL_HELP);
      return true;
    }
    case "approvals": {
      writeStdout(listApprovalsLine(agent));
      return true;
    }
    case "approve": {
      const id = rest[0];
      if (!id) {
        writeStdout("[approve] usage: /approve <id>\n");
        return true;
      }
      try {
        const result = await agent.approveAndResume(id);
        summarizeApprovalResult(result);
      } catch (error) {
        writeStdout(`[error] ${errorMessage(error)}\n`);
      }
      return true;
    }
    case "reject": {
      const id = rest[0];
      const reason = rest.slice(1).join(" ").trim() || undefined;
      if (!id) {
        writeStdout("[reject] usage: /reject <id> [reason]\n");
        return true;
      }
      try {
        const result = await agent.rejectAndResume(id, reason);
        summarizeApprovalResult(result);
      } catch (error) {
        writeStdout(`[error] ${errorMessage(error)}\n`);
      }
      return true;
    }
    default: {
      writeStdout(`[error] unknown command: /${command}. Try /help.\n`);
      return true;
    }
  }
}

async function runRepl(): Promise<number> {
  const agent = new Agent({
    config: DEFAULT_CONFIG,
    onText: (chunk) => {
      writeStdout(chunk);
    },
    onToolCall: (summary) => {
      writeStdout(`\n[tool] ${summary}\n`);
    },
    onToolResult: (summary) => {
      writeStdout(`[result] ${summary}\n`);
    },
  });

  try {
    await agent.start();
    writeProviderNotice(agent);
    writeStdout("Type /help for commands.\n");
    while (true) {
      const line = prompt("sloppy> ");
      if (line == null) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === "exit" || trimmed === "quit") {
        break;
      }

      if (trimmed.startsWith("/")) {
        await handleSlashCommand(agent, trimmed);
        continue;
      }

      if (agent.getPendingApprovalInvocation()) {
        const approvalId = agent.getPendingApprovalSourceId();
        writeStdout(
          `[approval] turn is waiting on approval${approvalId ? ` ${approvalId}` : ""}. Run /approvals or /approve <id>.\n`,
        );
        continue;
      }

      try {
        const result = await agent.chat(trimmed);
        if (result.status === "waiting_approval") {
          const approvalId = agent.getPendingApprovalSourceId();
          writeStdout(
            `\n[approval] turn is waiting on approval${approvalId ? ` ${approvalId}` : ""}. Run /approvals to inspect.\n`,
          );
        }
      } catch (error) {
        writeStdout(`\n[error] ${errorMessage(error)}\n`);
      }
      writeStdout("\n");
    }
    return 0;
  } finally {
    agent.shutdown();
  }
}

const inputPrompt = Bun.argv.slice(2).join(" ").trim();
const exitCode = inputPrompt ? await runSingleShot(inputPrompt) : await runRepl();

await stdout.flush();
await stderr.flush();

if (exitCode !== 0) {
  process.exitCode = exitCode;
}

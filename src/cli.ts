#!/usr/bin/env bun

import { defaultConfigPromise } from "./config/load";
import { Agent } from "./core/agent";

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
    } else {
      writeStdout("\n[approval] turn is waiting on provider approval\n");
    }
    writeStdout("\n");
    return 0;
  } catch (error) {
    writeStderr(`[error] ${errorMessage(error)}\n`);
    return 1;
  } finally {
    agent.shutdown();
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

      try {
        const result = await agent.chat(trimmed);
        if (result.status === "waiting_approval") {
          writeStdout("\n[approval] turn is waiting on provider approval\n");
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

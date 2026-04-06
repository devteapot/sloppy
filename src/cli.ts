#!/usr/bin/env bun

import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { Agent } from "./core/agent";

async function runSingleShot(prompt: string): Promise<void> {
  let streamed = false;
  const agent = new Agent({
    onText: (chunk) => {
      streamed = true;
      process.stdout.write(chunk);
    },
    onToolCall: (summary) => {
      process.stdout.write(`\n[tool] ${summary}\n`);
    },
    onToolResult: (summary) => {
      process.stdout.write(`[result] ${summary}\n`);
    },
  });

  try {
    await agent.start();
    const response = await agent.chat(prompt);
    if (response.status === "completed") {
      if (!streamed && response.response) {
        process.stdout.write(response.response);
      }
    } else {
      process.stdout.write("\n[approval] turn is waiting on provider approval\n");
    }
    process.stdout.write("\n");
  } finally {
    agent.shutdown();
  }
}

async function runRepl(): Promise<void> {
  const agent = new Agent({
    onText: (chunk) => {
      process.stdout.write(chunk);
    },
    onToolCall: (summary) => {
      process.stdout.write(`\n[tool] ${summary}\n`);
    },
    onToolResult: (summary) => {
      process.stdout.write(`[result] ${summary}\n`);
    },
  });
  const rl = readline.createInterface({ input, output });

  try {
    await agent.start();
    while (true) {
      const line = await rl.question("sloppy> ");
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === "exit" || trimmed === "quit") {
        break;
      }

      const result = await agent.chat(trimmed);
      if (result.status === "waiting_approval") {
        process.stdout.write("\n[approval] turn is waiting on provider approval\n");
      }
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
    agent.shutdown();
  }
}

const prompt = process.argv.slice(2).join(" ").trim();

if (prompt) {
  await runSingleShot(prompt);
} else {
  await runRepl();
}

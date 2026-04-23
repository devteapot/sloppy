#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { defaultConfigPromise } from "../src/config/load";
import { Agent } from "../src/core/agent";

const stdout = Bun.stdout.writer();
const stderr = Bun.stderr.writer();

function writeOut(text: string): void {
  stdout.write(text);
}

function writeErr(text: string): void {
  stderr.write(text);
}

async function main(): Promise<number> {
  const goal = Bun.argv.slice(2).join(" ").trim();
  if (!goal) {
    writeErr("usage: bun run demo:orchestrate \"<goal>\"\n");
    return 1;
  }

  const workspace = resolve(".sloppy-demo");
  mkdirSync(workspace, { recursive: true });

  const baseConfig = await defaultConfigPromise;
  const config = {
    ...baseConfig,
    agent: { ...baseConfig.agent, orchestratorMode: true },
    providers: {
      ...baseConfig.providers,
      builtin: {
        ...baseConfig.providers.builtin,
        terminal: false,
        memory: false,
        skills: false,
        web: false,
        browser: false,
        cron: false,
        messaging: false,
        vision: false,
        filesystem: true,
        delegation: true,
        orchestration: true,
      },
      filesystem: { ...baseConfig.providers.filesystem, root: workspace, focus: workspace },
    },
  };

  writeOut(`[demo] workspace: ${workspace}\n`);
  writeOut(`[demo] orchestrator state: ${workspace}/.sloppy/orchestration/\n`);
  writeOut(`[demo] tip: SLOPPY_DEBUG=all bun run demo:orchestrate "..." for verbose traces\n\n`);

  let streamed = false;
  const agent = new Agent({
    config,
    onText: (chunk) => {
      streamed = true;
      writeOut(chunk);
    },
    onToolCall: (summary) => writeOut(`\n[tool] ${summary}\n`),
    onToolResult: (summary) => writeOut(`[result] ${summary}\n`),
  });

  try {
    await agent.start();
    const response = await agent.chat(goal);
    if (response.status === "completed" && !streamed && response.response) {
      writeOut(response.response);
    }
    writeOut("\n\n[demo] done. Inspect .sloppy-demo/.sloppy/orchestration/ for the durable plan + tasks.\n");
    return 0;
  } catch (error) {
    writeErr(`[demo] error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    agent.shutdown();
  }
}

const code = await main();
await stdout.flush();
await stderr.flush();
if (code !== 0) process.exitCode = code;

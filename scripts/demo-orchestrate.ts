#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { defaultConfigPromise } from "../src/config/load";
import { Agent, type AgentCallbacks } from "../src/core/agent";
import { buildRuntimeLlmConfig, hasExplicitRuntimeLlmRouting } from "../src/llm/runtime-config";
import { createAgentEventBus, mergeCallbacks } from "../src/session/event-bus";

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
  const useRuntimeLlmRouting = hasExplicitRuntimeLlmRouting(Bun.env);
  const config = {
    ...baseConfig,
    llm: useRuntimeLlmRouting ? buildRuntimeLlmConfig(baseConfig.llm, Bun.env) : baseConfig.llm,
    agent: {
      ...baseConfig.agent,
      orchestratorMode: true,
      maxIterations: Math.max(baseConfig.agent.maxIterations, 60),
    },
    providers: {
      ...baseConfig.providers,
      builtin: {
        ...baseConfig.providers.builtin,
        terminal: true,
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
      terminal: {
        ...baseConfig.providers.terminal,
        cwd: workspace,
        syncTimeoutMs: Math.max(baseConfig.providers.terminal.syncTimeoutMs, 300_000),
      },
      discovery: { ...baseConfig.providers.discovery, enabled: false },
    },
  };

  writeOut(`[demo] workspace: ${workspace}\n`);
  writeOut(`[demo] orchestrator state: ${workspace}/.sloppy/orchestration/\n`);
  if (useRuntimeLlmRouting) {
    const llm = config.llm;
    const endpoint = llm.baseUrl ? ` @ ${llm.baseUrl}` : "";
    writeOut(
      `[demo] llm: using process env routing for ${llm.provider} ${llm.model}${endpoint}; managed profiles disabled for this run\n`,
    );
  }
  writeOut(`[demo] tip: SLOPPY_DEBUG=all bun run demo:orchestrate "..." for verbose traces\n\n`);

  let streamed = false;
  const callbacks: AgentCallbacks = {
    onText: (chunk) => {
      streamed = true;
      writeOut(chunk);
    },
    onToolCall: (summary) => writeOut(`\n[tool] ${summary}\n`),
    onToolResult: (summary) => writeOut(`[result] ${summary}\n`),
  };
  const eventBus = process.env.SLOPPY_EVENT_LOG
    ? createAgentEventBus({
        logPath: process.env.SLOPPY_EVENT_LOG,
        actor: {
          id: "orchestrator",
          name: "Orchestrator",
          kind: "orchestrator",
        },
      })
    : null;
  const agent = new Agent({
    config,
    ...(eventBus ? mergeCallbacks(callbacks, eventBus.callbacks) : callbacks),
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
    eventBus?.stop();
    agent.shutdown();
  }
}

const code = await main();
await stdout.flush();
await stderr.flush();
if (code !== 0) process.exitCode = code;

#!/usr/bin/env bun

import { type RuntimeSmokeMode, runRuntimeSmoke } from "./smoke-runner";

function usage(): string {
  return [
    "Usage: bun run runtime:smoke [--mode providers|native|acp|cli] [options]",
    "",
    "Options:",
    "  --mode <mode>          providers (default), native, acp, or cli",
    "  --profile <id>         LLM profile id for native mode",
    "  --model <model>        model override for native mode",
    "  --acp-adapter <id>     configured ACP adapter id for acp mode",
    "  --cli-adapter <id>     configured CLI adapter id for cli mode",
    "  --workspace <path>     workspace/state root; defaults to a temp dir",
    "  --timeout-ms <ms>      delegated-agent timeout; default 120000",
    "  --keep-state           keep temp smoke state after completion",
    "  -h, --help             show this help",
    "",
  ].join("\n");
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(args: string[]) {
  const options: {
    mode?: RuntimeSmokeMode;
    profileId?: string;
    modelOverride?: string;
    acpAdapterId?: string;
    cliAdapterId?: string;
    workspaceRoot?: string;
    timeoutMs?: number;
    keepState?: boolean;
    help?: boolean;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--mode": {
        const mode = takeValue(args, index, arg);
        if (mode !== "providers" && mode !== "native" && mode !== "acp" && mode !== "cli") {
          throw new Error(`Unknown smoke mode: ${mode}`);
        }
        options.mode = mode;
        index += 1;
        break;
      }
      case "--profile":
        options.profileId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--model":
        options.modelOverride = takeValue(args, index, arg);
        index += 1;
        break;
      case "--acp-adapter":
        options.acpAdapterId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--cli-adapter":
        options.cliAdapterId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--workspace":
        options.workspaceRoot = takeValue(args, index, arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(takeValue(args, index, arg), 10);
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
          throw new Error("--timeout-ms must be an integer >= 1000.");
        }
        index += 1;
        break;
      case "--keep-state":
        options.keepState = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

try {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const result = await runRuntimeSmoke({
    mode: options.mode,
    profileId: options.profileId,
    modelOverride: options.modelOverride,
    acpAdapterId: options.acpAdapterId,
    cliAdapterId: options.cliAdapterId,
    workspaceRoot: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    keepState: options.keepState,
    log: (line) => process.stderr.write(`[runtime:smoke] ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `[runtime:smoke] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

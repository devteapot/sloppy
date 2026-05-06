#!/usr/bin/env bun

import { runRuntimeDoctor } from "./doctor-runner";

function usage(): string {
  return [
    "Usage: bun run runtime:doctor [options]",
    "",
    "Options:",
    "  --litellm-url <url>    OpenAI-compatible base URL to check",
    "  --acp-adapter <id>     configured ACP adapter id to check",
    "  --workspace <path>     workspace/config root; defaults to cwd",
    "  --timeout-ms <ms>      check timeout; default 5000",
    "  --event-log <path>     audit log path to verify; defaults to SLOPPY_EVENT_LOG",
    "  --socket <path>        session or supervisor Unix socket path to verify",
    "  --migrate-persistence  rewrite legacy session/meta-runtime state envelopes with backups",
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
    litellmUrl?: string;
    acpAdapterId?: string;
    workspaceRoot?: string;
    timeoutMs?: number;
    eventLogPath?: string;
    socketPath?: string;
    migratePersistence?: boolean;
    help?: boolean;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--litellm-url":
        options.litellmUrl = takeValue(args, index, arg);
        index += 1;
        break;
      case "--acp-adapter":
        options.acpAdapterId = takeValue(args, index, arg);
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
      case "--event-log":
        options.eventLogPath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--socket":
        options.socketPath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--migrate-persistence":
        options.migratePersistence = true;
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

  const result = await runRuntimeDoctor(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.checks.some((check) => check.status === "error") ? 1 : 0;
} catch (error) {
  process.stderr.write(
    `[runtime:doctor] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

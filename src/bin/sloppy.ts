#!/usr/bin/env bun

import { runTui } from "../../apps/tui/src/index";
import { runHeadlessSingleShot } from "../cli-headless";
import { loadConfig, loadScopedConfig } from "../config/load";
import { runGateway } from "../gateway/cli";
import { resolveLaunchScope } from "../session/launch-scope";
import { SessionService } from "../session/service";
import { startSessionSupervisor } from "../session/supervisor";

const stdout = Bun.stdout.writer();
const stderr = Bun.stderr.writer();

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function approvalModeFromArgs(args: string[]): "auto" | undefined {
  return hasFlag(args, "--yolo") ? "auto" : undefined;
}

function stripStandaloneFlags(args: string[], flags: string[]): string[] {
  const set = new Set(flags);
  return args.filter((arg) => !set.has(arg));
}

function writeStdout(text: string): void {
  stdout.write(text);
}

function writeStderr(text: string): void {
  stderr.write(text);
}

async function runSingleShot(args: string[]): Promise<number> {
  const promptArgs = stripStandaloneFlags(args, ["--yolo"]);
  const promptIndex = promptArgs.findIndex((arg) => arg === "-p" || arg === "--prompt");
  const prompt =
    promptIndex >= 0
      ? promptArgs
          .slice(promptIndex + 1)
          .join(" ")
          .trim()
      : promptArgs
          .find((arg) => arg.startsWith("--prompt="))
          ?.slice("--prompt=".length)
          .trim();
  if (!prompt) {
    writeStderr("[error] --prompt requires a prompt.\n");
    return 1;
  }
  return runHeadlessSingleShot({
    prompt,
    config: await loadConfig(),
    approvalMode: approvalModeFromArgs(args),
    metricsPath: Bun.env.SLOPPY_CLI_METRICS_PATH,
    writeStdout,
    writeStderr,
  });
}

async function runSessionSupervisor(args: string[]): Promise<number> {
  const socketPath = readOption(args, "--socket");
  if (!socketPath) {
    writeStderr("[error] --socket is required for session supervisor.\n");
    return 1;
  }
  const idleTimeoutMs = Number(readOption(args, "--idle-timeout-ms") ?? 5000);
  const running = await startSessionSupervisor({
    socketPath,
    cwd: process.cwd(),
    launchScope: hasFlag(args, "--managed") ? resolveLaunchScope(process.cwd()) : undefined,
    initial: hasFlag(args, "--no-initial-session")
      ? false
      : {
          workspace_id: readOption(args, "--workspace-id"),
          project_id: readOption(args, "--project-id"),
          title: readOption(args, "--title"),
          session_id: readOption(args, "--session-id"),
          approval_mode: approvalModeFromArgs(args),
        },
    autoClose: hasFlag(args, "--auto-close-enabled")
      ? {
          enabled: true,
          idleTimeoutMs: Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : 5000,
          onClose: () => process.exit(0),
        }
      : undefined,
  });
  writeStdout(
    `[sloppy] session supervisor listening on ${socketPath}${
      running.initialSession ? `; initial session ${running.initialSession.socketPath}` : ""
    }\n`,
  );
  await stdout.flush();

  const shutdown = () => {
    running.listener.close();
    running.supervisor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {});
  return 0;
}

async function runSessionServe(args: string[]): Promise<number> {
  const workspaceId = readOption(args, "--workspace-id");
  const projectId = readOption(args, "--project-id");
  const config = await loadScopedConfig({
    workspaceId,
    projectId,
  });
  const service = new SessionService({
    config,
    sessionId: readOption(args, "--session-id"),
    title: readOption(args, "--title"),
    socketPath: readOption(args, "--socket"),
    approvalMode: approvalModeFromArgs(args),
    configReloader: () => loadScopedConfig({ workspaceId, projectId }),
  });
  await service.start();
  writeStdout(
    `[sloppy] session API listening on ${service.socketPath} (${config.plugins.filesystem.root})\n`,
  );
  await stdout.flush();

  const shutdown = () => {
    service.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {});
  return 0;
}

function usage(): string {
  return [
    "Usage:",
    "  sloppy",
    "  sloppy --yolo",
    "  sloppy --continue",
    '  sloppy -p "<prompt>" [--yolo]',
    "  sloppy session serve [--socket <path>] [--yolo]",
    "  sloppy session supervisor --socket <path> [--yolo]",
    "  sloppy gateway --port <port> [--host <host>] [--token-env <name>] [--supervisor-socket <path>]",
    "",
  ].join("\n");
}

async function main(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    writeStdout(usage());
    return 0;
  }
  if (args[0] === "session") {
    if (args[1] === "supervisor") {
      return runSessionSupervisor(args.slice(2));
    }
    if (args[1] === "serve") {
      return runSessionServe(args.slice(2));
    }
    writeStderr(`[error] unknown session command: ${args[1] ?? ""}\n${usage()}`);
    return 1;
  }
  if (args[0] === "gateway") {
    return runGateway(args.slice(1));
  }
  if (args[0] === "tui") {
    return runTui(args.slice(1));
  }
  if (
    args.includes("-p") ||
    args.includes("--prompt") ||
    args.some((arg) => arg.startsWith("--prompt="))
  ) {
    return runSingleShot(args);
  }
  return runTui(args);
}

try {
  const exitCode = await main(Bun.argv.slice(2));
  await stdout.flush();
  await stderr.flush();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} catch (error) {
  writeStderr(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
  await stdout.flush();
  await stderr.flush();
  process.exitCode = 1;
}

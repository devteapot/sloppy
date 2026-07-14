#!/usr/bin/env bun

import { loadScopedConfig } from "../config/load";
import { resolveLaunchScope } from "./launch-scope";
import { SessionService } from "./service";
import { startSessionSupervisor } from "./supervisor";

const stdout = Bun.stdout.writer();

function readOption(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return Bun.argv[index + 1];
}

const socketPath = readOption("--socket");
const sessionId = readOption("--session-id");
const workspaceId = readOption("--workspace-id");
const projectId = readOption("--project-id");
const title = readOption("--title");
const supervisor = Bun.argv.includes("--supervisor");
const managed = Bun.argv.includes("--managed");
const noInitialSession = Bun.argv.includes("--no-initial-session");
const autoCloseEnabled = Bun.argv.includes("--auto-close-enabled");
const idleTimeoutMs = Number(readOption("--idle-timeout-ms") ?? 5000);

if (supervisor) {
  if (!socketPath) {
    throw new Error("--socket is required when --supervisor is set.");
  }
  const running = await startSessionSupervisor({
    socketPath,
    cwd: process.cwd(),
    launchScope: managed ? resolveLaunchScope(process.cwd()) : undefined,
    initial: noInitialSession
      ? false
      : {
          workspaceId,
          projectId,
          title,
          sessionId,
        },
    autoClose: autoCloseEnabled
      ? {
          enabled: true,
          idleTimeoutMs: Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : 5000,
          onClose: () => process.exit(0),
        }
      : undefined,
  });
  stdout.write(
    `[sloppy] session supervisor listening on ${socketPath}${
      running.initialSession ? `; initial session ${running.initialSession.socketPath}` : ""
    }\n`,
  );
  await stdout.flush();

  const shutdown = async () => {
    running.listener.close();
    try {
      await running.supervisor.stopAndWait();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<never>(() => {});
}

const config = await loadScopedConfig({
  workspaceId,
  projectId,
});

const service = new SessionService({
  config,
  sessionId,
  title,
  socketPath,
  configReloader: () =>
    loadScopedConfig({
      workspaceId,
      projectId,
    }),
});

await service.start();
stdout.write(
  `[sloppy] session API listening on ${service.socketPath} (${config.plugins.filesystem.root})\n`,
);
await stdout.flush();

const shutdown = async () => {
  try {
    await service.stopAndWait();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await new Promise<never>(() => {});

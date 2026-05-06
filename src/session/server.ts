#!/usr/bin/env bun

import { loadScopedConfig } from "../config/load";
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
const noRegister = Bun.argv.includes("--no-register");
const supervisor = Bun.argv.includes("--supervisor");

if (supervisor) {
  if (!socketPath) {
    throw new Error("--socket is required when --supervisor is set.");
  }
  const running = await startSessionSupervisor({
    socketPath,
    register: !noRegister,
    initial: {
      workspace_id: workspaceId,
      project_id: projectId,
      title,
      session_id: sessionId,
    },
  });
  stdout.write(
    `[sloppy] session supervisor listening on ${socketPath}; active session ${running.initialSession.socketPath}\n`,
  );
  await stdout.flush();

  const shutdown = () => {
    running.listener.close();
    running.provider.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
});

await service.start({ register: !noRegister });
stdout.write(
  `[sloppy] session provider listening on ${service.socketPath} (${config.providers.filesystem.root})\n`,
);
await stdout.flush();

const shutdown = () => {
  service.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise<never>(() => {});

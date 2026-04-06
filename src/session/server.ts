#!/usr/bin/env bun

import { SessionService } from "./service";

function readOption(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

const socketPath = readOption("--socket");
const sessionId = readOption("--session-id");
const noRegister = process.argv.includes("--no-register");

const service = new SessionService({
  sessionId,
  socketPath,
});

await service.start({ register: !noRegister });
process.stdout.write(`[sloppy] session provider listening on ${service.socketPath}\n`);

const shutdown = () => {
  service.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise<never>(() => {});

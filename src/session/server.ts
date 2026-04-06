#!/usr/bin/env bun

import { SessionService } from "./service";

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
const noRegister = Bun.argv.includes("--no-register");

const service = new SessionService({
  sessionId,
  socketPath,
});

await service.start({ register: !noRegister });
stdout.write(`[sloppy] session provider listening on ${service.socketPath}\n`);
await stdout.flush();

const shutdown = () => {
  service.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise<never>(() => {});

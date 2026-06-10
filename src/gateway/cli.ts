import { existsSync } from "node:fs";

import { resolveLaunchScope, supervisorRuntimePaths } from "../session/launch-scope";
import { startWsGateway, type WsGateway } from "./server";

export type GatewayCliOptions = {
  port: number;
  host?: string;
  token?: string;
  allowedOrigins?: string[];
  publicUrl?: string;
  supervisorPath?: string;
  supervisorSocketPath?: string;
  discovery: boolean;
};

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readRepeatedOption(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer from 0 to 65535, got ${JSON.stringify(raw)}.`);
  }
  return port;
}

function parseAllowedOrigins(args: string[]): string[] | undefined {
  const origins = readRepeatedOption(args, "--allow-origin")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return origins.length > 0 ? origins : undefined;
}

export function parseGatewayOptions(
  args: string[],
  env: Record<string, string | undefined> = Bun.env,
): GatewayCliOptions {
  const port = parsePort(readOption(args, "--port"));
  if (port === undefined) {
    throw new Error("--port is required for sloppy gateway.");
  }

  const tokenEnvName = readOption(args, "--token-env");
  const tokenFromEnv = tokenEnvName ? env[tokenEnvName] : undefined;
  if (tokenEnvName && !tokenFromEnv) {
    throw new Error(`--token-env ${tokenEnvName} did not resolve to a token.`);
  }

  return {
    port,
    host: readOption(args, "--host"),
    token: readOption(args, "--token") ?? tokenFromEnv,
    allowedOrigins: parseAllowedOrigins(args),
    publicUrl: readOption(args, "--public-url"),
    supervisorPath: readOption(args, "--supervisor-path"),
    supervisorSocketPath: readOption(args, "--supervisor-socket"),
    discovery: !args.includes("--no-discovery"),
  };
}

export async function runGateway(args: string[]): Promise<number> {
  const options = parseGatewayOptions(args);
  const supervisorSocketPath =
    options.supervisorSocketPath ??
    supervisorRuntimePaths(resolveLaunchScope(process.cwd())).socketPath;

  const stdout = Bun.stdout.writer();
  if (!existsSync(supervisorSocketPath)) {
    stdout.write(
      `[sloppy] warning: supervisor socket ${supervisorSocketPath} does not exist yet; ` +
        "start `sloppy` or `sloppy session supervisor --socket <path>` first, or pass " +
        "--supervisor-socket. The gateway will keep retrying.\n",
    );
  }

  const gateway: WsGateway = await startWsGateway({
    supervisorSocketPath,
    port: options.port,
    host: options.host,
    supervisorPath: options.supervisorPath,
    publicUrl: options.publicUrl,
    discovery: options.discovery,
    token: options.token,
    allowedOrigins: options.allowedOrigins,
  });
  stdout.write(
    `[sloppy] ws gateway listening on ${gateway.url} (sessions at /sessions/<session-id>) -> unix:${supervisorSocketPath}\n`,
  );
  await stdout.flush();

  const shutdown = () => {
    void gateway.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {});
  return 0;
}

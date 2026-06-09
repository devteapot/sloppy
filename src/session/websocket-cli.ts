import type { WebSocketListenOptions } from "./socket";

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
    throw new Error(`--ws-port must be an integer from 0 to 65535, got ${JSON.stringify(raw)}.`);
  }
  return port;
}

function parseAllowedOrigins(args: string[]): string[] | undefined {
  const origins = readRepeatedOption(args, "--ws-allow-origin")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return origins.length > 0 ? origins : undefined;
}

export function parseWebSocketListenOptions(
  args: string[],
  env: Record<string, string | undefined> = Bun.env,
): WebSocketListenOptions | undefined {
  const port = parsePort(readOption(args, "--ws-port"));
  const hasWebSocketFlag = args.some((arg) => arg.startsWith("--ws-"));
  if (port === undefined) {
    if (hasWebSocketFlag) {
      throw new Error("--ws-port is required when using WebSocket session flags.");
    }
    return undefined;
  }

  const tokenEnvName = readOption(args, "--ws-token-env");
  const tokenFromEnv = tokenEnvName ? env[tokenEnvName] : undefined;
  if (tokenEnvName && !tokenFromEnv) {
    throw new Error(`--ws-token-env ${tokenEnvName} did not resolve to a token.`);
  }

  return {
    host: readOption(args, "--ws-host") ?? "127.0.0.1",
    port,
    path: readOption(args, "--ws-path"),
    token: readOption(args, "--ws-token") ?? tokenFromEnv,
    allowedOrigins: parseAllowedOrigins(args),
    publicUrl: readOption(args, "--ws-public-url"),
  };
}

#!/usr/bin/env bun

import { type CliRenderer, type CliRendererConfig, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";

import { App } from "./app";
import { SessionClient } from "./slop/session-client";

type Args = {
  socket?: string;
  sessionId?: string;
  noManaged?: boolean;
  mouse?: boolean;
};

type ManagedSession = {
  socketPath: string;
  stop: () => void;
};

function readArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--socket") {
      args.socket = argv[index + 1];
      index += 1;
    } else if (value === "--session-id") {
      args.sessionId = argv[index + 1];
      index += 1;
    } else if (value === "--no-managed") {
      args.noManaged = true;
    } else if (value === "--mouse") {
      args.mouse = true;
    } else if (value === "--no-mouse") {
      args.mouse = false;
    } else if (value === "--help" || value === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    }
  }
  return args;
}

function helpText(): string {
  return [
    "Usage: bun run tui [--socket /tmp/slop/session.sock]",
    "",
    "Without --socket, the TUI starts a managed session provider and attaches to it.",
    "Options:",
    "  --socket <path>      Attach to an existing agent-session SLOP provider",
    "  --session-id <id>    Session id for managed mode",
    "  --no-managed         Require --socket instead of starting a provider",
    "  --mouse              Enable terminal mouse reporting at startup",
    "  --no-mouse           Disable terminal mouse reporting at startup (default)",
    "",
  ].join("\n");
}

async function startManagedSession(sessionId?: string): Promise<ManagedSession> {
  const socketPath = `/tmp/slop/sloppy-tui-${process.pid}.sock`;
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/session/server.ts",
      "--socket",
      socketPath,
      ...(sessionId ? ["--session-id", sessionId] : []),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  void drain(proc.stdout);
  void drain(proc.stderr);
  await waitForSocket(socketPath);

  return {
    socketPath,
    stop: () => {
      proc.kill("SIGTERM");
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
  }
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new SessionClient(socketPath);
    try {
      await client.connect();
      client.disconnect();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for session socket: ${socketPath}`);
}

const args = readArgs(Bun.argv.slice(2));

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("sloppy tui requires an interactive TTY.\n");
  process.exit(1);
}

let managed: ManagedSession | null = null;
let socketPath: string;
if (args.socket) {
  socketPath = args.socket;
} else {
  if (args.noManaged) {
    throw new Error("--socket is required when --no-managed is set.");
  }
  managed = await startManagedSession(args.sessionId);
  socketPath = managed.socketPath;
}

const client = new SessionClient(socketPath);
// Kick off the SLOP HELLO + SUBSCRIBE in the background so we render a
// "connecting" shell immediately. Snapshot updates flow through the listener
// once the consumer is wired up.
const initialSnapshot = client.getSnapshot();
const connectPromise = client.connect().catch((error) => {
  process.stderr.write(`[sloppy] tui connect failed: ${error}\n`);
});
let renderer: CliRenderer | null = null;
let shuttingDown = false;
let shutdownCode = 0;

function cleanupSession(): void {
  client.disconnect();
  managed?.stop();
  managed = null;
}

// Surface unhandled rejection from the background connect.
void connectPromise;

function shutdown(code = 0): void {
  if (shuttingDown) {
    process.exit(code);
  }
  shuttingDown = true;
  shutdownCode = code;
  process.exitCode = code;

  if (renderer && !renderer.isDestroyed) {
    renderer.destroy();
    return;
  }

  cleanupSession();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const rendererConfig: CliRendererConfig = {
  exitOnCtrlC: false,
  clearOnShutdown: true,
  screenMode: "alternate-screen",
  externalOutputMode: "passthrough",
  useKittyKeyboard: {},
  // Do not enable terminal mouse reporting by default: it prevents normal
  // terminal text selection/copy in many emulators unless users hold a
  // terminal-specific modifier. Users can opt in with --mouse or toggle in-app.
  useMouse: args.mouse ?? false,
  backgroundColor: "#111319",
  targetFps: 30,
  onDestroy: () => {
    cleanupSession();
    if (shuttingDown) {
      process.exit(shutdownCode);
    }
  },
};

try {
  renderer = await createCliRenderer(rendererConfig);
  await render(
    () => <App client={client} initialSnapshot={initialSnapshot} onExit={() => shutdown(0)} />,
    renderer,
  );
} catch (error) {
  cleanupSession();
  throw error;
}

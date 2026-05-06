#!/usr/bin/env bun

import { type CliRenderer, type CliRendererConfig, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";

import { App } from "./app";
import { unlinkOwnedSocketPath } from "./lib/socket-cleanup";
import { SessionClient } from "./slop/session-client";
import { SessionSupervisorClient } from "./slop/supervisor-client";

type Args = {
  socket?: string;
  supervisorSocket?: string;
  sessionId?: string;
  workspaceId?: string;
  projectId?: string;
  title?: string;
  noManaged?: boolean;
  mouse?: boolean;
};

type ManagedSession = {
  socketPath: string;
  supervisor?: SessionSupervisorClient;
  stop: () => void;
};

function readArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--socket") {
      args.socket = argv[index + 1];
      index += 1;
    } else if (value === "--supervisor-socket") {
      args.supervisorSocket = argv[index + 1];
      index += 1;
    } else if (value === "--session-id") {
      args.sessionId = argv[index + 1];
      index += 1;
    } else if (value === "--workspace-id") {
      args.workspaceId = argv[index + 1];
      index += 1;
    } else if (value === "--project-id") {
      args.projectId = argv[index + 1];
      index += 1;
    } else if (value === "--title") {
      args.title = argv[index + 1];
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
    "Without --socket, the TUI starts a managed session supervisor and attaches to its active session.",
    "Options:",
    "  --socket <path>      Attach to an existing agent-session SLOP provider",
    "  --supervisor-socket <path>",
    "                       Attach through an existing session supervisor",
    "  --session-id <id>    Session id for managed mode",
    "  --workspace-id <id>  Launch managed session with a configured workspace scope",
    "  --project-id <id>    Launch managed session with a configured project scope",
    "  --title <text>       Title for the managed session",
    "  --no-managed         Require --socket instead of starting a provider",
    "  --mouse              Enable terminal mouse reporting at startup",
    "  --no-mouse           Disable terminal mouse reporting at startup (default)",
    "",
  ].join("\n");
}

async function startManagedSession(args: Args): Promise<ManagedSession> {
  const supervisorSocketPath = `/tmp/slop/sloppy-tui-supervisor-${process.pid}.sock`;
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/session/server.ts",
      "--supervisor",
      "--socket",
      supervisorSocketPath,
      ...(args.sessionId ? ["--session-id", args.sessionId] : []),
      ...(args.workspaceId ? ["--workspace-id", args.workspaceId] : []),
      ...(args.projectId ? ["--project-id", args.projectId] : []),
      ...(args.title ? ["--title", args.title] : []),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  void drain(proc.stdout);
  void drain(proc.stderr);
  const supervisor = await connectSupervisor(supervisorSocketPath);
  const socketPath = requireActiveSocket(supervisor.getSnapshot());

  return {
    socketPath,
    supervisor,
    stop: () => {
      const sockets = [
        supervisorSocketPath,
        socketPath,
        ...supervisor.getSnapshot().sessions.map((session) => session.socketPath),
      ];
      supervisor.disconnect();
      proc.kill("SIGTERM");
      for (const socket of sockets) {
        unlinkOwnedSocketPath(socket);
      }
    },
  };
}

async function attachSupervisor(socketPath: string): Promise<ManagedSession> {
  const supervisor = await connectSupervisor(socketPath);
  return {
    socketPath: requireActiveSocket(supervisor.getSnapshot()),
    supervisor,
    stop: () => {
      supervisor.disconnect();
    },
  };
}

async function connectSupervisor(socketPath: string): Promise<SessionSupervisorClient> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const supervisor = new SessionSupervisorClient(socketPath);
    try {
      await supervisor.connect();
      return supervisor;
    } catch (error) {
      supervisor.disconnect();
      lastError = error;
      await Bun.sleep(100);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for supervisor socket: ${socketPath}`);
}

function requireActiveSocket(snapshot: { activeSocketPath?: string }): string {
  if (!snapshot.activeSocketPath) {
    throw new Error("Session supervisor did not expose an active session socket.");
  }
  return snapshot.activeSocketPath;
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

const args = readArgs(Bun.argv.slice(2));

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("sloppy tui requires an interactive TTY.\n");
  process.exit(1);
}

let managed: ManagedSession | null = null;
let socketPath: string;
if (args.socket) {
  socketPath = args.socket;
} else if (args.supervisorSocket) {
  managed = await attachSupervisor(args.supervisorSocket);
  socketPath = managed.socketPath;
} else {
  if (args.noManaged) {
    throw new Error("--socket is required when --no-managed is set.");
  }
  managed = await startManagedSession(args);
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
  managed?.supervisor?.disconnect();
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
  useMouse: args.mouse ?? true,
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
    () => (
      <App
        client={client}
        supervisor={managed?.supervisor}
        initialSnapshot={initialSnapshot}
        initialSupervisorSnapshot={managed?.supervisor?.getSnapshot()}
        onExit={() => shutdown(0)}
      />
    ),
    renderer,
  );
} catch (error) {
  cleanupSession();
  throw error;
}

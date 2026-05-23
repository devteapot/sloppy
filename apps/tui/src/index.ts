import { existsSync, writeFileSync } from "node:fs";

import {
  assertRemovableSocketPath,
  ensureRuntimeRoot,
  resolveLaunchScope,
  supervisorRuntimePaths,
} from "../../../src/session/launch-scope";
import { SessionClient } from "./backend/session-client";
import type { ApprovalMode } from "./backend/slop-types";
import { SessionSupervisorClient, type SupervisorSessionItem } from "./backend/supervisor-client";
import { handleSessionEvent, handleSupervisorEvent } from "./handlers/event-handlers";
import { AppUi } from "./ui/app";

function readArg(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function initialApprovalMode(args: string[]): ApprovalMode | undefined {
  return hasFlag(args, "--yolo") ? "auto" : undefined;
}

function supervisorSocketArg(args: string[]): string | null {
  return readArg(args, "--supervisor") ?? readArg(args, "--supervisor-socket");
}

async function connectSupervisor(socketPath: string): Promise<SessionSupervisorClient> {
  const supervisor = new SessionSupervisorClient(socketPath);
  await supervisor.connect();
  return supervisor;
}

function supervisorCommand(socketPath: string): string[] {
  const script = process.argv[1] ?? "";
  const common = [
    "session",
    "supervisor",
    "--managed",
    "--no-initial-session",
    "--auto-close-enabled",
    "--idle-timeout-ms",
    "5000",
    "--socket",
    socketPath,
    "--no-register",
  ];
  if (import.meta.path.includes("/apps/tui/src/") || import.meta.path.includes("/src/")) {
    return [process.execPath, "run", "src/bin/sloppy.ts", ...common];
  }
  return [process.execPath, script, ...common];
}

async function ensureManagedSupervisor(): Promise<SessionSupervisorClient> {
  const scope = resolveLaunchScope(process.cwd());
  const paths = supervisorRuntimePaths(scope);
  ensureRuntimeRoot(paths.root);
  if (existsSync(paths.socketPath)) {
    try {
      return await connectSupervisor(paths.socketPath);
    } catch {
      assertRemovableSocketPath(paths.socketPath);
    }
  }

  const log = Bun.file(paths.logPath);
  const subprocess = Bun.spawn(supervisorCommand(paths.socketPath), {
    cwd: scope.root,
    detached: true,
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: process.env,
  });
  writeFileSync(
    paths.discoveryPath,
    `${JSON.stringify(
      {
        socket_path: paths.socketPath,
        pid: subprocess.pid,
        log_path: paths.logPath,
        launch_scope_key: scope.key,
        launch_root: scope.root,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await connectSupervisor(paths.socketPath);
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Timed out waiting for supervisor. See ${paths.logPath}`);
}

async function chooseManagedSession(
  supervisor: SessionSupervisorClient,
  args: string[],
): Promise<SupervisorSessionItem> {
  await supervisor.registerClientLease();
  if (hasFlag(args, "--continue")) {
    const resumeSessionId = supervisor.getSnapshot().resumeSessionId;
    if (!resumeSessionId) {
      throw new Error(
        "No previous session in this launch scope. Run `sloppy` to start a new session.",
      );
    }
    return supervisor.switchSession(resumeSessionId);
  }
  return supervisor.createSession({
    workspaceId: readArg(args, "--workspace-id") ?? undefined,
    projectId: readArg(args, "--project-id") ?? undefined,
    title: readArg(args, "--title") ?? undefined,
    sessionId: readArg(args, "--session-id") ?? undefined,
    approvalMode: initialApprovalMode(args),
  });
}

async function initialSessionForExplicitSupervisor(
  supervisor: SessionSupervisorClient,
  args: string[],
): Promise<SupervisorSessionItem> {
  await supervisor.registerClientLease();
  if (hasFlag(args, "--continue")) {
    const resumeSessionId = supervisor.getSnapshot().resumeSessionId;
    if (!resumeSessionId) {
      throw new Error("No previous session in this supervisor.");
    }
    return supervisor.switchSession(resumeSessionId);
  }
  const snapshot = supervisor.getSnapshot();
  const resume =
    snapshot.resumeSessionId &&
    snapshot.sessions.find((session) => session.id === snapshot.resumeSessionId);
  const live = snapshot.sessions.find((session) => session.runtimeStatus === "live");
  const selected = resume ?? live ?? snapshot.sessions[0];
  if (!selected) {
    return supervisor.createSession({ approvalMode: initialApprovalMode(args) });
  }
  return selected.runtimeStatus === "live" ? selected : supervisor.switchSession(selected.id);
}

export async function runTui(args = process.argv.slice(2)): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("sloppy tui requires an interactive TTY.");
    return 1;
  }

  const socketPath = readArg(args, "--socket");
  const supervisorSocketPath = supervisorSocketArg(args);
  let supervisor: SessionSupervisorClient | undefined;
  let initialSocketPath = socketPath ?? undefined;

  if (!initialSocketPath) {
    supervisor = supervisorSocketPath
      ? await connectSupervisor(supervisorSocketPath)
      : await ensureManagedSupervisor();
    const session = supervisorSocketPath
      ? await initialSessionForExplicitSupervisor(supervisor, args)
      : await chooseManagedSession(supervisor, args);
    if (!session.socketPath) {
      throw new Error(`Session ${session.id} did not provide a live socket.`);
    }
    initialSocketPath = session.socketPath;
  }

  const client = new SessionClient(initialSocketPath);
  const app = new AppUi(client, {
    supervisor,
    onSwitchSocket: async (nextSocketPath) => {
      await client.switchSocket(nextSocketPath);
    },
  });

  let leasedSessionId: string | undefined;
  client.on((event) => {
    handleSessionEvent(app, event);
    if (event.type === "snapshot" && supervisor) {
      const sessionId = event.snapshot.session.sessionId ?? undefined;
      if (sessionId !== leasedSessionId) {
        leasedSessionId = sessionId;
        void supervisor.updateClientLease(sessionId);
      }
    }
  });
  supervisor?.on((event) => handleSupervisorEvent(app, event));
  process.on("SIGINT", () => {
    app.stop();
    client.disconnect();
    supervisor?.disconnect();
    process.exit(0);
  });

  await client.connect();
  if (initialApprovalMode(args) === "auto") {
    await client.setApprovalMode("auto");
  }
  app.start();
  return 0;
}

if (import.meta.main) {
  try {
    const exitCode = await runTui();
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

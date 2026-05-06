import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenUnix } from "@slop-ai/server/unix";

import { SessionClient } from "../apps/tui/src/slop/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/slop/supervisor-client";
import { SessionSupervisorProvider, startSessionSupervisor } from "../src/session/supervisor";

const tempPaths: string[] = [];
const listeners: Array<{ close: () => void }> = [];
const providers: SessionSupervisorProvider[] = [];
const originalHome = process.env.HOME;

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

async function writeConfig(root: string, contents: string): Promise<void> {
  const configDir = join(root, ".sloppy");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.yaml"), contents, "utf8");
}

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    listener.close();
  }
  for (const provider of providers.splice(0)) {
    provider.stop();
  }
  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function waitForScopes(client: SessionSupervisorClient): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (client.getSnapshot().scopes.length > 0) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for supervisor scopes.");
}

describe("SessionSupervisorProvider", () => {
  test("creates, switches, and stops scoped sessions through a public SLOP supervisor", async () => {
    const home = await createTempDir("sloppy-supervisor-home-");
    const workspace = await createTempDir("sloppy-supervisor-workspace-");
    const projectRoot = join(workspace, "apps/app");
    await mkdir(projectRoot, { recursive: true });
    await writeConfig(
      home,
      [
        "providers:",
        "  builtin:",
        "    workspaces: true",
        "workspaces:",
        "  activeWorkspaceId: main",
        "  activeProjectId: app",
        "  items:",
        "    main:",
        "      name: Main",
        "      root: .",
        "      configPath: .sloppy/config.yaml",
        "      projects:",
        "        app:",
        "          name: App",
        "          root: apps/app",
        "          configPath: .sloppy/config.yaml",
      ].join("\n"),
    );
    await writeConfig(workspace, "llm:\n  provider: openai\n  model: workspace-model\n");
    await writeConfig(projectRoot, "llm:\n  model: project-model\n");
    process.env.HOME = home;

    const provider = new SessionSupervisorProvider({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    providers.push(provider);
    const supervisorSocket = `/tmp/slop/sloppy-supervisor-test-${crypto.randomUUID()}.sock`;
    listeners.push(listenUnix(provider.server, supervisorSocket, { register: false }));
    const supervisor = new SessionSupervisorClient(supervisorSocket);
    await supervisor.connect();
    await waitForScopes(supervisor);

    expect(supervisor.getSnapshot().scopes.map((scope) => scope.id)).toEqual(["main", "main/app"]);

    const appSession = await supervisor.createSession({
      workspaceId: "main",
      projectId: "app",
      title: "App Session",
      sessionId: "app-session",
    });
    expect(appSession.socketPath).toContain("app-session");
    expect(appSession).toMatchObject({
      turnState: "idle",
      goalStatus: "none",
      goalTotalTokens: 0,
      queuedCount: 0,
      pendingApprovalCount: 0,
      runningTaskCount: 0,
    });
    await expect(supervisor.createSession({ sessionId: "app-session" })).rejects.toThrow(
      "Session already exists",
    );

    const appClient = new SessionClient(appSession.socketPath);
    try {
      const snapshot = await appClient.connect();
      expect(snapshot.session.workspaceId).toBe("main");
      expect(snapshot.session.projectId).toBe("app");
      expect(snapshot.session.workspaceRoot).toBe(projectRoot);
      expect(snapshot.llm.selectedModel).toBe("project-model");
      expect(snapshot.llm.status).toBe("needs_credentials");
    } finally {
      appClient.disconnect();
    }

    const workspaceSession = await supervisor.createSession({
      workspaceId: "main",
      title: "Workspace Session",
      sessionId: "workspace-session",
    });
    expect(supervisor.getSnapshot().activeSessionId).toBe("workspace-session");
    expect(supervisor.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({
        id: "workspace-session",
        turnState: "idle",
        goalStatus: "none",
        queuedCount: 0,
      }),
    );

    const switched = await supervisor.switchSession("app-session");
    expect(switched.id).toBe("app-session");
    expect(supervisor.getSnapshot().activeSessionId).toBe("app-session");

    await supervisor.stopSession("workspace-session");
    expect(supervisor.getSnapshot().sessions.map((session) => session.id)).toEqual(["app-session"]);
    expect(existsSync(workspaceSession.socketPath)).toBe(false);

    const workspaceClient = new SessionClient(workspaceSession.socketPath);
    await expect(workspaceClient.connect()).rejects.toThrow();
    workspaceClient.disconnect();
    supervisor.disconnect();

    provider.stop();
    providers.splice(providers.indexOf(provider), 1);
    expect(existsSync(appSession.socketPath)).toBe(false);
  });

  test("startSessionSupervisor cleans up supervisor and initial session sockets", async () => {
    const home = await createTempDir("sloppy-supervisor-start-home-");
    const workspace = await createTempDir("sloppy-supervisor-start-workspace-");
    await writeConfig(
      home,
      [
        "llm:",
        "  provider: openai",
        "  model: supervisor-cleanup-model",
        "providers:",
        "  builtin:",
        "    terminal: false",
        "    filesystem: false",
        "    memory: false",
        "    skills: false",
      ].join("\n"),
    );
    process.env.HOME = home;

    const supervisorSocket = `/tmp/slop/sloppy-supervisor-start-${crypto.randomUUID()}.sock`;
    const running = await startSessionSupervisor({
      socketPath: supervisorSocket,
      cwd: workspace,
      register: false,
      initial: {
        session_id: "initial-cleanup",
        title: "Initial Cleanup",
      },
    });
    providers.push(running.provider);
    listeners.push(running.listener);

    expect(existsSync(supervisorSocket)).toBe(true);
    expect(existsSync(running.initialSession.socketPath)).toBe(true);

    running.listener.close();
    listeners.splice(listeners.indexOf(running.listener), 1);
    running.provider.stop();
    providers.splice(providers.indexOf(running.provider), 1);

    expect(existsSync(supervisorSocket)).toBe(false);
    expect(existsSync(running.initialSession.socketPath)).toBe(false);
  });
});

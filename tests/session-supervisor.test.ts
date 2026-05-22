import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenUnix } from "@slop-ai/server/unix";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";
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
        "plugins:",
        "  workspaces:",
        "    enabled: true",
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
      goalTotalTokens: 0,
      queuedCount: 0,
      pendingApprovalCount: 0,
      runningTaskCount: 0,
    });
    expect(appSession.goalStatus).toBeUndefined();
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
    expect(supervisor.getSnapshot().resumeSessionId).toBe("workspace-session");
    expect(supervisor.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({
        id: "workspace-session",
        turnState: "idle",
        goalStatus: undefined,
        queuedCount: 0,
      }),
    );

    const switched = await supervisor.switchSession("app-session");
    expect(switched.id).toBe("app-session");
    expect(supervisor.getSnapshot().resumeSessionId).toBe("app-session");

    await supervisor.stopSession("workspace-session");
    expect(supervisor.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({
        id: "workspace-session",
        runtimeStatus: "dormant",
      }),
    );
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
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
        "  memory:",
        "    enabled: false",
        "  skills:",
        "    enabled: false",
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
    expect(existsSync(running.initialSession!.socketPath)).toBe(true);

    running.listener.close();
    listeners.splice(listeners.indexOf(running.listener), 1);
    running.provider.stop();
    providers.splice(providers.indexOf(running.provider), 1);

    expect(existsSync(supervisorSocket)).toBe(false);
    expect(existsSync(running.initialSession!.socketPath)).toBe(false);
  });

  test("restores stopped sessions lazily from the launch-scope registry", async () => {
    const home = await createTempDir("sloppy-supervisor-registry-home-");
    const workspace = await createTempDir("sloppy-supervisor-registry-workspace-");
    await writeConfig(
      home,
      [
        "llm:",
        "  provider: openai",
        "  model: registry-model",
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;
    const launchScope = { key: "registry-scope", root: workspace };
    const firstSocket = `/tmp/slop/sloppy-supervisor-registry-a-${crypto.randomUUID()}.sock`;
    const first = await startSessionSupervisor({
      socketPath: firstSocket,
      cwd: workspace,
      launchScope,
      register: false,
      initial: false,
    });
    providers.push(first.provider);
    listeners.push(first.listener);

    const firstClient = new SessionSupervisorClient(firstSocket);
    await firstClient.connect();
    const created = await firstClient.createSession({
      sessionId: "restore-session",
      title: "Restore Session",
    });
    expect(created.runtimeStatus).toBe("live");
    await firstClient.unregisterClientLease();
    await firstClient.stopSession("restore-session");
    expect(firstClient.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({ id: "restore-session", runtimeStatus: "dormant" }),
    );
    firstClient.disconnect();
    first.listener.close();
    listeners.splice(listeners.indexOf(first.listener), 1);
    first.provider.stop();
    providers.splice(providers.indexOf(first.provider), 1);

    const secondSocket = `/tmp/slop/sloppy-supervisor-registry-b-${crypto.randomUUID()}.sock`;
    const second = await startSessionSupervisor({
      socketPath: secondSocket,
      cwd: workspace,
      launchScope,
      register: false,
      initial: false,
    });
    providers.push(second.provider);
    listeners.push(second.listener);
    const secondClient = new SessionSupervisorClient(secondSocket);
    await secondClient.connect();
    expect(secondClient.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({ id: "restore-session", runtimeStatus: "dormant" }),
    );
    const restored = await secondClient.switchSession("restore-session");
    expect(restored.runtimeStatus).toBe("live");
    const sessionClient = new SessionClient(restored.socketPath);
    try {
      const snapshot = await sessionClient.connect();
      expect(snapshot.session.sessionId).toBe("restore-session");
    } finally {
      sessionClient.disconnect();
      secondClient.disconnect();
    }
  });

  test("connection-bound leases guard stopping sessions selected by another client", async () => {
    const home = await createTempDir("sloppy-supervisor-lease-home-");
    const workspace = await createTempDir("sloppy-supervisor-lease-workspace-");
    await writeConfig(
      home,
      [
        "llm:",
        "  provider: openai",
        "  model: lease-model",
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;
    const socketPath = `/tmp/slop/sloppy-supervisor-lease-${crypto.randomUUID()}.sock`;
    const running = await startSessionSupervisor({
      socketPath,
      cwd: workspace,
      launchScope: { key: "lease-scope", root: workspace },
      register: false,
      initial: false,
    });
    providers.push(running.provider);
    listeners.push(running.listener);
    const first = new SessionSupervisorClient(socketPath);
    const second = new SessionSupervisorClient(socketPath);
    await first.connect();
    await second.connect();
    await first.registerClientLease();
    await second.registerClientLease();

    const a = await first.createSession({ sessionId: "session-a" });
    await first.createSession({ sessionId: "session-b" });
    await second.updateClientLease(a.id);
    await expect(first.stopSession(a.id)).rejects.toThrow("selected by 1 other clients");

    second.disconnect();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (first.getSnapshot().clientLeaseCount === 1) {
        break;
      }
      await Bun.sleep(10);
    }
    await first.stopSession(a.id);
    expect(first.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({ id: a.id, runtimeStatus: "dormant" }),
    );
    first.disconnect();
  });

  test("auto-close stops an idle managed supervisor after leases disconnect", async () => {
    const home = await createTempDir("sloppy-supervisor-autoclose-home-");
    const workspace = await createTempDir("sloppy-supervisor-autoclose-workspace-");
    await writeConfig(
      home,
      [
        "llm:",
        "  provider: openai",
        "  model: autoclose-model",
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;
    const socketPath = `/tmp/slop/sloppy-supervisor-autoclose-${crypto.randomUUID()}.sock`;
    const running = await startSessionSupervisor({
      socketPath,
      cwd: workspace,
      launchScope: { key: "autoclose-scope", root: workspace },
      register: false,
      initial: false,
      autoClose: { enabled: true, idleTimeoutMs: 30 },
    });
    providers.push(running.provider);
    listeners.push(running.listener);
    expect(existsSync(socketPath)).toBe(true);
    await Bun.sleep(120);
    expect(existsSync(socketPath)).toBe(false);
    providers.splice(providers.indexOf(running.provider), 1);
    listeners.splice(listeners.indexOf(running.listener), 1);
  });
});

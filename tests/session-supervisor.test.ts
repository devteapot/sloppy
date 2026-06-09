import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenUnix } from "@slop-ai/server/unix";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";
import { SessionSupervisorProvider, startSessionSupervisor } from "../src/session/supervisor";
import { listenSessionSupervisor } from "../src/session/supervisor-listener";

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

function llmProfileConfigLines(model: string, id = "test-openai"): string[] {
  return [
    "llm:",
    `  defaultProfileId: ${id}`,
    "  profiles:",
    `    - id: ${id}`,
    "      endpointId: openai",
    `      model: ${model}`,
  ];
}

function llmProfileOverrideLines(model: string, id = "test-openai"): string[] {
  return [
    "llm:",
    "  profiles:",
    `    - id: ${id}`,
    "      endpointId: openai",
    `      model: ${model}`,
  ];
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
    await writeConfig(
      workspace,
      [
        "llm:",
        "  defaultProfileId: scoped-openai",
        "  profiles:",
        "    - id: scoped-openai",
        "      endpointId: openai",
        "      model: workspace-model",
      ].join("\n"),
    );
    await writeConfig(
      projectRoot,
      [
        "llm:",
        "  profiles:",
        "    - id: scoped-openai",
        "      endpointId: openai",
        "      model: project-model",
      ].join("\n"),
    );
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
      approvalMode: "auto",
    });
    expect(appSession.socketPath).toContain("app-session");
    expect(appSession).toMatchObject({
      turnState: "idle",
      goalTotalTokens: 0,
      queuedCount: 0,
      pendingApprovalCount: 0,
      runningTaskCount: 0,
      approvalMode: "auto",
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
      expect(snapshot.approvalMode).toBe("auto");
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
        approvalMode: "auto",
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
        approvalMode: "auto",
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

  test("client disconnect releases its lease and unblocks auto-close", async () => {
    const home = await createTempDir("sloppy-supervisor-lease-home-");
    const workspace = await createTempDir("sloppy-supervisor-lease-ws-");
    await writeConfig(workspace, llmProfileConfigLines("lease-model").join("\n"));
    process.env.HOME = home;

    const provider = new SessionSupervisorProvider({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    providers.push(provider);
    const socketPath = `/tmp/slop/sloppy-supervisor-lease-${crypto.randomUUID()}.sock`;
    listeners.push(listenSessionSupervisor(provider, socketPath, { register: false }));

    const client = new SessionSupervisorClient(socketPath);
    await client.connect();
    await client.registerClientLease();
    expect(provider.canAutoClose()).toBe(false);

    client.disconnect();
    for (let attempt = 0; attempt < 40 && !provider.canAutoClose(); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(provider.canAutoClose()).toBe(true);
  });

  test("startSessionSupervisor cleans up supervisor and initial session sockets", async () => {
    const home = await createTempDir("sloppy-supervisor-start-home-");
    const workspace = await createTempDir("sloppy-supervisor-start-workspace-");
    await writeConfig(
      home,
      [
        ...llmProfileConfigLines("supervisor-cleanup-model"),
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
        approval_mode: "auto",
      },
    });
    providers.push(running.provider);
    listeners.push(running.listener);

    expect(existsSync(supervisorSocket)).toBe(true);
    expect(existsSync(running.initialSession!.socketPath)).toBe(true);
    const initialClient = new SessionClient(running.initialSession!.socketPath);
    try {
      const snapshot = await initialClient.connect();
      expect(snapshot.approvalMode).toBe("auto");
    } finally {
      initialClient.disconnect();
    }

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
        ...llmProfileConfigLines("registry-model"),
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
      approvalMode: "auto",
    });
    expect(created.runtimeStatus).toBe("live");
    await firstClient.unregisterClientLease();
    await firstClient.stopSession("restore-session");
    expect(firstClient.getSnapshot().sessions).toContainEqual(
      expect.objectContaining({
        id: "restore-session",
        runtimeStatus: "dormant",
        approvalMode: "auto",
      }),
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
      expect(snapshot.approvalMode).toBe("auto");
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
        ...llmProfileConfigLines("lease-model"),
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

  test("new sessions inherit approval mode from the selected session", async () => {
    const home = await createTempDir("sloppy-supervisor-approval-home-");
    const workspace = await createTempDir("sloppy-supervisor-approval-workspace-");
    await writeConfig(
      home,
      [
        ...llmProfileConfigLines("approval-model"),
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;
    const socketPath = `/tmp/slop/sloppy-supervisor-approval-${crypto.randomUUID()}.sock`;
    const running = await startSessionSupervisor({
      socketPath,
      cwd: workspace,
      launchScope: { key: "approval-scope", root: workspace },
      register: false,
      initial: false,
    });
    providers.push(running.provider);
    listeners.push(running.listener);

    const supervisor = new SessionSupervisorClient(socketPath);
    await supervisor.connect();
    await supervisor.registerClientLease();
    await supervisor.createSession({
      sessionId: "approval-source",
      approvalMode: "auto",
    });
    const inherited = await supervisor.createSession({ sessionId: "approval-inherited" });

    const session = new SessionClient(inherited.socketPath);
    try {
      const snapshot = await session.connect();
      expect(snapshot.approvalMode).toBe("auto");
    } finally {
      session.disconnect();
      supervisor.disconnect();
    }
  });

  test("scope item session creation inherits approval mode from the selected session", async () => {
    const home = await createTempDir("sloppy-supervisor-scope-approval-home-");
    const workspace = await createTempDir("sloppy-supervisor-scope-approval-workspace-");
    const projectRoot = join(workspace, "apps/app");
    await mkdir(projectRoot, { recursive: true });
    await writeConfig(
      home,
      [
        "plugins:",
        "  workspaces:",
        "    enabled: true",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
        "workspaces:",
        "  activeWorkspaceId: main",
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
    await writeConfig(workspace, llmProfileConfigLines("scope-workspace-model").join("\n"));
    await writeConfig(projectRoot, llmProfileOverrideLines("scope-project-model").join("\n"));
    process.env.HOME = home;
    const socketPath = `/tmp/slop/sloppy-supervisor-scope-approval-${crypto.randomUUID()}.sock`;
    const running = await startSessionSupervisor({
      socketPath,
      cwd: workspace,
      launchScope: { key: "scope-approval", root: workspace },
      register: false,
      initial: false,
    });
    providers.push(running.provider);
    listeners.push(running.listener);

    const supervisor = new SessionSupervisorClient(socketPath);
    await supervisor.connect();
    await waitForScopes(supervisor);
    await supervisor.registerClientLease();
    await supervisor.createSession({
      sessionId: "scope-approval-source",
      approvalMode: "auto",
    });
    const inherited = await supervisor.createSessionInScope("main/app", {
      sessionId: "scope-approval-inherited",
    });

    const session = new SessionClient(inherited.socketPath);
    try {
      const snapshot = await session.connect();
      expect(snapshot.session.workspaceId).toBe("main");
      expect(snapshot.session.projectId).toBe("app");
      expect(snapshot.approvalMode).toBe("auto");
    } finally {
      session.disconnect();
      supervisor.disconnect();
    }
  });

  test("supervisor reload_config refreshes configured scopes", async () => {
    const home = await createTempDir("sloppy-supervisor-reload-home-");
    const workspace = await createTempDir("sloppy-supervisor-reload-workspace-");
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
        "  items:",
        "    main:",
        "      name: Main",
        "      root: .",
        "      configPath: .sloppy/config.yaml",
      ].join("\n"),
    );
    await writeConfig(workspace, llmProfileConfigLines("reload-model").join("\n"));
    await writeConfig(projectRoot, llmProfileOverrideLines("reload-project-model").join("\n"));
    process.env.HOME = home;
    const socketPath = `/tmp/slop/sloppy-supervisor-reload-${crypto.randomUUID()}.sock`;
    const running = await startSessionSupervisor({
      socketPath,
      cwd: workspace,
      register: false,
      initial: false,
    });
    providers.push(running.provider);
    listeners.push(running.listener);

    const supervisor = new SessionSupervisorClient(socketPath);
    await supervisor.connect();
    await waitForScopes(supervisor);
    expect(supervisor.getSnapshot().scopes.map((scope) => scope.id)).toEqual(["main"]);

    await writeConfig(
      home,
      [
        "plugins:",
        "  workspaces:",
        "    enabled: true",
        "workspaces:",
        "  activeWorkspaceId: main",
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

    const result = await supervisor.reloadConfig();
    expect(result.status).toBe("ok");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        supervisor
          .getSnapshot()
          .scopes.map((scope) => scope.id)
          .includes("main/app")
      ) {
        break;
      }
      await Bun.sleep(25);
    }
    expect(supervisor.getSnapshot().scopes.map((scope) => scope.id)).toEqual(["main", "main/app"]);
    supervisor.disconnect();
  });

  test("auto-close stops an idle managed supervisor after leases disconnect", async () => {
    const home = await createTempDir("sloppy-supervisor-autoclose-home-");
    const workspace = await createTempDir("sloppy-supervisor-autoclose-workspace-");
    await writeConfig(
      home,
      [
        ...llmProfileConfigLines("autoclose-model"),
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

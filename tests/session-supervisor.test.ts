import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";
import type { LlmProfileManager } from "../src/llm/profile-manager";
import type { LlmAdapter } from "../src/llm/types";
import { listenSupervisorClientProtocol } from "../src/session/client-protocol";
import { SessionSupervisor, startSessionSupervisor } from "../src/session/supervisor";
import { createDeferred } from "./helpers/agent-session-provider-harness";

const tempPaths: string[] = [];
const listeners: Array<{ close: () => void }> = [];
const supervisors: SessionSupervisor[] = [];
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
  for (const supervisor of supervisors.splice(0)) {
    supervisor.stop();
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

describe("SessionSupervisor", () => {
  test("creates, switches, and stops scoped sessions through the typed supervisor", async () => {
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

    const provider = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(provider);
    const supervisorSocket = `/tmp/slop/sloppy-supervisor-test-${crypto.randomUUID()}.sock`;
    listeners.push(listenSupervisorClientProtocol(provider, supervisorSocket));
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
    supervisors.splice(supervisors.indexOf(provider), 1);
    expect(existsSync(appSession.socketPath)).toBe(false);
  });

  test("client disconnect releases its lease and unblocks auto-close", async () => {
    const home = await createTempDir("sloppy-supervisor-lease-home-");
    const workspace = await createTempDir("sloppy-supervisor-lease-ws-");
    await writeConfig(workspace, llmProfileConfigLines("lease-model").join("\n"));
    process.env.HOME = home;

    const provider = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(provider);
    const socketPath = `/tmp/slop/sloppy-supervisor-lease-${crypto.randomUUID()}.sock`;
    listeners.push(listenSupervisorClientProtocol(provider, socketPath));

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

  test("shares LLM profile bindings across supervised Sessions", async () => {
    const home = await createTempDir("sloppy-supervisor-profile-lease-home-");
    const workspace = await createTempDir("sloppy-supervisor-profile-lease-ws-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  defaultProfileId: shared-target",
        "  profiles:",
        "    - id: shared-target",
        "      endpointId: openai",
        "      model: target-model",
        "    - id: operator-profile",
        "      endpointId: openai",
        "      model: operator-model",
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;

    const supervisor = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(supervisor);
    const target = await supervisor.createSession({ sessionId: "profile-lease-target" });
    const operator = await supervisor.createSession({ sessionId: "profile-lease-operator" });
    if (!target.service || !operator.service) {
      throw new Error("Expected live supervised Session services.");
    }

    await operator.service.runtime.setDefaultLlmProfile("operator-profile");
    await expect(operator.service.runtime.deleteLlmProfile("shared-target")).rejects.toThrow(
      "live session is bound to it",
    );

    await supervisor.stopSession("profile-lease-target");
    await expect(operator.service.runtime.deleteLlmProfile("shared-target")).resolves.toMatchObject(
      { status: "ok", profileId: "shared-target" },
    );
  });

  test("waits for active profile teardown and preserves queued input before marking dormant", async () => {
    const home = await createTempDir("sloppy-supervisor-stop-active-home-");
    const workspace = await createTempDir("sloppy-supervisor-stop-active-ws-");
    await writeConfig(
      home,
      [
        "llm:",
        "  endpoints:",
        "    local-test:",
        "      protocol: openai-chat",
        "      baseUrl: https://example.invalid/v1",
        "      auth:",
        "        type: none",
        "      models:",
        "        target-model: {}",
        "        operator-model: {}",
        "  defaultProfileId: stop-target",
        "  profiles:",
        "    - id: stop-target",
        "      endpointId: local-test",
        "      model: target-model",
        "    - id: stop-operator",
        "      endpointId: local-test",
        "      model: operator-model",
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;

    const supervisor = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(supervisor);
    const target = await supervisor.createSession({ sessionId: "stop-active-target" });
    const operator = await supervisor.createSession({ sessionId: "stop-active-operator" });
    if (!target.service || !operator.service) {
      throw new Error("Expected live supervised Session services.");
    }

    const targetRuntime = target.service.runtime;
    const manager = (targetRuntime as unknown as { llmProfileManager: LlmProfileManager })
      .llmProfileManager;
    const chatStarted = createDeferred<void>();
    const finishChat = createDeferred<void>();
    manager.createAdapter = async () =>
      ({
        async chat(options) {
          chatStarted.resolve();
          await finishChat.promise;
          const text = "completed during stop";
          options.onText?.(text);
          return {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }) satisfies LlmAdapter;

    await operator.service.runtime.setDefaultLlmProfile("stop-operator");
    await targetRuntime.sendMessage("running message");
    await chatStarted.promise;
    await targetRuntime.sendMessage("queued message");

    let stopSettled = false;
    const stopping = supervisor.stopSession("stop-active-target").finally(() => {
      stopSettled = true;
    });
    await Bun.sleep(0);

    expect(stopSettled).toBe(false);
    expect(
      (await supervisor.getClientSnapshot()).sessions.find(
        (session) => session.sessionId === "stop-active-target",
      )?.runtimeStatus,
    ).toBe("stopping");
    await expect(supervisor.selectSession("stop-active-target")).rejects.toThrow(
      "is stopping and cannot be selected",
    );
    await expect(operator.service.runtime.deleteLlmProfile("stop-target")).rejects.toThrow(
      "live session is bound to it",
    );

    finishChat.resolve();
    await stopping;

    const stoppedSnapshot = targetRuntime.store.getSnapshot();
    expect(stoppedSnapshot.session.status).toBe("closed");
    expect(stoppedSnapshot.queue.map((message) => message.text)).toEqual(["queued message"]);
    expect(stoppedSnapshot.transcript.map((message) => message.role)).toEqual(["user"]);
    expect(
      (await supervisor.getClientSnapshot()).sessions.find(
        (session) => session.sessionId === "stop-active-target",
      )?.runtimeStatus,
    ).toBe("dormant");
    await expect(operator.service.runtime.deleteLlmProfile("stop-target")).resolves.toMatchObject({
      status: "ok",
    });
  });

  test("marks a Session dormant even when asynchronous service cleanup fails", async () => {
    const home = await createTempDir("sloppy-supervisor-stop-error-home-");
    const workspace = await createTempDir("sloppy-supervisor-stop-error-ws-");
    await writeConfig(workspace, llmProfileConfigLines("stop-error-model").join("\n"));
    process.env.HOME = home;

    const supervisor = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(supervisor);
    const record = await supervisor.createSession({ sessionId: "stop-error" });
    if (!record.service) throw new Error("Expected a live Session service.");
    const socketPath = record.socketPath;
    const originalWaitForStopCompletion = record.service.waitForStopCompletion.bind(record.service);
    record.service.waitForStopCompletion = async () => {
      await originalWaitForStopCompletion();
      throw new Error("injected asynchronous cleanup failure");
    };

    await expect(supervisor.stopSession(record.sessionId)).rejects.toThrow(
      "injected asynchronous cleanup failure",
    );

    expect(record.runtimeStatus).toBe("dormant");
    expect(record.service).toBeUndefined();
    expect(existsSync(socketPath)).toBe(false);
    expect(
      (await supervisor.getClientSnapshot()).sessions.find(
        (session) => session.sessionId === record.sessionId,
      )?.runtimeStatus,
    ).toBe("dormant");
  });

  test("continues synchronous Supervisor cleanup after one Session fails to stop", async () => {
    const home = await createTempDir("sloppy-supervisor-stop-all-error-home-");
    const workspace = await createTempDir("sloppy-supervisor-stop-all-error-ws-");
    await writeConfig(workspace, llmProfileConfigLines("stop-all-error-model").join("\n"));
    process.env.HOME = home;

    const supervisor = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(supervisor);
    const first = await supervisor.createSession({ sessionId: "stop-all-first" });
    const second = await supervisor.createSession({ sessionId: "stop-all-second" });
    if (!first.service || !second.service) {
      throw new Error("Expected live Session services.");
    }
    const firstSocket = first.socketPath;
    const secondSocket = second.socketPath;
    const originalFirstStop = first.service.stop.bind(first.service);
    first.service.stop = () => {
      originalFirstStop();
      throw new Error("injected synchronous cleanup failure");
    };

    expect(() => supervisor.stop()).toThrow("injected synchronous cleanup failure");

    expect(existsSync(firstSocket)).toBe(false);
    expect(existsSync(secondSocket)).toBe(false);
    expect((await supervisor.getClientSnapshot()).sessions).toEqual([]);
  });

  test("keeps deferred synchronous Supervisor shutdown visible until completion", async () => {
    const home = await createTempDir("sloppy-supervisor-sync-stop-active-home-");
    const workspace = await createTempDir("sloppy-supervisor-sync-stop-active-ws-");
    await writeConfig(
      home,
      [
        "llm:",
        "  endpoints:",
        "    local-test:",
        "      protocol: openai-chat",
        "      baseUrl: https://example.invalid/v1",
        "      auth:",
        "        type: none",
        "      models:",
        "        target-model: {}",
        "  defaultProfileId: stop-target",
        "  profiles:",
        "    - id: stop-target",
        "      endpointId: local-test",
        "      model: target-model",
        "plugins:",
        "  terminal:",
        "    enabled: false",
        "  filesystem:",
        "    enabled: false",
      ].join("\n"),
    );
    process.env.HOME = home;
    const supervisor = new SessionSupervisor({
      cwd: workspace,
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
    });
    supervisors.push(supervisor);
    const record = await supervisor.createSession({ sessionId: "sync-stop-active" });
    if (!record.service) throw new Error("Expected a live Session service.");
    const service = record.service;
    const runtime = service.runtime;
    const manager = (runtime as unknown as { llmProfileManager: LlmProfileManager })
      .llmProfileManager;
    const chatStarted = createDeferred<void>();
    const finishChat = createDeferred<void>();
    manager.createAdapter = async () =>
      ({
        async chat() {
          chatStarted.resolve();
          await finishChat.promise;
          return {
            content: [{ type: "text", text: "finished" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }) satisfies LlmAdapter;

    await runtime.sendMessage("stay visible while stopping");
    await chatStarted.promise;
    supervisor.stop();

    let shutdownSettled = false;
    const shutdownCompletion = supervisor.waitForShutdown().finally(() => {
      shutdownSettled = true;
    });
    await Bun.sleep(0);
    expect(shutdownSettled).toBe(false);
    expect(service.isStopping()).toBe(true);
    expect((await supervisor.getClientSnapshot()).sessions).toEqual([
      expect.objectContaining({ sessionId: "sync-stop-active", runtimeStatus: "stopping" }),
    ]);

    finishChat.resolve();
    await shutdownCompletion;
    expect(service.isStopped()).toBe(true);
    expect((await supervisor.getClientSnapshot()).sessions).toEqual([]);
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
      initial: {
        sessionId: "initial-cleanup",
        title: "Initial Cleanup",
        approvalMode: "auto",
      },
    });
    supervisors.push(running.supervisor);
    listeners.push(running.listener);

    expect(existsSync(supervisorSocket)).toBe(true);
    expect(existsSync(`${supervisorSocket}.client`)).toBe(false);
    expect(existsSync(running.initialSession!.socketPath)).toBe(true);
    expect(existsSync(`${running.initialSession!.socketPath}.client`)).toBe(false);
    const initialClient = new SessionClient(running.initialSession!.socketPath);
    try {
      const snapshot = await initialClient.connect();
      expect(snapshot.approvalMode).toBe("auto");
    } finally {
      initialClient.disconnect();
    }

    running.listener.close();
    listeners.splice(listeners.indexOf(running.listener), 1);
    running.supervisor.stop();
    supervisors.splice(supervisors.indexOf(running.supervisor), 1);

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
      initial: false,
    });
    supervisors.push(first.supervisor);
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
    first.supervisor.stop();
    supervisors.splice(supervisors.indexOf(first.supervisor), 1);

    const secondSocket = `/tmp/slop/sloppy-supervisor-registry-b-${crypto.randomUUID()}.sock`;
    const second = await startSessionSupervisor({
      socketPath: secondSocket,
      cwd: workspace,
      launchScope,
      initial: false,
    });
    supervisors.push(second.supervisor);
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
      initial: false,
    });
    supervisors.push(running.supervisor);
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
      initial: false,
    });
    supervisors.push(running.supervisor);
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
      initial: false,
    });
    supervisors.push(running.supervisor);
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
      initial: false,
    });
    supervisors.push(running.supervisor);
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
      initial: false,
      autoClose: { enabled: true, idleTimeoutMs: 30 },
    });
    supervisors.push(running.supervisor);
    listeners.push(running.listener);
    expect(existsSync(socketPath)).toBe(true);
    await Bun.sleep(120);
    expect(existsSync(socketPath)).toBe(false);
    supervisors.splice(supervisors.indexOf(running.supervisor), 1);
    listeners.splice(listeners.indexOf(running.listener), 1);
  });
});

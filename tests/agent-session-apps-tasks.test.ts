import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlopNode } from "@slop-ai/consumer/browser";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { InProcessTransport } from "../src/providers/in-process";
import { AgentSessionProvider } from "../src/session/provider";
import type { SessionAgent, SessionAgentFactory } from "../src/session/runtime";
import { SessionRuntime } from "../src/session/runtime";
import {
  createAppMirrorHarnessFactory,
  createGatedApprovalHarnessFactory,
  createTaskMirrorHarnessFactory,
  createTestProfileManager,
  TEST_CONFIG,
} from "./helpers/agent-session-provider-harness";

describe("AgentSessionProvider — apps and tasks", () => {
  test("session mirrors provider tasks after accepted tool results", async () => {
    const harness = createTaskMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-tasks",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-tasks",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "run tests in background",
      });
      harness.emitTaskSnapshot();

      const tasks = await consumer.query("/tasks", 3);
      expect(tasks.children?.length).toBe(1);
      expect(tasks.children?.[0]?.properties?.provider_task_id).toBe("task-123");
      expect(tasks.children?.[0]?.properties?.status).toBe("running");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session exposes external apps and clears mirrored state when one disconnects", async () => {
    const harness = createAppMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-apps",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-apps",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApps([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/native-demo.sock",
          status: "connected",
        },
      ]);
      harness.emitTaskSnapshot("native-demo");

      const apps = await consumer.query("/apps", 3);
      expect(apps.children?.length).toBe(1);
      expect(apps.children?.[0]?.id).toBe("native-demo");
      expect(apps.children?.[0]?.properties?.status).toBe("connected");
      expect(apps.children?.[0]?.properties?.transport).toBe("unix:/tmp/native-demo.sock");

      const tasks = await consumer.query("/tasks", 3);
      expect(tasks.children?.length).toBe(1);

      harness.emitApps([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/native-demo.sock",
          status: "disconnected",
          lastError: "Provider disconnected.",
        },
      ]);

      const appsAfterDisconnect = await consumer.query("/apps", 3);
      expect(appsAfterDisconnect.children?.[0]?.properties?.status).toBe("disconnected");
      expect(appsAfterDisconnect.children?.[0]?.properties?.last_error).toBe(
        "Provider disconnected.",
      );

      const tasksAfterDisconnect = await consumer.query("/tasks", 3);
      expect(tasksAfterDisconnect.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session apps surface loads for disconnected external providers", async () => {
    const harness = createAppMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-app-retry",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-app-retry",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApps([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/native-demo.sock",
          status: "error",
          lastError: "Connection refused.",
        },
      ]);

      const apps = await consumer.query("/apps", 2);
      expect(
        apps.affordances?.some((affordance) => affordance.action === "reconnect_provider"),
      ).toBe(false);
      expect(
        ["load_provider", "unload_provider", "reload_provider"].every((actionName) =>
          apps.affordances?.some((affordance) => affordance.action === actionName),
        ),
      ).toBe(true);

      const load = await consumer.invoke("/apps", "load_provider", {
        provider_id: "native-demo",
      });
      expect(load.status).toBe("ok");
      expect(load.data).toEqual({
        provider_id: "native-demo",
        status: "connected",
        was_connected: false,
      });
      expect(harness.loads).toEqual(["native-demo"]);

      const appsAfterLoad = await consumer.query("/apps", 2);
      expect(appsAfterLoad.children?.[0]?.properties?.status).toBe("connected");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session apps can unload and reload external providers", async () => {
    const harness = createAppMirrorHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-app-unload",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-app-unload",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApps([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/native-demo.sock",
          status: "connected",
        },
      ]);

      const unload = await consumer.invoke("/apps", "unload_provider", {
        provider_id: "native-demo",
      });
      expect(unload.status).toBe("ok");
      expect(unload.data).toEqual({
        provider_id: "native-demo",
        status: "unloaded",
        was_connected: true,
      });
      expect(harness.unloads).toEqual(["native-demo"]);

      const appsAfterUnload = await consumer.query("/apps", 2);
      expect(appsAfterUnload.children?.[0]?.properties?.status).toBe("unloaded");

      const load = await consumer.invoke("/apps", "load_provider", {
        provider_id: "native-demo",
      });
      expect(load.status).toBe("ok");
      expect(load.data).toEqual({
        provider_id: "native-demo",
        status: "connected",
        was_connected: false,
      });
      expect(harness.loads).toEqual(["native-demo"]);

      const appsAfterLoad = await consumer.query("/apps", 2);
      expect(appsAfterLoad.children?.[0]?.properties?.status).toBe("connected");

      const reload = await consumer.invoke("/apps", "reload_provider", {
        provider_id: "native-demo",
      });
      expect(reload.status).toBe("ok");
      expect(reload.data).toEqual({
        provider_id: "native-demo",
        status: "connected",
      });
      expect(harness.reloads).toEqual(["native-demo"]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session apps surface proxies first-party plugin provider state queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-meta-proxy-"));
    const config: SloppyConfig = {
      ...TEST_CONFIG,
      plugins: {
        ...TEST_CONFIG.plugins,
        "meta-runtime": {
          ...TEST_CONFIG.plugins["meta-runtime"],
          enabled: true,
          globalRoot: join(root, "global"),
          workspaceRoot: join(root, "workspace"),
        },
      },
    };
    const runtime = new SessionRuntime({
      config,
      sessionId: "sess-meta-proxy",
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-meta-proxy",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const plugins = await consumer.query("/plugins", 2);
      const metaPlugin = plugins.children?.find((item) => item.id === "meta-runtime");
      expect(metaPlugin?.properties?.ui).toBeUndefined();

      const apps = await consumer.query("/apps", 1);
      expect(apps.affordances?.some((affordance) => affordance.action === "query_provider")).toBe(
        true,
      );

      const result = await consumer.invoke("/apps", "query_provider", {
        provider_id: "meta-runtime",
        path: "/proposals",
        depth: 1,
      });

      expect(result.status).toBe("ok");
      expect((result.data as { id?: string }).id).toBe("proposals");
    } finally {
      provider.stop();
      runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session app provider queries preserve provider-owned metadata", async () => {
    const queried: Array<{ providerId: string; path: string }> = [];
    const node: SlopNode = {
      id: "root",
      type: "root",
      properties: { label: "Debuggable Provider" },
      meta: { summary: "Root summary", salience: 1, focus: true },
      children: [
        {
          id: "child",
          type: "item",
          properties: { value: 1 },
          meta: { summary: "Child summary", salience: 0.4 },
        },
      ],
    };
    const factory: SessionAgentFactory = (): SessionAgent => ({
      start: async () => undefined,
      chat: async () => ({ status: "completed", response: "ok" }),
      resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
      invokeProvider: async () => ({ type: "result", id: "inv-debug", status: "ok" }),
      queryProvider: async (providerId, path) => {
        queried.push({ providerId, path });
        return node;
      },
      resolveApprovalDirect: async () => ({ type: "result", id: "inv-debug", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-app-query-sanitize",
      agentFactory: factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-app-query-sanitize",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();

      const result = await consumer.invoke("/apps", "query_provider", {
        provider_id: "debug-provider",
        path: "/",
      });
      expect(result.status).toBe("ok");
      expect((result.data as SlopNode).meta).toMatchObject({
        summary: "Root summary",
        salience: 1,
        focus: true,
      });
      expect((result.data as SlopNode).children?.[0]?.meta).toMatchObject({
        summary: "Child summary",
        salience: 0.4,
      });

      expect(queried).toEqual([{ providerId: "debug-provider", path: "/" }]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("approveApproval waits for the suspended turn to unwind before resuming", async () => {
    // Regression: the `approval_requested` tool event fires synchronously
    // inside agent.chat(); a fast approver could call approveApproval()
    // before chat() resolved, leaving activeRunAbortController set when
    // resumeTurn started — surfacing as "Agent is already executing a model
    // turn." The fix awaits activeTurnPromise (only when this approval is
    // what the current turn is blocked on) before resolving the hub
    // approval and starting the resume.
    const harness = createGatedApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-fast-approve",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });

    try {
      await runtime.start();
      await runtime.sendMessage("rm demo.txt");

      // chat() has fired the approval_requested event (so pendingApproval
      // is set) but is parked on the gate — agent.chat() has NOT unwound
      // yet, mirroring the race window.
      harness.emitApprovalSnapshot();
      const snapshot = runtime.store.getSnapshot();
      const pending = snapshot.approvals.find((item) => item.status === "pending");
      expect(pending).toBeDefined();
      const approvalId = pending?.id ?? "";

      // Kick off approveApproval. It should block on activeTurnPromise
      // rather than synchronously calling resolveApprovalDirect.
      const approvePromise = runtime.approveApproval(approvalId);

      // Yield a few microtasks; the gate is still closed, so the hub
      // approval must NOT have been resolved yet.
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.approveCalls).toEqual([]);

      // Release chat() — it returns waiting_approval, the runTurn promise
      // unwinds, then approveApproval proceeds.
      harness.releaseChat();

      const result = await approvePromise;
      expect(result.status).toBe("ok");
      expect(harness.approveCalls).toEqual(["approval-gated"]);

      await harness.resumeStarted;
      await runtime.waitForIdle();

      expect(harness.resumeCalls).toHaveLength(1);
      expect(harness.resumeCalls[0]?.status).toBe("ok");
    } finally {
      runtime.shutdown();
    }
  });
});

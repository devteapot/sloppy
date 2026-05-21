import { afterEach, describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import {
  applyPathSnapshot,
  EMPTY_SESSION_VIEW,
  mapApprovalsNode,
  mapAppsNode,
  mapQueueNode,
  mapTasksNode,
  mapTranscriptNode,
} from "../apps/tui/src/backend/node-mappers";
import { SessionClient } from "../apps/tui/src/backend/session-client";
import { buildCommandPaletteCommands } from "../apps/tui/src/state/command-palette";
import { projectIndicators, projectPluginActions } from "../apps/tui/src/state/manifest-projection";
import {
  evaluatePluginNotifications,
  readPluginNotificationValue,
} from "../apps/tui/src/state/plugin-notifications";
import { buildSlashEntries, matchSlashEntries } from "../apps/tui/src/state/slash-catalog";
import { assembleTranscript } from "../apps/tui/src/state/stream-assembler";
import { routeOverlayText } from "../apps/tui/src/ui/route-overlay";
import { StatusLine } from "../apps/tui/src/ui/status-line";

const listeners: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    listener.close();
  }
});

function registerMinimalSessionNodes(
  server: ReturnType<typeof createSlopServer>,
  options: { includeGoal?: boolean } = {},
): void {
  server.register("session", { type: "context", props: { session_id: "sess-minimal" } });
  server.register("llm", { type: "collection", props: { status: "ready" }, items: [] });
  server.register("usage", { type: "context", props: {} });
  server.register("turn", { type: "status", props: { state: "idle" } });
  if (options.includeGoal) {
    server.register("goal", { type: "control", props: { exists: false, status: "none" } });
  }
  server.register("composer", { type: "control", props: { ready: true } });
  server.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
  server.register("activity", { type: "collection", props: { count: 0 }, items: [] });
  server.register("approvals", { type: "collection", props: { count: 0 }, items: [] });
  server.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
  server.register("apps", { type: "collection", props: { count: 0 }, items: [] });
  server.register("queue", { type: "collection", props: { count: 0 }, items: [] });
}

describe("TUI v2 manifest mapping", () => {
  test("maps plugin UI manifests into actions, notifications, indicators, and slash entries", () => {
    const next = applyPathSnapshot(EMPTY_SESSION_VIEW, "/plugins", {
      id: "plugins",
      type: "collection",
      properties: {
        count: 1,
        ui_manifest_version: 2,
      },
      children: [
        {
          id: "persistent-goal",
          type: "item",
          properties: {
            id: "persistent-goal",
            version: "1.0.0",
            status: "active",
            description: "Persistent long-running session objective controls.",
            session_paths: ["/goal"],
            ui: {
              subscriptions: [{ path: "/goal", depth: 1 }],
              actions: [
                {
                  id: "goal:create",
                  label: "Create Goal",
                  description: "Create a persistent session goal",
                  invoke: { path: "/goal", action: "create_goal" },
                  whenAvailable: "create_goal",
                  argument: { name: "objective", required: true, param: "objective" },
                  presentation: {
                    tui: {
                      slash: {
                        name: "goal",
                        signature: "<objective>|pause|resume|complete|clear",
                      },
                    },
                  },
                },
              ],
              notifications: [
                {
                  id: "goal-complete",
                  source: { path: "/goal", prop: "status" },
                  to: "complete",
                  message: "Goal complete: {objective}",
                },
              ],
              indicators: [
                {
                  id: "goal-status",
                  path: "/goal",
                  template: "goal {status}",
                },
              ],
            },
          },
        },
      ],
    });

    expect(next.plugins[0]?.id).toBe("persistent-goal");
    expect(next.plugins[0]?.sessionPaths).toEqual(["/goal"]);
    expect(next.plugins[0]?.ui.subscriptions?.[0]).toEqual({ path: "/goal", depth: 1 });
    expect(next.plugins[0]?.ui.actions?.[0]).toMatchObject({
      id: "goal:create",
      invoke: { path: "/goal", action: "create_goal" },
      whenAvailable: "create_goal",
    });
    expect(next.plugins[0]?.ui.notifications?.[0]).toEqual({
      id: "goal-complete",
      source: { path: "/goal", prop: "status" },
      to: "complete",
      message: "Goal complete: {objective}",
    });
    expect(next.plugins[0]?.ui.indicators?.[0]?.template).toBe("goal {status}");

    expect(buildSlashEntries().some((entry) => entry.name === "goal")).toBe(false);
    expect(buildSlashEntries(next.plugins).some((entry) => entry.name === "goal")).toBe(true);
    expect(buildSlashEntries(next.plugins).some((entry) => entry.name === "runtime")).toBe(true);
    expect(matchSlashEntries("/go", 8, next.plugins)[0]?.entry.name).toBe("goal");
  });

  test("projects plugin actions, indicators, and command palette entries from live state", () => {
    const withPlugins = applyPathSnapshot(EMPTY_SESSION_VIEW, "/plugins", {
      id: "plugins",
      type: "collection",
      properties: { count: 1, ui_manifest_version: 2 },
      children: [
        {
          id: "persistent-goal",
          type: "item",
          properties: {
            id: "persistent-goal",
            version: "1.0.0",
            status: "active",
            ui: {
              subscriptions: [{ path: "/goal", depth: 1 }],
              actions: [
                {
                  id: "goal:pause",
                  label: "Pause Goal",
                  description: "Pause automatic goal continuation",
                  invoke: { path: "/goal", action: "pause_goal" },
                  whenAvailable: "pause_goal",
                },
              ],
              indicators: [
                {
                  id: "goal-status",
                  path: "/goal",
                  template: "goal {status} {total_tokens}",
                  fields: { total_tokens: { format: "number" } },
                  visibleWhen: { prop: "exists", equals: true },
                },
              ],
            },
          },
        },
      ],
    });
    const withGoal = applyPathSnapshot(withPlugins, "/goal", {
      id: "goal",
      type: "control",
      properties: { exists: true, status: "active", total_tokens: 1200 },
      affordances: [{ action: "pause_goal" }],
    });

    expect(projectPluginActions(withGoal)).toMatchObject([
      {
        pluginId: "persistent-goal",
        available: true,
        action: { id: "goal:pause" },
      },
    ]);
    expect(projectIndicators(withGoal)).toMatchObject([
      {
        pluginId: "persistent-goal",
        text: "goal active 1,200",
      },
    ]);
    expect(
      buildCommandPaletteCommands(withGoal).some((item) => item.id.includes("goal:pause")),
    ).toBe(true);
    const statusLine = new StatusLine();
    statusLine.update(withGoal, "default");
    expect(statusLine.render(120).join("\n")).toContain("goal active 1,200");
    expect(routeOverlayText("help", withGoal, null)).toContain("/help");
  });

  test("evaluates plugin manifest notifications against session snapshots", () => {
    const pending = {
      ...EMPTY_SESSION_VIEW,
      goal: {
        ...EMPTY_SESSION_VIEW.goal,
        exists: true,
        status: "active",
      },
      plugins: [
        {
          id: "persistent-goal",
          version: "1.0.0",
          status: "active",
          sessionPaths: ["/goal"],
          ui: {
            notifications: [
              {
                id: "goal-complete",
                source: { path: "/goal", prop: "status" },
                to: "complete",
                message: "Goal complete: {objective}",
              },
            ],
          },
        },
      ],
    };
    const previousValues = new Map<string, string | undefined>();

    expect(readPluginNotificationValue(pending, "/goal", "status")).toBe("active");
    expect(evaluatePluginNotifications(pending, previousValues)).toEqual([]);

    const complete = {
      ...pending,
      goal: {
        ...pending.goal,
        status: "complete",
      },
    };
    expect(evaluatePluginNotifications(complete, previousValues)).toMatchObject([
      {
        key: "persistent-goal:goal-complete",
        message: "Goal complete: {objective}",
      },
    ]);
  });
});

describe("TUI transcript assembly", () => {
  test("maps mixed transcript content to renderable messages", () => {
    const transcript = mapTranscriptNode({
      id: "transcript",
      type: "collection",
      children: [
        {
          id: "msg-1",
          type: "item",
          properties: { role: "assistant", state: "streaming", turn_id: "turn-1" },
          children: [
            {
              id: "content",
              type: "group",
              children: [
                {
                  id: "block-1",
                  type: "document",
                  properties: { mime: "text/plain", text: "hello" },
                },
                {
                  id: "block-2",
                  type: "media",
                  properties: { mime: "image/png", preview: "screenshot preview" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(assembleTranscript(transcript)).toEqual([
      {
        id: "msg-1",
        seq: 0,
        role: "assistant",
        state: "streaming",
        text: "hello\nscreenshot preview",
      },
    ]);
  });
});

describe("TUI node mappers", () => {
  test("maps approvals with affordance availability", () => {
    const approvals = mapApprovalsNode({
      id: "approvals",
      type: "collection",
      children: [
        {
          id: "approval-1",
          type: "item",
          properties: {
            status: "pending",
            provider: "terminal",
            path: "/session",
            action: "run",
            reason: "destructive command",
            params_preview: "rm -rf build",
            dangerous: true,
            created_at: "2026-05-21T10:00:00Z",
          },
          affordances: [{ action: "approve" }, { action: "reject" }],
        },
      ],
    });

    expect(approvals).toEqual([
      {
        id: "approval-1",
        status: "pending",
        provider: "terminal",
        path: "/session",
        action: "run",
        reason: "destructive command",
        paramsPreview: "rm -rf build",
        dangerous: true,
        canApprove: true,
        canReject: true,
        createdAt: "2026-05-21T10:00:00Z",
        resolvedAt: undefined,
      },
    ]);
  });

  test("maps task progress and cancellation affordance", () => {
    const tasks = mapTasksNode({
      id: "tasks",
      type: "collection",
      children: [
        {
          id: "task-1",
          type: "item",
          properties: {
            status: "running",
            provider: "filesystem",
            provider_task_id: "provider-task-1",
            message: "Indexing",
            progress: 0.4,
            linked_activity_id: "activity-1",
            updated_at: "2026-05-21T10:01:00Z",
          },
          affordances: [{ action: "cancel" }],
        },
      ],
    });

    expect(tasks[0]).toMatchObject({
      id: "task-1",
      status: "running",
      provider: "filesystem",
      providerTaskId: "provider-task-1",
      message: "Indexing",
      progress: 0.4,
      linkedActivityId: "activity-1",
      canCancel: true,
      updatedAt: "2026-05-21T10:01:00Z",
    });
  });

  test("maps queue items with stable position and cancellation affordance", () => {
    const queue = mapQueueNode({
      id: "queue",
      type: "collection",
      children: [
        {
          id: "msg-1",
          type: "item",
          properties: {
            text: "queued prompt",
            status: "queued",
            position: 3,
            summary: "queued prompt",
            author: "user",
          },
          affordances: [{ action: "cancel" }],
        },
      ],
    });

    expect(queue).toEqual([
      {
        id: "msg-1",
        text: "queued prompt",
        status: "queued",
        position: 3,
        summary: "queued prompt",
        author: "user",
        createdAt: undefined,
        canCancel: true,
      },
    ]);
  });

  test("maps connected app/provider attachment state", () => {
    const apps = mapAppsNode({
      id: "apps",
      type: "collection",
      children: [
        {
          id: "native-demo",
          type: "item",
          properties: {
            provider_id: "native-demo",
            name: "Native Demo",
            transport: "unix:/tmp/native-demo.sock",
            status: "connected",
            last_error: "previous retry failed",
          },
        },
      ],
    });

    expect(apps).toEqual([
      {
        id: "native-demo",
        providerId: "native-demo",
        name: "Native Demo",
        transport: "unix:/tmp/native-demo.sock",
        status: "connected",
        lastError: "previous retry failed",
      },
    ]);
  });
});

describe("SessionClient", () => {
  test("connects when plugin-owned goal path is absent", async () => {
    const socketPath = `/tmp/slop/tui-no-goal-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server);
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();

      expect(snapshot.connection.status).toBe("connected");
      expect(snapshot.goal.exists).toBe(false);
      expect(snapshot.plugins).toEqual([]);
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("subscribes to active plugin manifest paths for action gating", async () => {
    const socketPath = `/tmp/slop/tui-plugin-subscriptions-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server);
    server.register("plugins", {
      type: "collection",
      props: { count: 1, ui_manifest_version: 2 },
      items: [
        {
          id: "custom-plugin",
          props: {
            id: "custom-plugin",
            version: "1.0.0",
            status: "active",
            ui: {
              subscriptions: [{ path: "/custom", depth: 1 }],
              actions: [
                {
                  id: "custom:run",
                  label: "Run Custom Action",
                  description: "Invoke a plugin-owned custom affordance",
                  invoke: { path: "/custom", action: "do_it" },
                  whenAvailable: "do_it",
                },
              ],
            },
          },
        },
      ],
    });
    server.register("custom", {
      type: "control",
      props: { ready: true },
      actions: {
        do_it: action({}, async () => ({ ok: true }), { label: "Do It" }),
      },
    });
    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();

      expect(snapshot.actionsByPath["/custom"]).toEqual(["do_it"]);
      expect(snapshot.plugins[0]?.ui.actions?.[0]).toMatchObject({
        id: "custom:run",
        invoke: { path: "/custom", action: "do_it" },
      });
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("subscribes to the public session provider shape and invokes composer affordances", async () => {
    const socketPath = `/tmp/slop/tui-client-test-${crypto.randomUUID()}.sock`;
    const sentMessages: string[] = [];
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server, { includeGoal: true });
    server.register("composer", {
      type: "control",
      props: { ready: true, accepts_attachments: false, max_attachments: 0 },
      actions: {
        send_message: action(
          { text: "string" },
          async ({ text }) => {
            sentMessages.push(text);
            return { turnId: "turn-1" };
          },
          { label: "Send Message" },
        ),
      },
    });

    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();
      expect(snapshot.connection.status).toBe("connected");
      expect(snapshot.composer.canSend).toBe(true);

      const result = await client.sendMessage("hello from tui");
      expect(result.status).toBe("ok");
      expect(sentMessages).toEqual(["hello from tui"]);
    } finally {
      client.disconnect();
      server.stop();
    }
  });
});

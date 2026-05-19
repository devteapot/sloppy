import { afterEach, describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import {
  applyPathSnapshot,
  EMPTY_SESSION_VIEW,
  mapComposerNode,
  mapLlmNode,
  mapQueueNode,
  mapSessionNode,
  mapTranscriptNode,
  mapUsageNode,
} from "../apps/tui/src/slop/node-mappers";
import { SessionClient } from "../apps/tui/src/slop/session-client";
import type { TuiRoute } from "../apps/tui/src/slop/types";
import { buildCommandPaletteCommands } from "../apps/tui/src/state/command-palette";
import { parseLocalCommand } from "../apps/tui/src/state/commands";
import { ComposerHistory } from "../apps/tui/src/state/composer-history";
import { reconcileInitialRoute } from "../apps/tui/src/state/initial-route";
import {
  evaluatePluginNotifications,
  readPluginNotificationValue,
} from "../apps/tui/src/state/plugin-notifications";
import { buildSlashEntries, matchSlashEntries } from "../apps/tui/src/state/slash-catalog";

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

describe("TUI node mappers", () => {
  test("maps transcript content and affordance availability from SLOP nodes", () => {
    const transcript = mapTranscriptNode({
      id: "transcript",
      type: "collection",
      children: [
        {
          id: "msg-1",
          type: "item",
          properties: {
            role: "assistant",
            state: "streaming",
            turn_id: "turn-1",
            author: "agent",
          },
          children: [
            {
              id: "content",
              type: "group",
              children: [
                {
                  id: "block-1",
                  type: "document",
                  properties: {
                    mime: "text/plain",
                    text: "hello",
                  },
                },
                {
                  id: "block-2",
                  type: "media",
                  properties: {
                    mime: "image/png",
                    name: "screenshot.png",
                    preview: "terminal preview",
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(transcript).toEqual([
      {
        id: "msg-1",
        role: "assistant",
        state: "streaming",
        turnId: "turn-1",
        author: "agent",
        createdAt: undefined,
        error: undefined,
        blocks: [
          {
            id: "block-1",
            type: "text",
            mime: "text/plain",
            text: "hello",
          },
          {
            id: "block-2",
            type: "media",
            mime: "image/png",
            name: "screenshot.png",
            uri: undefined,
            summary: undefined,
            preview: "terminal preview",
          },
        ],
      },
    ]);
  });

  test("maps composer insertion events", () => {
    const composer = mapComposerNode({
      id: "composer",
      type: "control",
      properties: {
        ready: true,
        accepts_attachments: false,
        max_attachments: 0,
        insertion_id: "insert-1",
        insertion_text: "dictated text",
        insertion_source: "voice",
        insertion_created_at: "2026-05-14T20:00:00.000Z",
      },
      affordances: [
        {
          action: "send_message",
          label: "Send Message",
        },
      ],
    });

    expect(composer).toMatchObject({
      ready: true,
      canSend: true,
      insertionId: "insert-1",
      insertionText: "dictated text",
      insertionSource: "voice",
      insertionCreatedAt: "2026-05-14T20:00:00.000Z",
    });
  });

  test("applies path snapshots without disturbing unrelated state", () => {
    const next = applyPathSnapshot(EMPTY_SESSION_VIEW, "/turn", {
      id: "turn",
      type: "status",
      properties: {
        turn_id: "turn-1",
        state: "running",
        phase: "model",
        iteration: 1,
        message: "Calling model",
        waiting_on: "model",
      },
      affordances: [{ action: "cancel_turn" }],
    });

    expect(next.turn.state).toBe("running");
    expect(next.turn.canCancel).toBe(true);
    expect(next.actionsByPath["/turn"]).toEqual(["cancel_turn"]);
    expect(next.transcript).toEqual([]);
  });

  test("maps plugin manifests into slash command discovery", () => {
    const next = applyPathSnapshot(EMPTY_SESSION_VIEW, "/plugins", {
      id: "plugins",
      type: "collection",
      properties: {
        count: 1,
        ui_manifest_version: 1,
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
            tui: {
              subscriptions: [{ path: "/goal", depth: 1 }],
              commands: [
                {
                  id: "goal",
                  name: "goal",
                  signature: "<objective>|pause|resume|complete|clear",
                  description: "Persistent session goal controls",
                },
              ],
              palette: [
                {
                  id: "goal:pause",
                  label: "Pause Goal",
                  description: "Pause automatic goal continuation",
                  path: "/goal",
                  action: "pause_goal",
                  whenActionAvailable: "pause_goal",
                },
              ],
              notifications: [
                {
                  id: "goal-complete",
                  path: "/goal",
                  prop: "status",
                  to: "complete",
                  message: "Goal complete.",
                },
              ],
            },
          },
        },
      ],
    });

    expect(next.plugins[0]?.id).toBe("persistent-goal");
    expect(next.plugins[0]?.sessionPaths).toEqual(["/goal"]);
    expect(next.plugins[0]?.tui.subscriptions?.[0]).toEqual({ path: "/goal", depth: 1 });
    expect(next.plugins[0]?.tui.palette?.[0]).toEqual({
      id: "goal:pause",
      label: "Pause Goal",
      description: "Pause automatic goal continuation",
      path: "/goal",
      action: "pause_goal",
      params: undefined,
      shortcut: undefined,
      whenActionAvailable: "pause_goal",
    });
    expect(next.plugins[0]?.tui.notifications?.[0]).toEqual({
      id: "goal-complete",
      path: "/goal",
      prop: "status",
      to: "complete",
      message: "Goal complete.",
    });

    expect(buildSlashEntries().some((entry) => entry.name === "goal")).toBe(false);
    expect(buildSlashEntries(next.plugins).some((entry) => entry.name === "goal")).toBe(true);
    expect(matchSlashEntries("/go", 8, next.plugins)[0]?.entry.name).toBe("goal");
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
          tui: {
            notifications: [
              {
                id: "goal-complete",
                path: "/goal",
                prop: "status",
                to: "complete",
                message: "Goal complete.",
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
        message: "Goal complete.",
      },
    ]);
  });

  test("maps workspace and project scope from session state", () => {
    const session = mapSessionNode({
      id: "session",
      type: "context",
      properties: {
        session_id: "sess-scope",
        status: "active",
        workspace_root: "/work/main/apps/app",
        workspace_id: "main",
        project_id: "app",
      },
    });

    expect(session.workspaceRoot).toBe("/work/main/apps/app");
    expect(session.workspaceId).toBe("main");
    expect(session.projectId).toBe("app");
  });

  test("maps ACP adapter ids from LLM profile state", () => {
    const llm = mapLlmNode({
      id: "llm",
      type: "collection",
      properties: {
        status: "ready",
        message: "Ready",
      },
      children: [
        {
          id: "claude-acp",
          type: "item",
          properties: {
            provider: "acp",
            model: "sonnet",
            adapter_id: "claude",
            origin: "managed",
            is_default: true,
            has_key: false,
            key_source: "not_required",
            ready: true,
            managed: true,
          },
        },
      ],
    });

    expect(llm.profiles[0]?.adapterId).toBe("claude");
    expect(llm.profiles[0]?.keySource).toBe("not_required");
  });

  test("maps session-owned usage state distinctly from LLM profiles", () => {
    const usage = mapUsageNode({
      id: "usage",
      type: "context",
      properties: {
        last_turn_id: "turn-1",
        last_model_call_input_tokens: 42,
        last_model_call_input_source: "reported",
        last_model_call_output_source: "unavailable",
        current_turn_input_tokens: 50,
        current_turn_model_calls: 2,
        total_input_tokens: 100,
        last_state_context_tokens: 1200,
        last_state_context_token_source: "provider",
        model_context_window_tokens: 123456,
      },
    });

    expect(usage.lastTurnId).toBe("turn-1");
    expect(usage.lastModelCallInputTokens).toBe(42);
    expect(usage.lastModelCallOutputTokens).toBeUndefined();
    expect(usage.lastModelCallOutputSource).toBe("unavailable");
    expect(usage.currentTurnModelCalls).toBe(2);
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.lastStateContextTokens).toBe(1200);
    expect(usage.lastStateContextTokenSource).toBe("provider");
    expect(usage.modelContextWindowTokens).toBe(123456);
  });
});

describe("TUI local state", () => {
  test("label() emits hair-spaced uppercase blueprint text", async () => {
    const { label } = await import("../apps/tui/src/lib/theme");
    const HAIR = " ";
    expect(label("inspect")).toBe(`I${HAIR}N${HAIR}S${HAIR}P${HAIR}E${HAIR}C${HAIR}T`);
  });

  test("composer history walks back, edits, and resets on push", () => {
    const history = new ComposerHistory(3);
    expect(history.previous()).toBeNull();
    history.push("alpha");
    history.push("beta");
    history.push("beta"); // duplicate of last entry → ignored
    history.push("gamma");
    expect(history.size).toBe(3);
    expect(history.previous()).toBe("gamma");
    expect(history.previous()).toBe("beta");
    expect(history.previous()).toBe("alpha");
    expect(history.previous()).toBe("alpha");
    expect(history.next()).toBe("beta");
    expect(history.next()).toBe("gamma");
    expect(history.next()).toBe("");
    expect(history.next()).toBeNull();
  });

  test("composer history is bounded by capacity", () => {
    const history = new ComposerHistory(2);
    history.push("a");
    history.push("b");
    history.push("c");
    expect(history.list()).toEqual(["b", "c"]);
  });

  test("command palette commands include routes and live session actions", () => {
    const snapshot = {
      ...EMPTY_SESSION_VIEW,
      goal: {
        ...EMPTY_SESSION_VIEW.goal,
        exists: true,
        status: "active" as const,
        canPause: true,
        canComplete: true,
        canClear: true,
      },
      actionsByPath: {
        "/goal": ["pause_goal", "complete_goal", "clear_goal"],
      },
      plugins: [
        {
          id: "persistent-goal",
          version: "1.0.0",
          status: "active",
          sessionPaths: ["/goal"],
          tui: {
            palette: [
              {
                id: "goal:pause",
                label: "Pause Goal",
                description: "Pause automatic goal continuation",
                path: "/goal",
                action: "pause_goal",
                whenActionAvailable: "pause_goal",
              },
              {
                id: "goal:resume",
                label: "Resume Goal",
                description: "Resume automatic goal continuation",
                path: "/goal",
                action: "resume_goal",
                whenActionAvailable: "resume_goal",
              },
            ],
          },
        },
      ],
      queue: [
        {
          id: "msg-1",
          text: "queued text",
          status: "queued",
          position: 1,
          summary: "queued text",
          canCancel: true,
        },
      ],
      apps: [
        {
          id: "filesystem",
          name: "Filesystem",
          transport: "in-process",
          status: "connected",
        },
      ],
    };

    const commands = buildCommandPaletteCommands(snapshot, true, {
      connection: {
        status: "connected",
        socketPath: "/tmp/supervisor.sock",
      },
      activeSessionId: "sess-1",
      activeSocketPath: "/tmp/session-1.sock",
      sessions: [
        {
          id: "sess-1",
          title: "Runtime",
          socketPath: "/tmp/session-1.sock",
          turnState: "idle",
          goalStatus: "none",
          goalTotalTokens: 0,
          queuedCount: 0,
          pendingApprovalCount: 0,
          runningTaskCount: 0,
          selected: true,
          canSwitch: true,
          canStop: true,
        },
        {
          id: "sess-2",
          title: "Docs",
          socketPath: "/tmp/session-2.sock",
          turnState: "running",
          goalStatus: "active",
          goalObjective: "Ship docs",
          goalTotalTokens: 120,
          queuedCount: 1,
          pendingApprovalCount: 0,
          runningTaskCount: 1,
          selected: false,
          canSwitch: true,
          canStop: true,
        },
      ],
      scopes: [
        {
          id: "main/app",
          name: "App",
          root: "/work/apps/app",
          workspaceId: "main",
          projectId: "app",
          canCreate: true,
        },
      ],
    });
    const byId = new Map(commands.map((command) => [command.id, command]));

    expect(byId.get("route:apps")?.command).toEqual({
      type: "route",
      route: "apps",
    });
    expect(byId.get("mouse:toggle")?.command).toEqual({ type: "mouse", mode: "off" });
    expect(byId.get("plugin:persistent-goal:goal:pause")?.command).toEqual({
      type: "plugin_action",
      pluginId: "persistent-goal",
      actionId: "goal:pause",
      label: "Pause Goal",
      path: "/goal",
      action: "pause_goal",
      params: undefined,
    });
    expect(byId.has("plugin:persistent-goal:goal:resume")).toBe(false);
    expect(byId.get("queue:msg-1")?.command).toEqual({
      type: "queue_cancel",
      target: "msg-1",
    });
    expect(byId.get("app:filesystem:inspect")?.command).toEqual({
      type: "query",
      path: "/",
      depth: 2,
      targetId: "filesystem",
    });
    expect(byId.get("session:new:main/app")?.command).toEqual({
      type: "session_new",
      workspaceId: "main",
      projectId: "app",
      title: "App",
    });
    expect(byId.get("session:switch:sess-2")?.command).toEqual({
      type: "session_switch",
      sessionId: "sess-2",
    });
    expect(byId.get("inspect:open")?.command).toEqual({ type: "inspect_open" });
  });

  test("local command parser recognizes routes, query, invoke, and secret profile setup", () => {
    expect(parseLocalCommand("/apps")).toEqual({ type: "route", route: "apps" });
    expect(parseLocalCommand("/runtime")).toEqual({ type: "route", route: "runtime" });
    expect(parseLocalCommand("/runtime refresh")).toEqual({
      type: "runtime",
      action: "refresh",
    });
    expect(parseLocalCommand("/runtime inspect proposal-1")).toEqual({
      type: "runtime",
      action: "inspect",
      proposalId: "proposal-1",
    });
    expect(parseLocalCommand("/runtime apply proposal-1")).toEqual({
      type: "runtime",
      action: "apply",
      proposalId: "proposal-1",
    });
    expect(parseLocalCommand("/runtime export")).toEqual({
      type: "runtime",
      action: "export",
    });
    expect(parseLocalCommand("/inspect")).toEqual({ type: "inspect_open" });
    expect(parseLocalCommand("/session-new --workspace-id main --project-id app")).toEqual({
      type: "session_new",
      workspaceId: "main",
      projectId: "app",
      title: undefined,
      sessionId: undefined,
    });
    expect(parseLocalCommand("/session-switch sess-2")).toEqual({
      type: "session_switch",
      sessionId: "sess-2",
    });
    expect(parseLocalCommand("/query /llm 3")).toEqual({
      type: "query",
      path: "/llm",
      depth: 3,
      targetId: "session",
    });
    expect(
      parseLocalCommand("/query native-demo:/workspace 2 --window 0:10 --max-nodes 25"),
    ).toEqual({
      type: "query",
      path: "/workspace",
      depth: 2,
      targetId: "native-demo",
      window: [0, 10],
      maxNodes: 25,
    });
    expect(parseLocalCommand('/invoke /composer send_message {"text":"hi"}')).toEqual({
      type: "invoke",
      path: "/composer",
      action: "send_message",
      params: { text: "hi" },
      targetId: "session",
    });
    expect(parseLocalCommand("/profile-secret acp sonnet --adapter claude --no-default")).toEqual({
      type: "profile_secret",
      profileId: undefined,
      label: undefined,
      provider: "acp",
      model: "sonnet",
      reasoningEffort: undefined,
      adapterId: "claude",
      baseUrl: undefined,
      makeDefault: false,
    });

    expect(parseLocalCommand("/profile openai gpt-5.4 --reasoning-effort high")).toEqual({
      type: "profile",
      profileId: undefined,
      label: undefined,
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
      adapterId: undefined,
      baseUrl: undefined,
      makeDefault: true,
    });
  });

  test("local command parser rejects /profile with --api-key (security)", () => {
    const result = parseLocalCommand(
      "/profile openai gpt-5.4 --reasoning-effort high --api-key sk-test12345",
    );
    expect(result?.type).toBe("rejected");
    if (result?.type === "rejected") {
      expect(result.reason).toMatch(/profile-secret/);
    }

    const trailing = parseLocalCommand("/profile openai gpt-5.4 https://example sk-testabcdef");
    expect(trailing?.type).toBe("rejected");
  });

  test("local command parser rejects every /profile inline-secret shape", () => {
    const cases = [
      "/profile openai gpt-5.4 sk-test12345",
      "/profile openai sk-test12345",
      "/profile openai gpt-5.4 --api-key=sk-test12345",
      "/profile openai gpt-5.4 --apiKey=sk-test12345",
      "/profile openai gpt-5.4 --api_key sk-test12345",
      "/profile openai gpt-5.4 --key sk-test12345",
      "/profile openai gpt-5.4 --token ghp_abcdefghijklmnopqr",
      "/profile openai gpt-5.4 --base-url https://example --secret xoxb-12345abcdef",
      "/profile openai gpt-5.4 ghp_abcdefghijklmnopqr",
      "/profile openai gpt-5.4 github_pat_abcdefghijklmnopqrstu",
    ];
    for (const input of cases) {
      const result = parseLocalCommand(input);
      expect(result?.type, `expected rejected for: ${input}`).toBe("rejected");
    }
  });

  test("local command parser still saves clean /profile invocations", () => {
    expect(
      parseLocalCommand("/profile openai gpt-5.4 https://api.openai.com --reasoning-effort high"),
    ).toEqual({
      type: "profile",
      profileId: undefined,
      label: undefined,
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
      adapterId: undefined,
      baseUrl: "https://api.openai.com",
      makeDefault: true,
    });
  });

  test("unknown slashes parse as `unknown` so the dispatcher can fall through to send_message", () => {
    expect(parseLocalCommand("/notarealcommand hello")).toEqual({
      type: "unknown",
      name: "/notarealcommand hello",
    });
    expect(parseLocalCommand("/skill foo arg")).toEqual({
      type: "unknown",
      name: "/skill foo arg",
    });
  });

  test("local command parser parses /queue-cancel by id and position", () => {
    expect(parseLocalCommand("/queue-cancel 3")).toEqual({ type: "queue_cancel", target: 3 });
    expect(parseLocalCommand("/queue-cancel msg-abc")).toEqual({
      type: "queue_cancel",
      target: "msg-abc",
    });
    expect(parseLocalCommand("/queue-cancel")).toEqual({ type: "unknown", name: "/queue-cancel" });
  });

  test("local command parser parses persistent goal controls", () => {
    expect(parseLocalCommand("/goal ship the runtime --token-budget 5000")).toEqual({
      type: "goal",
      action: "create",
      objective: "ship the runtime",
      tokenBudget: 5000,
    });
    expect(parseLocalCommand("/goal pause waiting for review")).toEqual({
      type: "goal",
      action: "pause",
      message: "waiting for review",
    });
    expect(parseLocalCommand("/goal resume")).toEqual({ type: "goal", action: "resume" });
    expect(parseLocalCommand("/goal complete verified")).toEqual({
      type: "goal",
      action: "complete",
      message: "verified",
    });
    expect(parseLocalCommand("/goal clear")).toEqual({ type: "goal", action: "clear" });
    expect(parseLocalCommand("/goal")).toEqual({ type: "goal", action: "show" });
  });

  test("slash catalog exposes supported meta-runtime commands", () => {
    expect(buildSlashEntries().some((entry) => entry.name === "runtime")).toBe(false);
    const plugins = [
      {
        id: "meta-runtime",
        version: "1.0.0",
        status: "active",
        sessionPaths: [],
        tui: {
          commands: [
            {
              id: "runtime",
              name: "runtime",
              signature:
                "[refresh|export|inspect <proposal-id>|apply <proposal-id>|revert <proposal-id>]",
              description: "Open or manage meta-runtime proposals",
            },
          ],
        },
      },
    ];
    const entry = buildSlashEntries(plugins).find((item) => item.name === "runtime");

    expect(entry?.signature).toContain("refresh");
    expect(entry?.signature).toContain("export");
    expect(entry?.signature).toContain("inspect <proposal-id>");
    expect(entry?.signature).toContain("apply <proposal-id>");
    expect(entry?.signature).toContain("revert <proposal-id>");
    expect(matchSlashEntries("/run", 8, plugins)[0]?.entry.name).toBe("runtime");
  });

  test("reconcileInitialRoute lands on setup once when /llm reports needs_credentials", () => {
    let state: { firstStatusSeen: boolean; route: TuiRoute } = {
      firstStatusSeen: false,
      route: "chat",
    };
    const tick = (llmStatus: "ready" | "needs_credentials" | "unknown", userNavigated = false) => {
      const out = reconcileInitialRoute({
        currentRoute: state.route,
        llmStatus,
        firstStatusSeen: state.firstStatusSeen,
        userNavigated,
      });
      state = { firstStatusSeen: out.firstStatusSeen, route: out.route };
      return out;
    };

    expect(tick("unknown")).toEqual({ route: "chat", firstStatusSeen: false });
    expect(tick("needs_credentials")).toEqual({ route: "setup", firstStatusSeen: true });
    expect(tick("ready")).toEqual({ route: "setup", firstStatusSeen: true });

    state = { firstStatusSeen: false, route: "chat" };
    expect(tick("ready")).toEqual({ route: "chat", firstStatusSeen: true });

    state = { firstStatusSeen: false, route: "chat" };
    expect(tick("needs_credentials", true)).toEqual({ route: "chat", firstStatusSeen: true });
  });

  test("mapQueueNode maps items with position, summary, and cancel affordance", () => {
    const items = mapQueueNode({
      id: "queue",
      type: "collection",
      properties: { count: 2 },
      children: [
        {
          id: "msg-1",
          type: "item",
          properties: {
            text: "alpha",
            status: "queued",
            position: 1,
            summary: "alpha",
            author: "user",
            created_at: "2026-05-06T00:00:00Z",
          },
          affordances: [{ action: "cancel" }],
        },
        {
          id: "msg-2",
          type: "item",
          properties: { text: "beta", status: "queued", position: 2, summary: "beta" },
        },
      ],
    });
    expect(items[0]?.canCancel).toBe(true);
    expect(items[0]?.position).toBe(1);
    expect(items[1]?.canCancel).toBe(false);
    expect(items[1]?.summary).toBe("beta");
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

  test("subscribes to active plugin manifest paths for palette gating", async () => {
    const socketPath = `/tmp/slop/tui-plugin-subscriptions-test-${crypto.randomUUID()}.sock`;
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    registerMinimalSessionNodes(server);
    server.register("plugins", {
      type: "collection",
      props: { count: 1, ui_manifest_version: 1 },
      items: [
        {
          id: "custom-plugin",
          props: {
            id: "custom-plugin",
            version: "1.0.0",
            status: "active",
            tui: {
              subscriptions: [{ path: "/custom", depth: 1 }],
              palette: [
                {
                  id: "custom:run",
                  label: "Run Custom Action",
                  description: "Invoke a plugin-owned custom affordance",
                  path: "/custom",
                  action: "do_it",
                  whenActionAvailable: "do_it",
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
      const commands = buildCommandPaletteCommands(snapshot, false);

      expect(snapshot.actionsByPath["/custom"]).toEqual(["do_it"]);
      expect(
        commands.find((command) => command.id === "plugin:custom-plugin:custom:run"),
      ).toMatchObject({
        label: "Run Custom Action",
        command: {
          type: "plugin_action",
          pluginId: "custom-plugin",
          actionId: "custom:run",
          path: "/custom",
          action: "do_it",
        },
      });
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("subscribes to the public session provider shape and invokes composer affordances", async () => {
    const socketPath = `/tmp/slop/tui-client-test-${crypto.randomUUID()}.sock`;
    const sentMessages: string[] = [];
    const server = createSlopServer({
      id: "mock-session",
      name: "Mock Session",
    });

    server.register("session", {
      type: "context",
      props: {
        session_id: "sess-test",
        status: "active",
        workspace_root: "/tmp/workspace",
        model_provider: "openai",
        model: "gpt-5.4",
      },
    });
    server.register("llm", {
      type: "collection",
      props: {
        status: "ready",
        message: "Ready",
        selected_provider: "openai",
        selected_model: "gpt-5.4",
      },
      items: [],
    });
    server.register("usage", { type: "context", props: {} });
    server.register("turn", {
      type: "status",
      props: {
        turn_id: null,
        state: "idle",
        phase: "none",
        iteration: 0,
        message: "Idle",
        waiting_on: null,
      },
    });
    server.register("goal", { type: "control", props: { exists: false, status: "none" } });
    server.register("composer", {
      type: "control",
      props: {
        ready: true,
        accepts_attachments: false,
        max_attachments: 0,
      },
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
    server.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
    server.register("activity", { type: "collection", props: { count: 0 }, items: [] });
    server.register("approvals", { type: "collection", props: { count: 0 }, items: [] });
    server.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
    server.register("apps", { type: "collection", props: { count: 0 }, items: [] });
    server.register("queue", { type: "collection", props: { count: 0 }, items: [] });

    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();
      expect(snapshot.connection.status).toBe("connected");
      expect(snapshot.session.sessionId).toBe("sess-test");
      expect(snapshot.composer.canSend).toBe(true);

      const result = await client.sendMessage("hello from tui");
      expect(result.status).toBe("ok");
      expect(sentMessages).toEqual(["hello from tui"]);
    } finally {
      client.disconnect();
      server.stop();
    }
  });

  test("forwards reasoning_effort through save_profile", async () => {
    const sessionSocketPath = `/tmp/slop/tui-reasoning-test-${crypto.randomUUID()}.sock`;
    const savedParams: Array<Record<string, unknown>> = [];
    const sessionServer = createSlopServer({ id: "mock-session", name: "Mock Session" });

    sessionServer.register("session", { type: "context", props: { session_id: "sess-r" } });
    sessionServer.register("llm", {
      type: "collection",
      props: { status: "ready", message: "Ready" },
      items: [],
      actions: {
        save_profile: action(
          {
            provider: "string",
            model: { type: "string" },
            reasoning_effort: { type: "string" },
          },
          async (params) => {
            savedParams.push(params as Record<string, unknown>);
            return { ok: true };
          },
          { label: "Save Profile" },
        ),
      },
    });
    sessionServer.register("usage", { type: "context", props: {} });
    sessionServer.register("turn", { type: "status", props: { state: "idle" } });
    sessionServer.register("goal", { type: "control", props: { exists: false, status: "none" } });
    sessionServer.register("composer", { type: "control", props: { ready: true } });
    sessionServer.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("activity", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("approvals", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("apps", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("queue", { type: "collection", props: { count: 0 }, items: [] });

    listeners.push(listenUnix(sessionServer, sessionSocketPath, { register: false }));

    const client = new SessionClient(sessionSocketPath);
    try {
      await client.connect();
      const result = await client.saveProfile({
        provider: "openai",
        model: "gpt-5.4",
        reasoningEffort: "high",
        makeDefault: true,
      });
      expect(result.status).toBe("ok");
      expect(savedParams).toEqual([
        {
          provider: "openai",
          model: "gpt-5.4",
          reasoning_effort: "high",
          make_default: true,
        },
      ]);
    } finally {
      client.disconnect();
      sessionServer.stop();
    }
  });

  test("queries connected external providers listed under apps", async () => {
    const sessionSocketPath = `/tmp/slop/tui-session-test-${crypto.randomUUID()}.sock`;
    const appSocketPath = `/tmp/slop/tui-app-test-${crypto.randomUUID()}.sock`;
    const sessionServer = createSlopServer({
      id: "mock-session",
      name: "Mock Session",
    });
    const appServer = createSlopServer({
      id: "native-demo",
      name: "Native Demo",
    });

    appServer.register("workspace", {
      type: "context",
      props: {
        status: "ready",
      },
    });
    sessionServer.register("session", { type: "context", props: { session_id: "sess-apps" } });
    sessionServer.register("llm", { type: "collection", props: { status: "ready" }, items: [] });
    sessionServer.register("usage", { type: "context", props: {} });
    sessionServer.register("turn", { type: "status", props: { state: "idle" } });
    sessionServer.register("goal", { type: "control", props: { exists: false, status: "none" } });
    sessionServer.register("composer", { type: "control", props: { ready: true } });
    sessionServer.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("activity", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("approvals", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("apps", {
      type: "collection",
      props: { count: 1 },
      items: [
        {
          id: "native-demo",
          props: {
            provider_id: "native-demo",
            name: "Native Demo",
            transport: `unix:${appSocketPath}`,
            status: "connected",
          },
        },
      ],
    });
    sessionServer.register("queue", { type: "collection", props: { count: 0 }, items: [] });

    listeners.push(listenUnix(appServer, appSocketPath, { register: false }));
    listeners.push(listenUnix(sessionServer, sessionSocketPath, { register: false }));

    const client = new SessionClient(sessionSocketPath);
    try {
      await client.connect();
      const tree = await client.queryInspect("/workspace", 1, "native-demo", {
        maxNodes: 10,
        window: [0, 10],
      });

      expect(tree.id).toBe("workspace");
      expect(tree.properties?.status).toBe("ready");
      expect(client.getSnapshot().inspect.targetId).toBe("native-demo");
      expect(client.getSnapshot().inspect.targetTransport).toBe(`unix:${appSocketPath}`);
      expect(client.getSnapshot().inspect.maxNodes).toBe(10);
      expect(client.getSnapshot().inspect.window).toEqual([0, 10]);
    } finally {
      client.disconnect();
      sessionServer.stop();
      appServer.stop();
    }
  });

  test("queries and invokes first-party providers through the session apps proxy", async () => {
    const sessionSocketPath = `/tmp/slop/tui-proxy-test-${crypto.randomUUID()}.sock`;
    const queries: Array<Record<string, unknown>> = [];
    const invocations: Array<Record<string, unknown>> = [];
    const sessionServer = createSlopServer({ id: "mock-session", name: "Mock Session" });

    sessionServer.register("session", { type: "context", props: { session_id: "sess-proxy" } });
    sessionServer.register("llm", { type: "collection", props: { status: "ready" }, items: [] });
    sessionServer.register("usage", { type: "context", props: {} });
    sessionServer.register("turn", { type: "status", props: { state: "idle" } });
    sessionServer.register("goal", { type: "control", props: { exists: false, status: "none" } });
    sessionServer.register("composer", { type: "control", props: { ready: true } });
    sessionServer.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("activity", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("approvals", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
    sessionServer.register("apps", {
      type: "collection",
      props: { count: 1 },
      items: [
        {
          id: "session-proxy:meta-runtime",
          props: {
            provider_id: "meta-runtime",
            name: "Meta Runtime",
            transport: "in-process",
            status: "connected",
          },
        },
      ],
      actions: {
        query_provider: action(
          { provider_id: "string", path: "string", depth: "number" },
          async (params) => {
            queries.push(params);
            return {
              id: "proposals",
              type: "collection",
              properties: { count: 0 },
              children: [],
            };
          },
        ),
        invoke_provider: action(
          {
            provider_id: "string",
            path: "string",
            action: "string",
            params: { type: "object", optional: true },
          },
          async (params) => {
            invocations.push(params);
            return { exported: true };
          },
        ),
      },
    });
    sessionServer.register("queue", { type: "collection", props: { count: 0 }, items: [] });
    listeners.push(listenUnix(sessionServer, sessionSocketPath, { register: false }));

    const client = new SessionClient(sessionSocketPath);
    try {
      await client.connect();
      const tree = await client.queryInspect("/proposals", 2, "session-proxy:meta-runtime");
      const result = await client.invokeInspect(
        "/session",
        "export_bundle",
        { include_skills: true },
        "session-proxy:meta-runtime",
      );

      expect(tree.id).toBe("proposals");
      expect(queries).toEqual([
        {
          provider_id: "meta-runtime",
          path: "/proposals",
          depth: 2,
        },
      ]);
      expect(result.status).toBe("ok");
      expect(result.data).toEqual({ exported: true });
      expect(invocations).toEqual([
        {
          provider_id: "meta-runtime",
          path: "/session",
          action: "export_bundle",
          params: { include_skills: true },
        },
      ]);
    } finally {
      client.disconnect();
      sessionServer.stop();
    }
  });

  test("subscribes to /queue and cancels by id via the per-item affordance", async () => {
    const socketPath = `/tmp/slop/tui-queue-test-${crypto.randomUUID()}.sock`;
    const cancelled: string[] = [];
    const server = createSlopServer({ id: "mock-session", name: "Mock Session" });

    server.register("session", { type: "context", props: { session_id: "sess-q" } });
    server.register("llm", { type: "collection", props: { status: "ready" }, items: [] });
    server.register("usage", { type: "context", props: {} });
    server.register("turn", { type: "status", props: { state: "running" } });
    server.register("goal", { type: "control", props: { exists: false, status: "none" } });
    server.register("composer", { type: "control", props: { ready: true } });
    server.register("transcript", { type: "collection", props: { count: 0 }, items: [] });
    server.register("activity", { type: "collection", props: { count: 0 }, items: [] });
    server.register("approvals", { type: "collection", props: { count: 0 }, items: [] });
    server.register("tasks", { type: "collection", props: { count: 0 }, items: [] });
    server.register("apps", { type: "collection", props: { count: 0 }, items: [] });
    server.register("queue", {
      type: "collection",
      props: { count: 1 },
      items: [
        {
          id: "msg-q1",
          props: {
            text: "queued message",
            status: "queued",
            position: 1,
            summary: "queued message",
            author: "user",
          },
          actions: {
            cancel: action({}, async () => {
              cancelled.push("msg-q1");
              return { ok: true };
            }),
          },
        },
      ],
    });

    listeners.push(listenUnix(server, socketPath, { register: false }));

    const client = new SessionClient(socketPath);
    try {
      const snapshot = await client.connect();
      expect(snapshot.queue).toHaveLength(1);
      expect(snapshot.queue[0]?.id).toBe("msg-q1");
      expect(snapshot.queue[0]?.canCancel).toBe(true);

      const result = await client.cancelQueuedMessage("msg-q1");
      expect(result.status).toBe("ok");
      expect(cancelled).toEqual(["msg-q1"]);
    } finally {
      client.disconnect();
      server.stop();
    }
  });
});

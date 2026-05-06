import { afterEach, describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import {
  applyPathSnapshot,
  EMPTY_SESSION_VIEW,
  mapLlmNode,
  mapQueueNode,
  mapSessionNode,
  mapTranscriptNode,
} from "../apps/tui/src/slop/node-mappers";
import { SessionClient } from "../apps/tui/src/slop/session-client";
import type { TuiRoute } from "../apps/tui/src/slop/types";
import { buildCommandPaletteCommands } from "../apps/tui/src/state/command-palette";
import { parseLocalCommand } from "../apps/tui/src/state/commands";
import { ComposerHistory } from "../apps/tui/src/state/composer-history";
import { reconcileInitialRoute } from "../apps/tui/src/state/initial-route";

const listeners: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    listener.close();
  }
});

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
    expect(next.transcript).toEqual([]);
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
    expect(byId.get("goal:pause")?.command).toEqual({ type: "goal", action: "pause" });
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

  test("queries and invokes built-in providers through the session apps proxy", async () => {
    const sessionSocketPath = `/tmp/slop/tui-proxy-test-${crypto.randomUUID()}.sock`;
    const queries: Array<Record<string, unknown>> = [];
    const invocations: Array<Record<string, unknown>> = [];
    const sessionServer = createSlopServer({ id: "mock-session", name: "Mock Session" });

    sessionServer.register("session", { type: "context", props: { session_id: "sess-proxy" } });
    sessionServer.register("llm", { type: "collection", props: { status: "ready" }, items: [] });
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

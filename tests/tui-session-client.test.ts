import { afterEach, describe, expect, test } from "bun:test";
import { action, createSlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import {
  applyPathSnapshot,
  EMPTY_SESSION_VIEW,
  mapTranscriptNode,
} from "../apps/tui/src/slop/node-mappers";
import { SessionClient } from "../apps/tui/src/slop/session-client";
import { parseLocalCommand } from "../apps/tui/src/state/commands";
import { DraftQueue } from "../apps/tui/src/state/draft-queue";

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
});

describe("TUI local state", () => {
  test("draft queue is FIFO and ignores empty drafts", () => {
    const queue = new DraftQueue();

    expect(queue.enqueue("   ")).toBeNull();
    const first = queue.enqueue("first");
    const second = queue.enqueue("second");

    expect(queue.size).toBe(2);
    expect(queue.peek()?.id).toBe(first?.id);
    expect(queue.dequeue()?.id).toBe(first?.id);
    expect(queue.dequeue()?.id).toBe(second?.id);
    expect(queue.dequeue()).toBeNull();
  });

  test("local command parser recognizes routes, query, invoke, and secret profile setup", () => {
    expect(parseLocalCommand("/apps")).toEqual({ type: "route", route: "apps" });
    expect(parseLocalCommand("/query /llm 3")).toEqual({
      type: "query",
      path: "/llm",
      depth: 3,
    });
    expect(parseLocalCommand('/invoke /composer send_message {"text":"hi"}')).toEqual({
      type: "invoke",
      path: "/composer",
      action: "send_message",
      params: { text: "hi" },
    });
    expect(parseLocalCommand("/profile-secret openai gpt-5.4")).toEqual({
      type: "profile_secret",
      provider: "openai",
      model: "gpt-5.4",
      baseUrl: undefined,
      makeDefault: true,
    });
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
});

import { describe, expect, test } from "bun:test";

import { mapClientSnapshot } from "../apps/tui/src/backend/node-mappers";
import { assembleTranscript } from "../apps/tui/src/projections/stream-assembler";
import type { SessionClientSnapshot } from "../src/session/client-protocol/types";
import { SessionStore } from "../src/session/store";

function clientSnapshot(): SessionClientSnapshot {
  const store = new SessionStore({
    sessionId: "mapper-session",
    modelProvider: "openai",
    model: "test-model",
  });
  return {
    session: store.getSnapshot(),
    controls: {
      canSendMessage: true,
      canCancelTurn: false,
      canReloadConfig: true,
    },
    pluginState: {},
    plugins: [],
  };
}

describe("TUI typed snapshot mapper", () => {
  test("maps mixed transcript content to renderable messages", () => {
    const input = clientSnapshot();
    input.session.transcript.push({
      id: "msg-1",
      seq: 1,
      role: "assistant",
      state: "streaming",
      turnId: "turn-1",
      createdAt: "2026-05-21T10:00:00Z",
      content: [
        { id: "block-1", type: "text", mime: "text/plain", text: "hello" },
        {
          id: "block-2",
          type: "media",
          mime: "image/png",
          preview: "screenshot preview",
        },
      ],
    });

    expect(assembleTranscript(mapClientSnapshot(input).transcript)).toEqual([
      {
        id: "msg-1",
        seq: 1,
        role: "assistant",
        state: "streaming",
        blocks: [
          { id: "block-1", seq: 1, text: "hello", type: "text" },
          { id: "block-2", seq: 1, text: "screenshot preview", type: "plain" },
        ],
      },
    ]);
  });

  test("maps approvals and server-computed controls", () => {
    const input = clientSnapshot();
    input.session.approvalPolicy.mode = "auto";
    input.session.approvals.push({
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
    });

    const mapped = mapClientSnapshot(input);
    expect(mapped.approvalMode).toBe("auto");
    expect(mapped.approvals[0]).toEqual({
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
    });
  });

  test("maps tasks, queued messages, and attached providers", () => {
    const input = clientSnapshot();
    input.session.tasks.push({
      id: "task-1",
      status: "running",
      provider: "filesystem",
      providerTaskId: "provider-task-1",
      message: "Indexing",
      progress: 0.4,
      linkedActivityId: "activity-1",
      canCancel: true,
      startedAt: "2026-05-21T10:00:00Z",
      updatedAt: "2026-05-21T10:01:00Z",
    });
    input.session.queue.push({
      id: "msg-1",
      status: "queued",
      text: "queued prompt",
      createdAt: "2026-05-21T10:02:00Z",
      author: "user",
    });
    input.session.apps.push({
      id: "native-demo",
      name: "Native Demo",
      transport: "unix:/tmp/native-demo.sock",
      status: "connected",
      lastError: "previous retry failed",
    });

    const mapped = mapClientSnapshot(input);
    expect(mapped.tasks[0]).toMatchObject({
      id: "task-1",
      progress: 0.4,
      canCancel: true,
    });
    expect(mapped.queue[0]).toMatchObject({
      id: "msg-1",
      position: 1,
      canCancel: true,
    });
    expect(mapped.apps[0]).toEqual({
      id: "native-demo",
      providerId: "native-demo",
      name: "Native Demo",
      transport: "unix:/tmp/native-demo.sock",
      status: "connected",
      lastError: "previous retry failed",
    });
  });
});

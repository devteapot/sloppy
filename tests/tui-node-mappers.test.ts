import { describe, expect, test } from "bun:test";

import {
  applyPathSnapshot,
  EMPTY_SESSION_VIEW,
  mapApprovalsNode,
  mapAppsNode,
  mapQueueNode,
  mapTasksNode,
  mapTranscriptNode,
} from "../apps/tui/src/backend/node-mappers";
import { assembleTranscript } from "../apps/tui/src/projections/stream-assembler";

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
        blocks: [
          { id: "block-1", seq: 0, text: "hello", type: "text" },
          { id: "block-2", seq: 0, text: "screenshot preview", type: "plain" },
        ],
      },
    ]);
  });
});

describe("TUI node mappers", () => {
  test("maps approvals with affordance availability", () => {
    const approvalNode = {
      id: "approvals",
      type: "collection",
      properties: {
        approval_mode: "auto",
      },
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
    };
    const approvals = mapApprovalsNode(approvalNode);

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

    const next = applyPathSnapshot(EMPTY_SESSION_VIEW, "/approvals", approvalNode);
    expect(next.approvalMode).toBe("auto");
    expect(next.actionsByPath["/approvals"]).toEqual([]);
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

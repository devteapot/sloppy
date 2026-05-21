import { describe, expect, test } from "bun:test";

import { EMPTY_SESSION_VIEW } from "../apps/tui/src/backend/node-mappers";
import type {
  ActivityItem,
  SessionViewSnapshot,
  TranscriptMessage,
} from "../apps/tui/src/backend/slop-types";
import { buildChatLogEntries, ChatLog } from "../apps/tui/src/ui/chat-log";

function snapshotWith(
  partial: Partial<Pick<SessionViewSnapshot, "activity" | "transcript">>,
): SessionViewSnapshot {
  return {
    ...EMPTY_SESSION_VIEW,
    activity: partial.activity ?? [],
    transcript: partial.transcript ?? [],
  };
}

function message(input: {
  id: string;
  seq: number;
  role: TranscriptMessage["role"];
  state: string;
  text: string;
}): TranscriptMessage {
  return {
    id: input.id,
    seq: input.seq,
    role: input.role,
    state: input.state,
    turnId: null,
    blocks: [
      {
        id: `${input.id}-text`,
        type: "text",
        text: input.text,
      },
    ],
  };
}

function activity(
  input: Partial<ActivityItem> & Pick<ActivityItem, "id" | "kind" | "seq">,
): ActivityItem {
  return {
    status: "ok",
    summary: input.kind,
    ...input,
  };
}

describe("ChatLog", () => {
  test("builds plain entries for user and streaming assistant messages", () => {
    const entries = buildChatLogEntries(
      snapshotWith({
        transcript: [
          message({
            id: "user-1",
            seq: 1,
            role: "user",
            state: "complete",
            text: "# literal\n\na * b",
          }),
          message({
            id: "assistant-1",
            seq: 2,
            role: "assistant",
            state: "streaming",
            text: "```ts\nconst half = true;",
          }),
        ],
      }),
      { verbosity: "normal", width: 80 },
    );

    expect(entries).toMatchObject([
      {
        key: "msg:user-1",
        mode: "plain",
        content: "user>\n\n# literal\n\na * b",
      },
      {
        key: "msg:assistant-1",
        mode: "plain",
        content: "assistant>\n\n```ts\nconst half = true;",
      },
    ]);
  });

  test("uses markdown for completed assistant and system entries, plain for tools", () => {
    const entries = buildChatLogEntries(
      snapshotWith({
        transcript: [
          message({
            id: "system-1",
            seq: 1,
            role: "system",
            state: "complete",
            text: "## Status",
          }),
          message({
            id: "assistant-1",
            seq: 2,
            role: "assistant",
            state: "complete",
            text: "**Done**",
          }),
        ],
        activity: [
          activity({
            id: "call-1",
            seq: 3,
            kind: "tool_call",
            status: "running",
            summary: "filesystem:read",
            provider: "filesystem",
            action: "read",
            toolUseId: "tool-1",
          }),
          activity({
            id: "result-1",
            seq: 4,
            kind: "tool_result",
            summary: "filesystem:read README.md",
            provider: "filesystem",
            action: "read",
            path: "README.md",
            toolUseId: "tool-1",
            result: {
              kind: "code",
              data: { path: "README.md", content: "# Sloppy" },
            },
          }),
        ],
      }),
      { verbosity: "normal", width: 80 },
    );

    expect(entries.map(({ key, mode }) => ({ key, mode }))).toEqual([
      { key: "msg:system-1", mode: "markdown" },
      { key: "msg:assistant-1", mode: "markdown" },
      { key: "tool:tool-1", mode: "plain" },
    ]);
    expect(entries[0]?.content).toBe("**system>**\n\n## Status");
    expect(entries[1]?.content).toBe("**assistant>**\n\n**Done**");
    expect(entries[2]?.content).toContain("Tool");
  });

  test("keeps message keys stable while streaming entries switch mode on completion", () => {
    const streaming = buildChatLogEntries(
      snapshotWith({
        transcript: [
          message({
            id: "assistant-1",
            seq: 1,
            role: "assistant",
            state: "streaming",
            text: "**part",
          }),
        ],
      }),
      { verbosity: "normal", width: 80 },
    )[0];
    const complete = buildChatLogEntries(
      snapshotWith({
        transcript: [
          message({
            id: "assistant-1",
            seq: 1,
            role: "assistant",
            state: "complete",
            text: "**part**",
          }),
        ],
      }),
      { verbosity: "normal", width: 80 },
    )[0];

    expect(streaming?.key).toBe("msg:assistant-1");
    expect(complete?.key).toBe("msg:assistant-1");
    expect(streaming?.mode).toBe("plain");
    expect(complete?.mode).toBe("markdown");
  });

  test("reuses stable components and swaps only when render mode changes", () => {
    const log = new ChatLog();
    const completeUser = message({
      id: "user-1",
      seq: 1,
      role: "user",
      state: "complete",
      text: "hello",
    });

    log.update(snapshotWith({ transcript: [completeUser] }));
    const firstUserComponent = log.children[0];

    log.update(
      snapshotWith({
        transcript: [
          completeUser,
          message({
            id: "assistant-1",
            seq: 2,
            role: "assistant",
            state: "streaming",
            text: "part",
          }),
        ],
      }),
    );
    const streamingAssistantComponent = log.children[1];
    expect(log.children[0]).toBe(firstUserComponent);

    log.update(
      snapshotWith({
        transcript: [
          completeUser,
          message({
            id: "assistant-1",
            seq: 2,
            role: "assistant",
            state: "streaming",
            text: "part two",
          }),
        ],
      }),
    );
    expect(log.children[0]).toBe(firstUserComponent);
    expect(log.children[1]).toBe(streamingAssistantComponent);

    log.update(
      snapshotWith({
        transcript: [
          completeUser,
          message({
            id: "assistant-1",
            seq: 2,
            role: "assistant",
            state: "complete",
            text: "**part two**",
          }),
        ],
      }),
    );
    expect(log.children[0]).toBe(firstUserComponent);
    expect(log.children[1]).not.toBe(streamingAssistantComponent);
  });
});

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { EMPTY_SESSION_VIEW } from "../apps/tui/src/backend/node-mappers";
import type {
  ActivityItem,
  SessionViewSnapshot,
  TranscriptMessage,
} from "../apps/tui/src/backend/slop-types";
import { buildChatLogEntries, ChatLog } from "../apps/tui/src/ui/chat-log";

function stripAnsi(value: string): string {
  const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return value.replace(sgrPattern, "");
}

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

function thinkingMessage(input: {
  id: string;
  seq: number;
  display: "visible" | "hidden";
}): TranscriptMessage {
  return {
    id: input.id,
    seq: input.seq,
    role: "assistant",
    state: "complete",
    turnId: null,
    blocks: [
      {
        id: `${input.id}-thinking`,
        type: "thinking",
        text: "private calculation",
        format: "raw",
        display: input.display,
        elapsedMs: 1500,
        tokenCount: 12,
        tokenCountSource: "reported",
      },
      {
        id: `${input.id}-text`,
        type: "text",
        text: "final answer",
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
  test("builds block-aware entries for user and streaming assistant messages", () => {
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
      { verbosity: "compact", width: 80 },
    );

    expect(entries).toMatchObject([
      {
        key: "msg:user-1",
        mode: "plain",
        variant: "user",
        content: "# literal\n\na * b",
      },
      {
        key: "msg:assistant-1:block:assistant-1-text",
        mode: "streaming-markdown",
        variant: "default",
        content: "```ts\nconst half = true;",
      },
    ]);
  });

  test("renders user messages with a left accent and no background highlight", () => {
    const log = new ChatLog();
    log.update(
      snapshotWith({
        transcript: [
          message({
            id: "user-1",
            seq: 1,
            role: "user",
            state: "complete",
            text: "hello",
          }),
        ],
      }),
    );

    const lines = log.children[0]?.render(40) ?? [];
    const rendered = lines.join("\n");
    expect(rendered).not.toContain("\x1b[48;5;237m");
    expect(rendered).toContain("\x1b[38;5;214m▌");
    expect(rendered).toContain("hello");
    expect(rendered).not.toContain("┌");
    expect(rendered).not.toContain("└");
    expect(lines).toHaveLength(1);
    expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
  });

  test("pads non-composer chat content horizontally", () => {
    const log = new ChatLog();
    log.update(
      snapshotWith({
        transcript: [
          message({
            id: "assistant-1",
            seq: 1,
            role: "assistant",
            state: "streaming",
            text: "part",
          }),
        ],
      }),
    );

    const lines = log.children[0]?.render(20) ?? [];
    expect(lines.some((line) => line.startsWith(" part"))).toBe(true);
  });

  test("uses final markdown for completed assistant and system entries, plain for tools", () => {
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
            label: "Read File",
            toolUseId: "tool-1",
          }),
          activity({
            id: "result-1",
            seq: 4,
            kind: "tool_result",
            summary: "filesystem:read README.md",
            provider: "filesystem",
            action: "read",
            label: "Read File",
            path: "README.md",
            toolUseId: "tool-1",
            result: {
              kind: "code",
              data: { path: "README.md", content: "# Sloppy" },
            },
          }),
        ],
      }),
      { verbosity: "compact", width: 80 },
    );

    expect(entries.map(({ key, mode }) => ({ key, mode }))).toEqual([
      { key: "msg:system-1:block:system-1-text", mode: "final-markdown" },
      { key: "msg:assistant-1:block:assistant-1-text", mode: "final-markdown" },
      { key: "tool:tool-1", mode: "plain" },
    ]);
    expect(entries[0]?.content).toBe("## Status");
    expect(entries[1]?.content).toBe("**Done**");
    expect(entries[2]?.content).toContain("Read File");
  });

  test("renders assistant fenced code blocks without markdown fence markers", () => {
    const log = new ChatLog();
    log.update(
      snapshotWith({
        transcript: [
          message({
            id: "assistant-1",
            seq: 1,
            role: "assistant",
            state: "complete",
            text: [
              "```ts",
              "class BottomPaddedText extends Text {",
              "  render(width: number): string[] {",
              "    return [];",
              "  }",
              "}",
              "```",
            ].join("\n"),
          }),
        ],
      }),
    );

    const rendered = stripAnsi(log.children[0]?.render(80).join("\n") ?? "");
    expect(rendered).toContain("class BottomPaddedText extends Text {");
    expect(rendered).not.toContain("```ts");
    expect(rendered).not.toContain("```");
  });

  test("highlights fenced markdown diffs like edit diffs", () => {
    const log = new ChatLog();
    log.update(
      snapshotWith({
        transcript: [
          message({
            id: "assistant-1",
            seq: 1,
            role: "assistant",
            state: "complete",
            text: ["```diff", "-old", "+new", "```"].join("\n"),
          }),
        ],
      }),
    );

    const rendered = log.children[0]?.render(80).join("\n") ?? "";
    expect(stripAnsi(rendered)).toContain("-old");
    expect(stripAnsi(rendered)).toContain("+new");
    expect(rendered).toContain("\x1b[48;5;52m-old\x1b[49m");
    expect(rendered).toContain("\x1b[48;5;22m+new\x1b[49m");
  });

  test("orders tool pairs by activity sequence before compact grouping", () => {
    const entries = buildChatLogEntries(
      snapshotWith({
        activity: [
          activity({
            id: "call-1",
            seq: 1,
            kind: "tool_call",
            status: "running",
            summary: "filesystem:read README.md",
            provider: "filesystem",
            action: "read",
            label: "Read File",
            toolUseId: "tool-1",
          }),
          activity({
            id: "result-1",
            seq: 4,
            kind: "tool_result",
            summary: "filesystem:read README.md",
            provider: "filesystem",
            action: "read",
            label: "Read File",
            path: "README.md",
            toolUseId: "tool-1",
            result: { kind: "code", data: { path: "README.md" } },
          }),
          activity({
            id: "call-2",
            seq: 3,
            kind: "tool_call",
            status: "running",
            summary: "filesystem:search TODO",
            provider: "filesystem",
            action: "search",
            label: "Search Workspace",
            toolUseId: "tool-2",
          }),
        ],
      }),
      { verbosity: "compact", width: 80 },
    );

    expect(entries.map((entry) => entry.key)).toEqual(["tool:tool-2", "tool:tool-1"]);
  });

  test("interleaves assistant blocks with tool activity by block sequence", () => {
    const entries = buildChatLogEntries(
      snapshotWith({
        transcript: [
          {
            id: "assistant-1",
            seq: 3,
            role: "assistant",
            state: "complete",
            turnId: "turn-1",
            blocks: [
              {
                id: "thinking-1",
                seq: 3,
                type: "thinking",
                text: "check files",
                format: "summary",
                display: "hidden",
              },
              {
                id: "text-1",
                seq: 6,
                type: "text",
                text: "final answer",
              },
            ],
          },
        ],
        activity: [
          activity({
            id: "call-1",
            seq: 4,
            kind: "tool_call",
            status: "running",
            summary: "filesystem:read README.md",
            provider: "filesystem",
            action: "read",
            label: "Read File",
            toolUseId: "tool-1",
          }),
          activity({
            id: "result-1",
            seq: 5,
            kind: "tool_result",
            summary: "filesystem:read README.md",
            provider: "filesystem",
            action: "read",
            label: "Read File",
            path: "README.md",
            toolUseId: "tool-1",
            result: { kind: "text", data: "ok" },
          }),
        ],
      }),
      { verbosity: "compact", width: 80 },
    );

    expect(entries.map((entry) => entry.key)).toEqual([
      "msg:assistant-1:block:thinking-1",
      "tool:tool-1",
      "msg:assistant-1:block:text-1",
    ]);
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
      { verbosity: "compact", width: 80 },
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
      { verbosity: "compact", width: 80 },
    )[0];

    expect(streaming?.key).toBe("msg:assistant-1:block:assistant-1-text");
    expect(complete?.key).toBe("msg:assistant-1:block:assistant-1-text");
    expect(streaming?.mode).toBe("streaming-markdown");
    expect(complete?.mode).toBe("final-markdown");
  });

  test("renders thinking output collapsed or expanded without dropping transcript state", () => {
    const snapshot = snapshotWith({
      transcript: [thinkingMessage({ id: "assistant-thinking", seq: 1, display: "hidden" })],
    });

    const defaultEntries = buildChatLogEntries(snapshot, {
      verbosity: "compact",
      width: 80,
    });
    const defaultEntry = defaultEntries[0];
    expect(defaultEntry?.content).toContain("[thinking · raw · 1.5s · 12 tokens]");
    expect(defaultEntry?.content).not.toContain("private calculation");
    expect(defaultEntries[1]?.content).toContain("final answer");

    const expandedEntry = buildChatLogEntries(snapshot, {
      verbosity: "compact",
      width: 80,
      thinking: "expanded",
    })[0];
    expect(expandedEntry?.content).toContain("private calculation");

    const collapsedVisibleEntry = buildChatLogEntries(
      snapshotWith({
        transcript: [
          thinkingMessage({ id: "assistant-thinking-visible", seq: 1, display: "visible" }),
        ],
      }),
      {
        verbosity: "compact",
        width: 80,
        thinking: "collapsed",
      },
    )[0];
    expect(collapsedVisibleEntry?.content).not.toContain("private calculation");
  });

  test("reuses transcript message components while child renderers change", () => {
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
    expect(log.children[1]).toBe(streamingAssistantComponent);
  });
});

import {
  type Component,
  Container,
  Markdown,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { ActivityItem, SessionViewSnapshot } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";
import { assembleTranscript, type ThinkingRenderMode } from "../state/stream-assembler";
import { dim, markdownTheme } from "./theme";
import {
  renderToolCallCard,
  renderToolCallGroup,
  type ToolActivityPair,
  toolActivityGroupKey,
} from "./tool-call-card";

const CONTENT_PADDING_X = 1;

export class ChatLog extends Container {
  private readonly renderedEntries = new Map<string, RenderedEntry>();

  update(
    snapshot: SessionViewSnapshot,
    options?: { verbosity?: Verbosity; thinking?: ThinkingRenderMode },
  ): void {
    const verbosity = options?.verbosity ?? "compact";
    const timeline = buildChatLogEntries(snapshot, {
      verbosity,
      width: process.stdout.columns || 100,
      thinking: options?.thinking ?? "default",
    });

    const activeKeys = new Set(timeline.map((item) => item.key));
    for (const key of this.renderedEntries.keys()) {
      if (!activeKeys.has(key)) {
        this.renderedEntries.delete(key);
      }
    }

    this.clear();
    if (timeline.length === 0) {
      this.addChild(new Markdown("No transcript yet.", CONTENT_PADDING_X, 0, markdownTheme));
    }
    for (const item of timeline) {
      this.addChild(this.renderEntry(item));
    }
    const cards = inlineCards(snapshot);
    if (cards.length > 0) {
      this.addChild(new Markdown(cards.join("\n\n"), CONTENT_PADDING_X, 1, markdownTheme));
    }
  }

  private renderEntry(entry: ChatLogEntry): Component {
    const rendered = this.renderedEntries.get(entry.key);
    if (rendered && rendered.mode === entry.mode && rendered.variant === entry.variant) {
      if (rendered.content !== entry.content) {
        rendered.component.setText(entry.content);
        rendered.content = entry.content;
      }
      return rendered.component;
    }

    const component =
      entry.mode === "markdown"
        ? new Markdown(entry.content, CONTENT_PADDING_X, 1, markdownTheme)
        : entry.variant === "user"
          ? new BorderedUserMessage(entry.content)
          : entry.variant === "tool"
            ? new BottomPaddedText(entry.content)
            : new Text(entry.content, CONTENT_PADDING_X, 1);
    this.renderedEntries.set(entry.key, {
      component,
      content: entry.content,
      mode: entry.mode,
      variant: entry.variant,
    });
    return component;
  }
}

class BottomPaddedText extends Text {
  constructor(text: string) {
    super(text, CONTENT_PADDING_X, 0);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    return lines.length > 0 ? [...lines, " ".repeat(width)] : lines;
  }
}

class BorderedUserMessage implements Component {
  private text: string;
  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(text: string) {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const outerWidth = Math.max(8, Math.floor(width));
    const innerWidth = outerWidth - 2;
    const contentWidth = Math.max(1, innerWidth - 2);
    const contentLines = wrapTextWithAnsi(this.text.replace(/\t/g, "   "), contentWidth);
    const border = dim;
    const lines = [
      border(`┌${"─".repeat(innerWidth)}┐`),
      ...contentLines.map(
        (line) => `${border("│")} ${padToWidth(line, contentWidth)} ${border("│")}`,
      ),
      border(`└${"─".repeat(innerWidth)}┘`),
    ];

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function padToWidth(line: string, width: number): string {
  const visible = visibleWidth(line);
  return `${line}${" ".repeat(Math.max(0, width - visible))}`;
}

export type ChatLogRenderMode = "plain" | "markdown";
export type ChatLogEntryVariant = "default" | "user" | "tool";

export type ChatLogEntry = {
  key: string;
  mode: ChatLogRenderMode;
  variant: ChatLogEntryVariant;
  content: string;
};

type RenderedEntry = {
  component: Component & { setText(text: string): void };
  content: string;
  mode: ChatLogRenderMode;
  variant: ChatLogEntryVariant;
};

export function buildChatLogEntries(
  snapshot: SessionViewSnapshot,
  options: { verbosity: Verbosity; width: number; thinking?: ThinkingRenderMode },
): ChatLogEntry[] {
  const messages = assembleTranscript(snapshot.transcript, {
    thinking: options.thinking ?? "default",
  }).map((message) => {
    const mode = messageRenderMode(message.role, message.state);
    const variant: ChatLogEntryVariant = message.role === "user" ? "user" : "default";
    const body = message.text || message.state;
    return {
      key: `msg:${message.id}`,
      mode,
      variant,
      seq: message.seq,
      content: body,
    };
  });
  const tools = buildToolEntries(buildToolPairs(snapshot.activity), options);
  return [...messages, ...tools]
    .filter((item) => item.content.length > 0)
    .sort((left, right) => left.seq - right.seq)
    .map(({ key, mode, variant, content }) => ({ key, mode, variant, content }));
}

function messageRenderMode(
  role: "user" | "assistant" | "system" | "unknown",
  state: string,
): ChatLogRenderMode {
  if (role === "user") {
    return "plain";
  }
  if ((role === "assistant" || role === "system") && state === "complete") {
    return "markdown";
  }
  return "plain";
}

function buildToolEntries(
  pairs: ToolActivityPair[],
  options: { verbosity: Verbosity; width: number },
): Array<ChatLogEntry & { seq: number }> {
  const entries: Array<ChatLogEntry & { seq: number }> = [];
  const orderedPairs = [...pairs].sort((left, right) => toolPairSeq(left) - toolPairSeq(right));
  const groups =
    options.verbosity === "compact"
      ? groupConsecutiveToolPairs(orderedPairs)
      : orderedPairs.map((pair) => [pair]);

  for (const group of groups) {
    if (group.length === 1) {
      const pair = group[0];
      entries.push({
        key: `tool:${toolPairId(pair)}`,
        mode: "plain",
        variant: "tool",
        seq: toolPairSeq(pair),
        content: renderToolCallCard(pair, options),
      });
      continue;
    }
    entries.push({
      key: `tool-group:${toolPairId(group[0])}:${group.length}`,
      mode: "plain",
      variant: "tool",
      seq: toolPairSeq(group[0]),
      content: renderToolCallGroup(group, options),
    });
  }
  return entries;
}

function groupConsecutiveToolPairs(pairs: ToolActivityPair[]): ToolActivityPair[][] {
  const groups: ToolActivityPair[][] = [];
  for (const pair of pairs) {
    const previous = groups[groups.length - 1];
    if (previous && toolActivityGroupKey(previous[0]) === toolActivityGroupKey(pair)) {
      previous.push(pair);
    } else {
      groups.push([pair]);
    }
  }
  return groups;
}

function toolPairId(pair: ToolActivityPair): string {
  const item = pair.result ?? pair.call;
  return item?.toolUseId ?? item?.id ?? "unknown";
}

function toolPairSeq(pair: ToolActivityPair): number {
  return (pair.result ?? pair.call)?.seq ?? 0;
}

function buildToolPairs(activity: ActivityItem[]): ToolActivityPair[] {
  const calls = new Map<string, ActivityItem>();
  const pairs: ToolActivityPair[] = [];
  for (const item of activity) {
    if (!item.toolUseId) {
      continue;
    }
    if (item.kind === "tool_call") {
      calls.set(item.toolUseId, item);
    } else if (item.kind === "tool_result") {
      pairs.push({
        call: calls.get(item.toolUseId),
        result: item,
      });
      calls.delete(item.toolUseId);
    }
  }
  for (const call of calls.values()) {
    pairs.push({ call });
  }
  return pairs;
}

function inlineCards(snapshot: SessionViewSnapshot): string[] {
  const cards: string[] = [];
  const approval = snapshot.approvals.find((item) => item.status === "pending");
  if (approval) {
    cards.push(
      [
        `**Approval** ${approval.provider}.${approval.action}`,
        approval.reason,
        approval.paramsPreview ? `\`${approval.paramsPreview}\`` : "",
        approval.canApprove || approval.canReject ? "`Ctrl+K` for approve/reject" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const task = snapshot.tasks.find((item) => item.status === "running" && item.canCancel);
  if (task) {
    cards.push(
      [
        `**Task** ${task.providerTaskId}`,
        task.message,
        task.progress === undefined ? "" : `${Math.round(task.progress * 100)}%`,
        "`Ctrl+K` to cancel task",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (snapshot.queue.length > 0) {
    cards.push(
      [
        `**Queue** ${snapshot.queue.length} message${snapshot.queue.length === 1 ? "" : "s"}`,
        ...snapshot.queue.slice(0, 3).map((item) => `${item.position}. ${item.summary}`),
      ].join("\n"),
    );
  }
  return cards;
}

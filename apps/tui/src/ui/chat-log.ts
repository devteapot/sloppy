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
import {
  assembleTranscript,
  type RenderableBlock,
  type RenderableMessage,
  renderableBlockText,
  renderableMessageText,
  type ThinkingRenderMode,
} from "../state/stream-assembler";
import { safeMarkdownText, safePlainText } from "./render-safety";
import { PlainTranscriptText, SafeMarkdown, StreamingMarkdown } from "./streaming-markdown";
import { markdownTheme, orange } from "./theme";
import {
  renderToolCallCard,
  renderToolCallGroup,
  type ToolActivityPair,
  toolActivityGroupKey,
} from "./tool-call-card";

const CONTENT_PADDING_X = 1;

type UpdatableComponent = Component & { setText(text: string): void };

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
      this.addChild(new BottomPaddedMarkdown("No transcript yet."));
    }
    for (const item of timeline) {
      this.addChild(this.renderEntry(item));
    }
    const cards = inlineCards(snapshot);
    if (cards.length > 0) {
      this.addChild(new BottomPaddedMarkdown(cards.join("\n\n")));
    }
  }

  private renderEntry(entry: ChatLogEntry): Component {
    const rendererKey = entryRendererKey(entry);
    const rendered = this.renderedEntries.get(entry.key);
    if (rendered && rendered.rendererKey === rendererKey) {
      if (entry.kind === "message") {
        rendered.messageComponent?.setMessage(entry.message);
      } else if (rendered.content !== entry.content) {
        rendered.textComponent?.setText(entry.content);
        rendered.content = entry.content;
      }
      return rendered.component;
    }

    if (entry.kind === "message") {
      const component = new TranscriptMessageComponent(entry.message);
      this.renderedEntries.set(entry.key, {
        component,
        messageComponent: component,
        rendererKey,
      });
      return component;
    }

    const component = new BottomPaddedText(entry.content);
    this.renderedEntries.set(entry.key, {
      component,
      content: entry.content,
      rendererKey,
      textComponent: component,
    });
    return component;
  }
}

class TranscriptMessageComponent implements Component {
  private readonly renderedBlocks = new Map<string, RenderedBlock>();

  constructor(private message: RenderableMessage) {}

  setMessage(message: RenderableMessage): void {
    this.message = message;
  }

  invalidate(): void {
    for (const block of this.renderedBlocks.values()) {
      block.component.invalidate?.();
    }
  }

  render(width: number): string[] {
    if (this.message.role === "user") {
      return withBottomPadding(this.renderUserMessage(width), width);
    }

    const activeKeys = new Set<string>();
    const lines: string[] = [];
    for (const block of this.message.blocks) {
      const content = renderableBlockText(block);
      if (content.length === 0) {
        continue;
      }
      const key = `${block.id}:${blockRendererKey(this.message, block)}`;
      activeKeys.add(key);
      const component = this.componentForBlock(key, block, content);
      lines.push(...component.render(width));
    }
    this.pruneInactiveBlocks(activeKeys);
    return withBottomPadding(lines, width);
  }

  private renderUserMessage(width: number): string[] {
    const key = `user:${this.message.id}`;
    const content = renderableMessageText(this.message);
    const component = this.componentForKey(
      key,
      "user",
      content,
      () => new HighlightedUserMessage(content),
    );
    this.pruneInactiveBlocks(new Set([key]));
    return component.render(width);
  }

  private componentForBlock(
    key: string,
    block: RenderableBlock,
    content: string,
  ): UpdatableComponent {
    const rendererKey = blockRendererKey(this.message, block);
    return this.componentForKey(key, rendererKey, content, () =>
      createBlockComponent(rendererKey, content),
    );
  }

  private componentForKey(
    key: string,
    rendererKey: string,
    content: string,
    create: () => UpdatableComponent,
  ): UpdatableComponent {
    const rendered = this.renderedBlocks.get(key);
    if (rendered && rendered.rendererKey === rendererKey) {
      if (rendered.content !== content) {
        rendered.component.setText(content);
        rendered.content = content;
      }
      return rendered.component;
    }
    const component = create();
    this.renderedBlocks.set(key, { component, content, rendererKey });
    return component;
  }

  private pruneInactiveBlocks(activeKeys: Set<string>): void {
    for (const key of this.renderedBlocks.keys()) {
      if (!activeKeys.has(key)) {
        this.renderedBlocks.delete(key);
      }
    }
  }
}

class BottomPaddedText extends Text {
  constructor(text: string) {
    super(text, CONTENT_PADDING_X, 0);
  }

  render(width: number): string[] {
    return withBottomPadding(super.render(width), width);
  }
}

class BottomPaddedMarkdown extends Markdown {
  constructor(text: string) {
    super(text, CONTENT_PADDING_X, 0, markdownTheme);
  }

  render(width: number): string[] {
    return withBottomPadding(super.render(width), width);
  }
}

class HighlightedUserMessage implements Component {
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
    const contentWidth = Math.max(1, outerWidth - 3);
    const contentLines = wrapTextWithAnsi(
      safePlainText(this.text).replace(/\t/g, "   "),
      contentWidth,
    );
    const renderedLines = contentLines.length > 0 ? contentLines : [""];
    const lines = renderedLines.map(
      (line) => `${orange("▌")} ${orange(padToWidth(line, contentWidth))} `,
    );

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function createBlockComponent(rendererKey: string, content: string): UpdatableComponent {
  if (rendererKey === "streaming-markdown") {
    return new StreamingMarkdown(content, CONTENT_PADDING_X, 0);
  }
  if (rendererKey === "final-markdown") {
    return new SafeMarkdown(content, "final", CONTENT_PADDING_X, 0);
  }
  if (rendererKey === "tolerant-markdown") {
    return new SafeMarkdown(content, "tolerant", CONTENT_PADDING_X, 0);
  }
  return new PlainTranscriptText(content, CONTENT_PADDING_X, 0);
}

function withBottomPadding(lines: string[], width: number): string[] {
  return lines.length > 0 ? [...lines, " ".repeat(width)] : lines;
}

function blockRendererKey(message: RenderableMessage, block: RenderableBlock): string {
  if (block.type === "thinking") {
    return "thinking";
  }
  if (block.type !== "text") {
    return "plain";
  }
  if (message.role !== "assistant" && message.role !== "system") {
    return "plain";
  }
  if (message.state === "streaming") {
    return "streaming-markdown";
  }
  if (message.state === "error") {
    return "tolerant-markdown";
  }
  if (message.state === "complete") {
    return "final-markdown";
  }
  return "plain";
}

function padToWidth(line: string, width: number): string {
  const visible = visibleWidth(line);
  return `${line}${" ".repeat(Math.max(0, width - visible))}`;
}

export type ChatLogRenderMode =
  | "final-markdown"
  | "message"
  | "plain"
  | "streaming-markdown"
  | "tolerant-markdown";
export type ChatLogEntryVariant = "default" | "tool" | "user";

export type ChatLogEntry = MessageChatLogEntry | ToolChatLogEntry;

type MessageChatLogEntry = {
  content: string;
  key: string;
  kind: "message";
  message: RenderableMessage;
  mode: ChatLogRenderMode;
  variant: Exclude<ChatLogEntryVariant, "tool">;
};

type ToolChatLogEntry = {
  content: string;
  key: string;
  kind: "tool";
  mode: "plain";
  variant: "tool";
};

type SequencedChatLogEntry = ChatLogEntry & { seq: number };

type RenderedEntry = {
  component: Component;
  content?: string;
  messageComponent?: TranscriptMessageComponent;
  rendererKey: string;
  textComponent?: UpdatableComponent;
};

type RenderedBlock = {
  component: UpdatableComponent;
  content: string;
  rendererKey: string;
};

export function buildChatLogEntries(
  snapshot: SessionViewSnapshot,
  options: { verbosity: Verbosity; width: number; thinking?: ThinkingRenderMode },
): ChatLogEntry[] {
  const messages = assembleTranscript(snapshot.transcript, {
    thinking: options.thinking ?? "default",
  }).flatMap(messageEntries);
  const tools = buildToolEntries(buildToolPairs(snapshot.activity), options);
  return [...messages, ...tools]
    .filter((item) => item.content.length > 0)
    .sort((left, right) => left.seq - right.seq)
    .map(({ seq: _seq, ...entry }) => entry);
}

function messageEntries(message: RenderableMessage): SequencedChatLogEntry[] {
  if (message.role === "user") {
    return [
      {
        content: renderableMessageText(message),
        key: `msg:${message.id}`,
        kind: "message",
        message,
        mode: messageRenderMode(message.role, message.state),
        seq: message.seq,
        variant: "user",
      },
    ];
  }

  return message.blocks.map((block) => {
    const blockMessage: RenderableMessage = {
      ...message,
      blocks: [block],
    };
    return {
      content: renderableBlockText(block),
      key: `msg:${message.id}:block:${block.id}`,
      kind: "message",
      message: blockMessage,
      mode: blockRenderMode(message, block),
      seq: block.seq,
      variant: "default",
    };
  });
}

function blockRenderMode(message: RenderableMessage, block: RenderableBlock): ChatLogRenderMode {
  if (block.type !== "text") {
    return "plain";
  }
  return messageRenderMode(message.role, message.state);
}

function messageRenderMode(
  role: "user" | "assistant" | "system" | "unknown",
  state: string,
): ChatLogRenderMode {
  if (role === "user") {
    return "plain";
  }
  if ((role === "assistant" || role === "system") && state === "streaming") {
    return "streaming-markdown";
  }
  if ((role === "assistant" || role === "system") && state === "error") {
    return "tolerant-markdown";
  }
  if ((role === "assistant" || role === "system") && state === "complete") {
    return "final-markdown";
  }
  return "plain";
}

function entryRendererKey(entry: ChatLogEntry): string {
  if (entry.kind === "message") {
    return `message:${entry.message.role}`;
  }
  return `${entry.mode}:${entry.variant}`;
}

function buildToolEntries(
  pairs: ToolActivityPair[],
  options: { verbosity: Verbosity; width: number },
): Array<ToolChatLogEntry & { seq: number }> {
  const entries: Array<ToolChatLogEntry & { seq: number }> = [];
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
        kind: "tool",
        mode: "plain",
        variant: "tool",
        seq: toolPairSeq(pair),
        content: renderToolCallCard(pair, options),
      });
      continue;
    }
    entries.push({
      key: `tool-group:${toolPairId(group[0])}:${group.length}`,
      kind: "tool",
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
        `**Approval** ${safeMarkdownText(`${approval.provider}.${approval.action}`)}`,
        safeMarkdownText(approval.reason),
        approval.paramsPreview ? safeMarkdownText(approval.paramsPreview) : "",
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
        `**Task** ${safeMarkdownText(task.providerTaskId)}`,
        safeMarkdownText(task.message),
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
        ...snapshot.queue
          .slice(0, 3)
          .map((item) => `${item.position}. ${safeMarkdownText(item.summary)}`),
      ].join("\n"),
    );
  }
  return cards;
}

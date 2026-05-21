import { type Component, Container, Markdown, Text } from "@earendil-works/pi-tui";

import type { ActivityItem, SessionViewSnapshot } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";
import { assembleTranscript, type ThinkingRenderMode } from "../state/stream-assembler";
import { markdownTheme, userMessageOverlay } from "./theme";
import { renderToolCallCard, type ToolActivityPair } from "./tool-call-card";

const CONTENT_PADDING_X = 1;

export class ChatLog extends Container {
  private readonly renderedEntries = new Map<string, RenderedEntry>();

  update(
    snapshot: SessionViewSnapshot,
    options?: { verbosity?: Verbosity; thinking?: ThinkingRenderMode },
  ): void {
    const verbosity = options?.verbosity ?? "normal";
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
          ? new Text(entry.content, CONTENT_PADDING_X, 1, userMessageOverlay)
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

export type ChatLogRenderMode = "plain" | "markdown";
export type ChatLogEntryVariant = "default" | "user";

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
  const tools = buildToolPairs(snapshot.activity).map((pair) => ({
    key: `tool:${(pair.result ?? pair.call)?.toolUseId ?? (pair.result ?? pair.call)?.id ?? "unknown"}`,
    mode: "plain" as const,
    variant: "default" as const,
    seq: (pair.result ?? pair.call)?.seq ?? 0,
    content: renderToolCallCard(pair, {
      verbosity: options.verbosity,
      width: options.width,
    }),
  }));
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

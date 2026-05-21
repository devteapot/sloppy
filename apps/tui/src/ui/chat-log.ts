import { Container, Markdown } from "@earendil-works/pi-tui";

import type { ActivityItem, SessionViewSnapshot } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";
import { assembleTranscript } from "../state/stream-assembler";
import { markdownTheme } from "./theme";
import { renderToolCallCard, type ToolActivityPair } from "./tool-call-card";

export class ChatLog extends Container {
  update(snapshot: SessionViewSnapshot, options?: { verbosity?: Verbosity }): void {
    this.clear();
    const verbosity = options?.verbosity ?? "normal";
    const timeline = buildTimeline(snapshot, verbosity);
    if (timeline.length === 0) {
      this.addChild(new Markdown("No transcript yet.", 0, 0, markdownTheme));
    }
    for (const item of timeline) {
      this.addChild(new Markdown(item, 0, 1, markdownTheme));
    }
    const cards = inlineCards(snapshot);
    if (cards.length > 0) {
      this.addChild(new Markdown(cards.join("\n\n"), 0, 1, markdownTheme));
    }
  }
}

function buildTimeline(snapshot: SessionViewSnapshot, verbosity: Verbosity): string[] {
  const messages = assembleTranscript(snapshot.transcript).map((message) => {
    const label = message.role === "assistant" ? "assistant" : message.role;
    return {
      seq: message.seq,
      text: `**${label}>**\n\n${message.text || message.state}`,
    };
  });
  const tools = buildToolPairs(snapshot.activity).map((pair) => ({
    seq: (pair.result ?? pair.call)?.seq ?? 0,
    text: renderToolCallCard(pair, {
      verbosity,
      width: process.stdout.columns || 100,
    }),
  }));
  return [...messages, ...tools]
    .filter((item) => item.text.length > 0)
    .sort((left, right) => left.seq - right.seq)
    .map((item) => item.text);
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

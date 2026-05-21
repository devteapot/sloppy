import { Container, Markdown } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot } from "../backend/slop-types";
import { assembleTranscript } from "../state/stream-assembler";
import { markdownTheme } from "./theme";

export class ChatLog extends Container {
  update(snapshot: SessionViewSnapshot): void {
    this.clear();
    if (snapshot.transcript.length === 0) {
      this.addChild(new Markdown("No transcript yet.", 0, 0, markdownTheme));
    }
    for (const message of assembleTranscript(snapshot.transcript)) {
      const label = message.role === "assistant" ? "assistant" : message.role;
      this.addChild(
        new Markdown(`**${label}>**\n\n${message.text || message.state}`, 0, 1, markdownTheme),
      );
    }
    const cards = inlineCards(snapshot);
    if (cards.length > 0) {
      this.addChild(new Markdown(cards.join("\n\n"), 0, 1, markdownTheme));
    }
  }
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

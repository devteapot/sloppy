import type {
  AssistantContentBlock,
  ConversationMessage,
  MessageContentBlock,
  TextContentBlock,
  ToolResultContentBlock,
} from "../llm/types";
import type { TrailImage } from "./images";

type HistoryKind = "user" | "assistant" | "tool";

interface HistoryEntry extends ConversationMessage {
  kind: HistoryKind;
}

function truncateLargeResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.2));
  return `${head}\n\n...[middle truncated]...\n\n${tail}`;
}

function extractTextBlocks(content: AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export class ConversationHistory {
  private entries: HistoryEntry[] = [];
  private historyTurns: number;
  private toolResultMaxChars: number;

  constructor(options: { historyTurns: number; toolResultMaxChars: number }) {
    this.historyTurns = options.historyTurns;
    this.toolResultMaxChars = options.toolResultMaxChars;
  }

  addUserText(text: string): void {
    this.entries.push({
      role: "user",
      kind: "user",
      content: [{ type: "text", text }],
    });
  }

  addUserMessage(content: MessageContentBlock[]): void {
    this.entries.push({
      role: "user",
      kind: "user",
      content,
    });
  }

  addAssistantContent(content: AssistantContentBlock[]): void {
    this.entries.push({
      role: "assistant",
      kind: "assistant",
      content,
    });
  }

  addToolResults(blocks: ToolResultContentBlock[]): void {
    this.entries.push({
      role: "user",
      kind: "tool",
      content: blocks.map((block) => ({
        ...block,
        content: truncateLargeResult(block.content, this.toolResultMaxChars),
      })),
    });
  }

  buildRequestMessages(
    stateContext: string,
    trailImages?: ReadonlyArray<TrailImage>,
  ): ConversationMessage[] {
    const limited = this.limitToRecentTurns().map(({ kind: _kind, ...entry }) => entry);
    // Loaded registry images ride the trail message, each preceded by a
    // caption naming its /images node so the model can map pixels to the
    // lifecycle affordances. The trail is rebuilt per request, so these
    // blocks leave context as soon as the image is unloaded.
    const content: MessageContentBlock[] = [{ type: "text", text: stateContext }];
    for (const trailImage of trailImages ?? []) {
      content.push({ type: "text", text: trailImage.caption }, trailImage.image);
    }
    return [
      ...limited,
      {
        role: "user",
        content,
      },
    ];
  }

  latestAssistantText(): string {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (!entry) {
        continue;
      }

      if (entry.kind === "assistant") {
        return extractTextBlocks(entry.content as AssistantContentBlock[]);
      }
    }

    return "";
  }

  private limitToRecentTurns(): HistoryEntry[] {
    let seenTurns = 0;

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (!entry) {
        continue;
      }

      if (entry.kind === "user") {
        seenTurns += 1;
        if (seenTurns > this.historyTurns) {
          return this.entries.slice(index + 1);
        }
      }
    }

    return this.entries;
  }
}

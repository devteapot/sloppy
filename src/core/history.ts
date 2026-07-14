import type {
  AssistantContentBlock,
  ConversationMessage,
  MessageContentBlock,
  TextContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../llm/types";

type HistoryKind = "user" | "assistant" | "tool";

interface HistoryEntry extends ConversationMessage {
  kind: HistoryKind;
}

export const CANCELLED_TOOL_BATCH_RESULT = {
  content: "Tool execution cancelled before the suspended batch completed.",
  isError: true,
} as const;

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

/**
 * Provider-neutral conversation state that can outlive a concrete native
 * model adapter or Agent runtime instance.
 */
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

  addToolBatchResults(
    toolCalls: ToolUseContentBlock[],
    resolvedResults: ToolResultContentBlock[],
    unresolvedResult: Pick<ToolResultContentBlock, "content" | "isError">,
  ): void {
    const resolvedByToolUseId = new Map(
      resolvedResults.map((result) => [result.toolUseId, result]),
    );
    this.addToolResults(
      toolCalls.map(
        (toolCall): ToolResultContentBlock =>
          resolvedByToolUseId.get(toolCall.id) ?? {
            type: "tool_result",
            toolUseId: toolCall.id,
            ...unresolvedResult,
          },
      ),
    );
  }

  buildRequestMessages(stateContext: string): ConversationMessage[] {
    const limited = this.limitToRecentTurns().map(({ kind: _kind, ...entry }) => entry);
    return [
      ...limited,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: stateContext,
          },
        ],
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
    let firstIncludedTurnIndex = 0;

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (!entry) {
        continue;
      }

      if (entry.kind === "user") {
        seenTurns += 1;
        if (seenTurns > this.historyTurns) {
          return this.entries.slice(firstIncludedTurnIndex);
        }
        firstIncludedTurnIndex = index;
      }
    }

    return this.entries;
  }
}

import type {
  AssistantContentBlock,
  ConversationCompactionSnapshot,
  ConversationHistoryEntryKind,
  ConversationHistoryEntrySnapshot,
  ConversationHistorySnapshot,
  ConversationMessage,
  MessageContentBlock,
  TextContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../llm/types";

const HISTORY_SNAPSHOT_VERSION = 1;

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return structuredClone(message);
}

function cloneEntry(entry: ConversationHistoryEntrySnapshot): ConversationHistoryEntrySnapshot {
  return {
    kind: entry.kind,
    message: cloneMessage(entry.message),
  };
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
  private archive: ConversationHistoryEntrySnapshot[];
  private active: ConversationHistoryEntrySnapshot[];
  private compactions: ConversationCompactionSnapshot[];
  private readonly historyTurns: number;
  private readonly toolResultMaxChars: number;
  private readonly listeners = new Set<(snapshot: ConversationHistorySnapshot) => void>();

  constructor(options: {
    historyTurns: number;
    toolResultMaxChars: number;
    snapshot?: ConversationHistorySnapshot;
  }) {
    this.historyTurns = options.historyTurns;
    this.toolResultMaxChars = options.toolResultMaxChars;
    this.archive = options.snapshot?.archive.map(cloneEntry) ?? [];
    this.active = options.snapshot?.active.map(cloneEntry) ?? [];
    this.compactions = structuredClone(options.snapshot?.compactions ?? []);
  }

  subscribe(listener: (snapshot: ConversationHistorySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ConversationHistorySnapshot {
    return {
      version: HISTORY_SNAPSHOT_VERSION,
      archive: this.archive.map(cloneEntry),
      active: this.active.map(cloneEntry),
      compactions: structuredClone(this.compactions),
    };
  }

  activeEntries(): ConversationHistoryEntrySnapshot[] {
    return this.active.map(cloneEntry);
  }

  maxRecentTurns(): number {
    return this.historyTurns;
  }

  addUserText(text: string): void {
    this.addEntry("user", {
      role: "user",
      content: [{ type: "text", text }],
    });
  }

  addUserMessage(content: MessageContentBlock[]): void {
    this.addEntry("user", {
      role: "user",
      content,
    });
  }

  addAssistantContent(content: AssistantContentBlock[]): void {
    this.addEntry("assistant", {
      role: "assistant",
      content,
    });
  }

  addToolResults(blocks: ToolResultContentBlock[]): void {
    this.addEntry("tool", {
      role: "user",
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
    return [
      ...this.active.map((entry) => cloneMessage(entry.message)),
      {
        role: "user",
        content: [{ type: "text", text: stateContext }],
      } satisfies ConversationMessage,
    ];
  }

  buildPortableContext(maxChars = 64_000): string {
    const rendered = this.active.map(renderEntry).join("\n\n");
    if (rendered.length <= maxChars) {
      return rendered;
    }
    return `[Earlier active context omitted to fit the provider handoff.]\n\n${rendered.slice(-maxChars)}`;
  }

  realUserTurnCount(): number {
    return this.active.filter((entry) => entry.kind === "user").length;
  }

  replaceActiveWithSummary(options: {
    firstRetainedIndex: number;
    summary: string;
    compactedAt?: string;
  }): void {
    if (options.firstRetainedIndex <= 0 || options.firstRetainedIndex >= this.active.length) {
      throw new Error("Conversation compaction must retain a non-empty history suffix.");
    }
    const compactedAt = options.compactedAt ?? new Date().toISOString();
    const summaryEntry: ConversationHistoryEntrySnapshot = {
      kind: "summary",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "The conversation history before this point was compacted into the following summary:\n\n" +
              options.summary,
          },
        ],
      },
    };
    const retained = this.active.slice(options.firstRetainedIndex).map(cloneEntry);
    this.active = [summaryEntry, ...retained];
    this.compactions.push({
      compactedAt,
      summary: options.summary,
      archivedEntryCount: this.archive.length,
      retainedEntryCount: retained.length,
    });
    this.emit();
  }

  recoverInterruptedTurn(
    message = "The previous model turn was interrupted by a runtime restart and could not be resumed.",
  ): void {
    const resolvedToolUseIds = new Set(
      this.active.flatMap((entry) =>
        entry.message.content.flatMap((block) =>
          block.type === "tool_result" ? [block.toolUseId] : [],
        ),
      ),
    );
    const unresolvedToolUses = this.active.flatMap((entry) =>
      entry.message.content.flatMap((block) =>
        block.type === "tool_use" && !resolvedToolUseIds.has(block.id) ? [block] : [],
      ),
    );
    if (unresolvedToolUses.length > 0) {
      this.addToolResults(
        unresolvedToolUses.map((block) => ({
          type: "tool_result",
          toolUseId: block.id,
          content: "The runtime restarted before this tool call produced a result.",
          isError: true,
        })),
      );
    }
    this.addUserText(`[Runtime recovery]\n${message}`);
  }

  latestAssistantText(): string {
    for (let index = this.archive.length - 1; index >= 0; index -= 1) {
      const entry = this.archive[index];
      if (entry?.kind === "assistant") {
        return extractTextBlocks(entry.message.content as AssistantContentBlock[]);
      }
    }
    return "";
  }

  private addEntry(kind: ConversationHistoryEntryKind, message: ConversationMessage): void {
    const entry = {
      kind,
      message: cloneMessage(message),
    } satisfies ConversationHistoryEntrySnapshot;
    this.archive.push(entry);
    this.active.push(cloneEntry(entry));
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function renderEntry(entry: ConversationHistoryEntrySnapshot): string {
  const blocks = entry.message.content.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "image":
        return `[image ${block.mediaType}, ${block.data.length} base64 characters]`;
      case "tool_use":
        return `[tool call ${block.name} id=${block.id}] ${JSON.stringify(block.input)}`;
      case "tool_result":
        return `[tool result id=${block.toolUseId}${block.isError ? " error" : ""}] ${block.content}`;
      case "provider_continuation":
        return `[opaque provider continuation purpose=${block.purpose} protocol=${block.issuer.protocol} provider=${block.issuer.provider} model=${block.issuer.model}]`;
      default:
        return "";
    }
  });
  return `${entry.kind.toUpperCase()} (${entry.message.role}):\n${blocks.join("\n")}`;
}

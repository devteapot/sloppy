import type { TranscriptMessage, TranscriptTextBlock, TranscriptThinkingBlock } from "../types";
import { buildId, nextSeq, now, updateTurnPhase } from "./helpers";
import type { SessionStoreState } from "./state";

const DEFAULT_THINKING_SOURCE_KEY = "__default_thinking_source__";

export function getOrCreateAssistantMessage(
  state: SessionStoreState,
  turnId: string,
  createdAt: string,
): TranscriptMessage {
  const existing =
    state.activeAssistantMessageId === null
      ? undefined
      : state.snapshot.transcript.find((entry) => entry.id === state.activeAssistantMessageId);
  if (existing) {
    return existing;
  }

  const messageSeq = nextSeq(state);
  const message: TranscriptMessage = {
    id: buildId("msg"),
    seq: messageSeq,
    role: "assistant",
    state: "streaming",
    turnId,
    createdAt,
    author: state.snapshot.session.model,
    content: [
      {
        id: buildId("block"),
        seq: messageSeq,
        type: "text",
        mime: "text/plain",
        text: "",
      },
    ],
  };
  state.snapshot.transcript.push(message);
  state.activeAssistantMessageId = message.id;
  return message;
}

function trailingTextBlock(message: TranscriptMessage): TranscriptTextBlock | undefined {
  const block = message.content.at(-1);
  return block?.type === "text" ? block : undefined;
}

function nextBlockSeq(state: SessionStoreState, message: TranscriptMessage): number {
  return message.content.length === 0 ? message.seq : nextSeq(state);
}

function findThinkingBlock(message: TranscriptMessage, blockId?: string) {
  return message.content.find(
    (block): block is TranscriptThinkingBlock =>
      block.type === "thinking" && (blockId === undefined || block.id === blockId),
  );
}

function hasContentAfter(message: TranscriptMessage, blockId: string): boolean {
  const index = message.content.findIndex((block) => block.id === blockId);
  return index >= 0 && index < message.content.length - 1;
}

function hasTimelineEventAfter(
  state: SessionStoreState,
  message: TranscriptMessage,
  block: TranscriptTextBlock | TranscriptThinkingBlock,
): boolean {
  if (block.seq === undefined) {
    return hasContentAfter(message, block.id);
  }
  const blockSeq = block.seq;
  return (
    hasContentAfter(message, block.id) ||
    state.snapshot.activity.some((item) => item.seq > blockSeq)
  );
}

function hasBlockId(message: TranscriptMessage, blockId: string): boolean {
  return message.content.some((block) => block.id === blockId);
}

function thinkingSourceKey(blockId?: string): string {
  return blockId ?? DEFAULT_THINKING_SOURCE_KEY;
}

function nextThinkingBlockId(message: TranscriptMessage, sourceBlockId?: string): string {
  if (sourceBlockId && !hasBlockId(message, sourceBlockId)) {
    return sourceBlockId;
  }

  let blockId = buildId("block");
  while (hasBlockId(message, blockId)) {
    blockId = buildId("block");
  }
  return blockId;
}

function activeThinkingBlock(
  state: SessionStoreState,
  message: TranscriptMessage,
  sourceKey: string,
  sourceBlockId?: string,
): TranscriptThinkingBlock | undefined {
  const activeId = state.activeThinkingBlockIds.get(sourceKey);
  if (activeId) {
    const active = findThinkingBlock(message, activeId);
    if (active) {
      return active;
    }
  }
  return sourceBlockId ? findThinkingBlock(message, sourceBlockId) : undefined;
}

export function appendAssistantText(
  state: SessionStoreState,
  turnId: string,
  chunk: string,
): boolean {
  if (!chunk) {
    return false;
  }

  const time = now();
  let message =
    state.activeAssistantMessageId === null
      ? undefined
      : state.snapshot.transcript.find((entry) => entry.id === state.activeAssistantMessageId);

  if (!message) {
    const messageSeq = nextSeq(state);
    message = {
      id: buildId("msg"),
      seq: messageSeq,
      role: "assistant",
      state: "streaming",
      turnId,
      createdAt: time,
      author: state.snapshot.session.model,
      content: [
        {
          id: buildId("block"),
          seq: messageSeq,
          type: "text",
          mime: "text/plain",
          text: chunk,
        },
      ],
    };
    state.snapshot.transcript.push(message);
    state.activeAssistantMessageId = message.id;
  } else {
    const textBlock = trailingTextBlock(message);
    if (!textBlock || hasTimelineEventAfter(state, message, textBlock)) {
      message.content.push({
        id: buildId("block"),
        seq: nextBlockSeq(state, message),
        type: "text",
        mime: "text/plain",
        text: chunk,
      });
    } else {
      textBlock.text += chunk;
    }
    message.state = "streaming";
    message.error = undefined;
  }

  updateTurnPhase(state, "model", "Generating response", "model", time);
  state.turnChanged = true;
  state.transcriptChanged = true;
  return true;
}

export function appendAssistantThinking(
  state: SessionStoreState,
  turnId: string,
  options: {
    blockId?: string;
    provider?: string;
    model?: string;
    format: "raw" | "summary";
    display: "visible" | "hidden";
    delta?: string;
    text?: string;
    startedAt?: string;
    completedAt?: string;
    elapsedMs?: number;
    tokenCount?: number;
    tokenCountSource?: "reported" | "unavailable";
    done?: boolean;
  },
): boolean {
  const delta = options.delta ?? "";
  const replacement = options.text;
  if (!delta && replacement === undefined && !options.done) {
    return false;
  }

  const time = now();
  let message =
    state.activeAssistantMessageId === null
      ? undefined
      : state.snapshot.transcript.find((entry) => entry.id === state.activeAssistantMessageId);

  if (!message) {
    const messageSeq = nextSeq(state);
    message = {
      id: buildId("msg"),
      seq: messageSeq,
      role: "assistant",
      state: "streaming",
      turnId,
      createdAt: options.startedAt ?? time,
      author: state.snapshot.session.model,
      content: [],
    };
    state.snapshot.transcript.push(message);
    state.activeAssistantMessageId = message.id;
  }

  const sourceKey = thinkingSourceKey(options.blockId);
  let block = activeThinkingBlock(state, message, sourceKey, options.blockId);
  if (block && !options.done && hasTimelineEventAfter(state, message, block)) {
    block = undefined;
  }

  if (!block) {
    block = {
      id: nextThinkingBlockId(message, options.blockId),
      seq: nextBlockSeq(state, message),
      type: "thinking",
      mime: "text/plain",
      text: "",
      format: options.format,
      display: options.display,
      provider: options.provider,
      model: options.model,
      startedAt: options.startedAt ?? time,
      tokenCountSource: options.tokenCount === undefined ? undefined : "reported",
    };
    message.content.push(block);
    state.activeThinkingBlockIds.set(sourceKey, block.id);
  } else {
    state.activeThinkingBlockIds.set(sourceKey, block.id);
  }

  block.format = options.format;
  block.display = options.display;
  block.provider = options.provider ?? block.provider;
  block.model = options.model ?? block.model;
  block.startedAt = options.startedAt ?? block.startedAt;
  if (replacement !== undefined) {
    block.text = replacement;
  } else {
    block.text += delta;
  }
  block.completedAt = options.completedAt ?? block.completedAt;
  block.elapsedMs = options.elapsedMs ?? block.elapsedMs;
  block.tokenCount = options.tokenCount ?? block.tokenCount;
  block.tokenCountSource =
    options.tokenCountSource ??
    (options.tokenCount === undefined ? block.tokenCountSource : "reported");
  message.state = "streaming";
  message.error = undefined;

  updateTurnPhase(state, "model", "Thinking", "model", time);
  state.turnChanged = true;
  state.transcriptChanged = true;
  return true;
}

export function appendAssistantMedia(
  state: SessionStoreState,
  turnId: string,
  options: {
    mime: string;
    name?: string;
    uri?: string;
    summary?: string;
    preview?: string;
  },
): void {
  const time = now();
  let message =
    state.activeAssistantMessageId === null
      ? undefined
      : state.snapshot.transcript.find((entry) => entry.id === state.activeAssistantMessageId);

  if (!message) {
    const messageSeq = nextSeq(state);
    message = {
      id: buildId("msg"),
      seq: messageSeq,
      role: "assistant",
      state: "complete",
      turnId,
      createdAt: time,
      author: state.snapshot.session.model,
      content: [
        {
          id: buildId("block"),
          seq: messageSeq,
          type: "media",
          mime: options.mime,
          name: options.name,
          uri: options.uri,
          summary: options.summary,
          preview: options.preview,
        },
      ],
    };
    state.snapshot.transcript.push(message);
    state.activeAssistantMessageId = message.id;
  } else {
    message.content.push({
      id: buildId("block"),
      seq: nextBlockSeq(state, message),
      type: "media",
      mime: options.mime,
      name: options.name,
      uri: options.uri,
      summary: options.summary,
      preview: options.preview,
    });
    message.state = "complete";
    message.error = undefined;
  }

  updateTurnPhase(state, "model", "Generating response", "model", time);
  state.turnChanged = true;
  state.transcriptChanged = true;
}

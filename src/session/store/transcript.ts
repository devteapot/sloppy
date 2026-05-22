import type { TranscriptMessage, TranscriptThinkingBlock } from "../types";
import { buildId, nextSeq, now, updateTurnPhase } from "./helpers";
import type { SessionStoreState } from "./state";

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

  const message: TranscriptMessage = {
    id: buildId("msg"),
    seq: nextSeq(state),
    role: "assistant",
    state: "streaming",
    turnId,
    createdAt,
    author: state.snapshot.session.model,
    content: [
      {
        id: buildId("block"),
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

function findTextBlock(message: TranscriptMessage) {
  return message.content.find((block) => block.type === "text");
}

function findThinkingBlock(message: TranscriptMessage, blockId?: string) {
  return message.content.find(
    (block): block is TranscriptThinkingBlock =>
      block.type === "thinking" && (blockId === undefined || block.id === blockId),
  );
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
    message = {
      id: buildId("msg"),
      seq: nextSeq(state),
      role: "assistant",
      state: "streaming",
      turnId,
      createdAt: time,
      author: state.snapshot.session.model,
      content: [
        {
          id: buildId("block"),
          type: "text",
          mime: "text/plain",
          text: chunk,
        },
      ],
    };
    state.snapshot.transcript.push(message);
    state.activeAssistantMessageId = message.id;
  } else {
    const textBlock = findTextBlock(message);
    if (!textBlock) {
      message.content.push({
        id: buildId("block"),
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
    message = {
      id: buildId("msg"),
      seq: nextSeq(state),
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

  let block = findThinkingBlock(message, options.blockId);
  if (!block) {
    block = {
      id: options.blockId ?? buildId("block"),
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
    const firstTextIndex = message.content.findIndex((candidate) => candidate.type === "text");
    if (firstTextIndex === -1) {
      message.content.push(block);
    } else {
      message.content.splice(firstTextIndex, 0, block);
    }
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
    message = {
      id: buildId("msg"),
      seq: nextSeq(state),
      role: "assistant",
      state: "complete",
      turnId,
      createdAt: time,
      author: state.snapshot.session.model,
      content: [
        {
          id: buildId("block"),
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

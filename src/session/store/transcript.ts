import type { TranscriptMessage } from "../types";
import { buildId, now, updateTurnPhase } from "./helpers";
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
    const [firstBlock] = message.content;
    if (!firstBlock) {
      message.content.push({
        id: buildId("block"),
        type: "text",
        mime: "text/plain",
        text: chunk,
      });
    } else if (firstBlock.type === "text") {
      firstBlock.text += chunk;
    } else {
      message.content.push({
        id: buildId("block"),
        type: "text",
        mime: "text/plain",
        text: chunk,
      });
    }
    message.state = "streaming";
    message.error = undefined;
  }

  updateTurnPhase(state, "model", "Generating response", "model", time);
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

import type { QueuedSessionMessage } from "../types";
import { buildId, now } from "./helpers";
import type { SessionStoreState } from "./state";

export function enqueueMessage(state: SessionStoreState, text: string): QueuedSessionMessage {
  const time = now();
  const message: QueuedSessionMessage = {
    id: buildId("queued"),
    status: "queued",
    text,
    createdAt: time,
    author: "user",
  };
  state.snapshot.queue.push(message);
  state.snapshot.session.lastActivityAt = time;
  state.queueChanged = true;
  state.sessionChanged = true;
  return { ...message };
}

export function dequeueMessage(state: SessionStoreState): QueuedSessionMessage | undefined {
  const message = state.snapshot.queue.shift();
  if (!message) {
    return undefined;
  }
  const time = now();
  state.snapshot.session.lastActivityAt = time;
  state.queueChanged = true;
  state.sessionChanged = true;
  return { ...message };
}

export function removeQueuedMessage(
  state: SessionStoreState,
  queuedMessageId: string,
): QueuedSessionMessage {
  const index = state.snapshot.queue.findIndex((message) => message.id === queuedMessageId);
  if (index === -1) {
    throw new Error(`Unknown queued message: ${queuedMessageId}`);
  }
  const [message] = state.snapshot.queue.splice(index, 1);
  if (!message) {
    throw new Error(`Unknown queued message: ${queuedMessageId}`);
  }
  const time = now();
  state.snapshot.session.lastActivityAt = time;
  state.queueChanged = true;
  state.sessionChanged = true;
  return { ...message };
}

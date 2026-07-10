// Generic streaming helpers for speech protocol adapters. Protocol bindings
// (wire formats, framing, auth) live in plugins; these are the protocol-neutral
// building blocks they compose so every adapter doesn't re-implement WebSocket
// lifecycle and chunk-queue plumbing.

import { SpeechError, type WebSocketLike } from "./types";

const WS_OPEN = 1;

/** Resolve once the socket is open; reject on close/error/abort before then. */
export function waitForOpen(socket: WebSocketLike, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    socket.close();
    return Promise.reject(new SpeechError("WebSocket connection was cancelled."));
  }
  if (socket.readyState === WS_OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new SpeechError(`WebSocket closed before opening (${event.code}).`));
    };
    const onError = () => {
      cleanup();
      reject(new SpeechError("WebSocket failed to open."));
    };
    const onAbort = () => {
      cleanup();
      socket.close();
      reject(new SpeechError("WebSocket connection was cancelled."));
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Single-shot emitter guard: the first call passes through, the rest are
 * no-ops. Backs the contract guarantee that a session emits `closed` exactly
 * once regardless of how it dies (local close, remote close, transport error).
 */
export function once<E>(emit: (event: E) => void): (event: E) => void {
  let emitted = false;
  return (event: E) => {
    if (emitted) {
      return;
    }
    emitted = true;
    emit(event);
  };
}

/** Single-consumer async chunk queue backing TtsStream.chunks(). */
export class AsyncChunkQueue implements AsyncIterable<Uint8Array> {
  private readonly buffered: Uint8Array[] = [];
  private done = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    if (this.done) {
      return;
    }
    this.buffered.push(chunk);
    this.wake?.();
  }

  close(options?: { discard?: boolean }): void {
    if (options?.discard) {
      this.buffered.length = 0;
    }
    this.done = true;
    this.wake?.();
  }

  fail(error: Error): void {
    if (this.done) {
      return;
    }
    this.error = error;
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const chunk = this.buffered.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (this.done) {
        if (this.error) {
          throw this.error;
        }
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

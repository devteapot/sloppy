/**
 * Scriptable WebSocket double for speech adapter tests. Opens asynchronously
 * (microtask) like a real socket; tests drive server behavior via
 * emitMessage/emitError/close and inspect client traffic via `sent`.
 */
export class FakeWebSocket {
  static latest?: FakeWebSocket;

  readyState = 0;
  readonly sent: string[] = [];
  readonly url: string;
  readonly options: unknown;
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
    FakeWebSocket.latest = this;
    queueMicrotask(() => this.open());
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }

  /** Simulate the server closing the connection (e.g. service restart). */
  serverClose(code = 1006, reason?: string): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  emitMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  emitRaw(data: string): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error", {});
  }

  /** Parsed client → server messages, for golden assertions. */
  sentJson(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

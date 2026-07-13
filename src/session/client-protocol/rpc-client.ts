import { z } from "zod";

import { createJsonClientTransport, type JsonClientTransport } from "./transport";
import type { ClientRequest, ClientServerMessage } from "./types";

const serverMessageSchema = z
  .object({ type: z.enum(["hello", "snapshot", "response"]) })
  .passthrough();

export class ClientProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class RpcSnapshotClient<TSnapshot> {
  private transport: JsonClientTransport | null = null;
  private snapshot: TSnapshot | null = null;
  private revision = 0;
  private readonly listeners = new Set<(snapshot: TSnapshot) => void>();
  private readonly disconnectListeners = new Set<(error?: Error) => void>();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private helloResolve: ((snapshot: TSnapshot) => void) | null = null;
  private helloReject: ((error: Error) => void) | null = null;

  constructor(
    private endpoint: string,
    private readonly protocol: string,
  ) {}

  async connect(timeoutMs = 5_000): Promise<TSnapshot> {
    if (this.transport) {
      if (this.snapshot) return this.snapshot;
      throw new Error("Client protocol connection is already in progress.");
    }
    const transport = createJsonClientTransport(this.endpoint);
    this.transport = transport;
    const hello = new Promise<TSnapshot>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    await transport.connect({
      message: (message) => this.handleMessage(message),
      close: (error) => this.handleClose(error),
    });
    const timer = setTimeout(() => {
      this.helloReject?.(new Error(`Timed out waiting for ${this.protocol} hello.`));
      this.disconnect();
    }, timeoutMs);
    try {
      return await hello;
    } catch (error) {
      this.disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
      this.helloResolve = null;
      this.helloReject = null;
    }
  }

  setEndpoint(endpoint: string): void {
    this.disconnect();
    this.endpoint = endpoint;
  }

  getSnapshot(): TSnapshot | null {
    return this.snapshot;
  }

  onSnapshot(listener: (snapshot: TSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.transport) {
      return Promise.reject(new Error(`${this.protocol} client is not connected.`));
    }
    const id = crypto.randomUUID();
    const request: ClientRequest = { type: "request", id, method, ...(params && { params }) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.transport?.send(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(): void {
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.rejectPending(new Error(`${this.protocol} client disconnected.`));
  }

  private handleMessage(input: unknown): void {
    const envelope = serverMessageSchema.safeParse(input);
    if (!envelope.success) {
      this.handleClose(new Error(`Invalid ${this.protocol} server envelope.`));
      return;
    }
    const message = input as ClientServerMessage<TSnapshot>;
    if (message.type === "hello") {
      if (message.protocol !== this.protocol || message.version !== 1) {
        this.helloReject?.(
          new Error(
            `Unsupported client protocol ${message.protocol}@${message.version}; expected ${this.protocol}@1.`,
          ),
        );
        return;
      }
      this.revision = message.revision;
      this.publishSnapshot(message.snapshot);
      this.helloResolve?.(message.snapshot);
      return;
    }
    if (message.type === "snapshot") {
      if (message.revision <= this.revision) return;
      this.revision = message.revision;
      this.publishSnapshot(message.snapshot);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new ClientProtocolError(message.error.message, message.error.code));
    }
  }

  private publishSnapshot(snapshot: TSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private handleClose(error?: Error): void {
    if (!this.transport) return;
    this.transport = null;
    const reason = error ?? new Error(`${this.protocol} connection closed.`);
    this.helloReject?.(reason);
    this.rejectPending(reason);
    for (const listener of this.disconnectListeners) listener(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

import { z } from "zod";
import { applySnapshotPatch } from "./snapshot-patch";
import { createJsonClientTransport, type JsonClientTransport } from "./transport";
import { CLIENT_PROTOCOL_VERSION, type ClientRequest } from "./types";

const serverMessageTypeSchema = z.object({
  type: z.enum(["hello", "snapshot", "patch", "response"]),
});

const helloMessageSchema = z
  .object({
    type: z.literal("hello"),
    protocol: z.string(),
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    snapshot: z.unknown(),
  })
  .strict()
  .refine((message) => Object.hasOwn(message, "snapshot"));

const snapshotMessageSchema = z
  .object({
    type: z.literal("snapshot"),
    revision: z.number().int().nonnegative(),
    snapshot: z.unknown(),
  })
  .strict()
  .refine((message) => Object.hasOwn(message, "snapshot"));

const patchMessageSchema = z.object({
  type: z.literal("patch"),
  revision: z.number().int().nonnegative(),
  operations: z.array(
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("set"),
        path: z.array(z.union([z.string(), z.number().int()])),
        value: z.unknown(),
      }),
      z.object({
        op: z.literal("delete"),
        path: z.array(z.union([z.string(), z.number().int()])),
      }),
      z.object({
        op: z.literal("append"),
        path: z.array(z.union([z.string(), z.number().int()])),
        value: z.string(),
      }),
    ]),
  ),
});

const responseMessageSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("response"),
      id: z.string(),
      ok: z.literal(true),
      result: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("response"),
      id: z.string(),
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);

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
    // A dial failure can occur before connect() begins awaiting hello. Keep the
    // rejection handled while preserving the original promise for that await.
    void hello.catch(() => {});
    const timer = setTimeout(() => {
      this.helloReject?.(new Error(`Timed out waiting for ${this.protocol} hello.`));
      this.disconnect();
    }, timeoutMs);
    try {
      await transport.connect({
        message: (message) => this.handleMessage(message),
        close: (error) => this.handleClose(error),
      });
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
    const reason = new Error(`${this.protocol} client disconnected.`);
    this.helloReject?.(reason);
    transport?.close();
    this.rejectPending(reason);
  }

  private handleMessage(input: unknown): void {
    const envelope = serverMessageTypeSchema.safeParse(input);
    if (!envelope.success) {
      this.handleClose(new Error(`Invalid ${this.protocol} server envelope.`));
      return;
    }
    if (envelope.data.type === "hello") {
      const hello = helloMessageSchema.safeParse(input);
      if (!hello.success) {
        this.handleClose(new Error(`Invalid ${this.protocol} hello message.`));
        return;
      }
      const message = hello.data;
      if (message.protocol !== this.protocol || message.version !== CLIENT_PROTOCOL_VERSION) {
        this.helloReject?.(
          new Error(
            `Unsupported client protocol ${message.protocol}@${message.version}; expected ${this.protocol}@${CLIENT_PROTOCOL_VERSION}.`,
          ),
        );
        return;
      }
      this.revision = message.revision;
      this.publishSnapshot(message.snapshot as TSnapshot);
      this.helloResolve?.(message.snapshot as TSnapshot);
      return;
    }
    if (envelope.data.type === "snapshot") {
      const update = snapshotMessageSchema.safeParse(input);
      if (!update.success) {
        this.handleClose(new Error(`Invalid ${this.protocol} snapshot message.`));
        return;
      }
      const message = update.data;
      if (message.revision <= this.revision) return;
      this.revision = message.revision;
      this.publishSnapshot(message.snapshot as TSnapshot);
      return;
    }
    if (envelope.data.type === "patch") {
      const patch = patchMessageSchema.safeParse(input);
      if (!patch.success || !this.snapshot) {
        this.handleClose(new Error(`Invalid ${this.protocol} snapshot patch.`));
        return;
      }
      if (patch.data.revision <= this.revision) return;
      try {
        const snapshot = applySnapshotPatch(this.snapshot, patch.data.operations);
        this.revision = patch.data.revision;
        this.publishSnapshot(snapshot);
      } catch (error) {
        this.handleClose(
          new Error(
            `Invalid ${this.protocol} snapshot patch: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      return;
    }
    const response = responseMessageSchema.safeParse(input);
    if (!response.success) {
      this.handleClose(new Error(`Invalid ${this.protocol} response message.`));
      return;
    }
    const message = response.data;
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
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn(
          `[sloppy] ${this.protocol} snapshot listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private handleClose(error?: Error): void {
    const transport = this.transport;
    if (!transport) return;
    this.transport = null;
    transport.close();
    const reason = error ?? new Error(`${this.protocol} connection closed.`);
    this.helloReject?.(reason);
    this.rejectPending(reason);
    for (const listener of this.disconnectListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        console.warn(
          `[sloppy] ${this.protocol} disconnect listener failed: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
        );
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

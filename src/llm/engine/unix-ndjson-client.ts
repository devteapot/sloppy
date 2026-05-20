import { AsyncQueue } from "./async-queue";
import type {
  EngineDescriptor,
  EngineEvent,
  EngineGenerateOptions,
  EnginePromptPrefix,
  EngineSyncResult,
  EngineWireEvent,
  EngineWireMessage,
  EngineWireMethod,
  EngineWireResponse,
} from "./protocol";

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  events?: AsyncQueue<EngineEvent>;
};

export class EngineProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "engine_error",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "EngineProtocolError";
  }
}

export class UnixNdjsonEngineClient {
  private socket: Bun.Socket<{ onMessage: (data: Uint8Array) => void }> | null = null;
  private connectPromise: Promise<void> | null = null;
  private decoder = new TextDecoder();
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(private readonly socketPath: string) {}

  async describe(): Promise<EngineDescriptor> {
    return parseEngineDescriptor(await this.request("engine.describe"));
  }

  async createSession(
    options: {
      sessionId?: string;
      contextWindowTokens?: number;
      metadata?: Record<string, string>;
    } = {},
  ): Promise<{ sessionId: string }> {
    const result = await this.request("session.create", options);
    if (!isRecord(result) || typeof result.sessionId !== "string") {
      throw new EngineProtocolError("Engine returned an invalid session.create response.");
    }
    return { sessionId: result.sessionId };
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.request("session.destroy", { sessionId });
  }

  async sync(
    sessionId: string,
    prefix: EnginePromptPrefix,
    options?: { allowRebuild?: boolean },
  ): Promise<EngineSyncResult> {
    return parseSyncResult(
      await this.request("session.sync", {
        sessionId,
        prefix,
        options,
      }),
      sessionId,
    );
  }

  async *generate(sessionId: string, options: EngineGenerateOptions): AsyncIterable<EngineEvent> {
    const events = await this.streamingRequest("session.generate", {
      sessionId,
      options,
    });

    for await (const event of events) {
      yield event;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request("session.interrupt", { sessionId });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket?.end();
    this.socket = null;
    this.rejectPending(new EngineProtocolError("Engine connection closed.", "engine_error", true));
  }

  private async request(
    method: EngineWireMethod,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.connect();
    const id = crypto.randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ type: "request", id, method, params });
    return result;
  }

  private async streamingRequest(
    method: EngineWireMethod,
    params?: Record<string, unknown>,
  ): Promise<AsyncQueue<EngineEvent>> {
    await this.connect();
    const id = crypto.randomUUID();
    const events = new AsyncQueue<EngineEvent>();
    const accepted = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, events });
    });
    this.send({ type: "request", id, method, params });
    await accepted;
    return events;
  }

  private send(message: EngineWireMessage): void {
    if (!this.socket || this.closed) {
      throw new EngineProtocolError("Engine connection is not open.", "engine_error", true);
    }
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      throw new EngineProtocolError("Engine client is closed.", "engine_error", true);
    }
    if (this.socket) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async openSocket(): Promise<void> {
    try {
      this.socket = await Bun.connect<{ onMessage: (data: Uint8Array) => void }>({
        unix: this.socketPath,
        data: {
          onMessage: (data) => this.handleData(data),
        },
        socket: {
          binaryType: "uint8array",
          data(socket, data) {
            socket.data.onMessage(data);
          },
          close: () => {
            this.socket = null;
            this.rejectPending(
              new EngineProtocolError("Engine connection closed.", "engine_error", true),
            );
          },
          error: (_socket, error) => {
            this.rejectPending(
              new EngineProtocolError(
                `Engine socket error: ${error instanceof Error ? error.message : String(error)}`,
                "engine_error",
                true,
              ),
            );
          },
        },
      });
    } catch (error) {
      throw new EngineProtocolError(
        `Unix engine connection failed: ${this.socketPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "engine_error",
        true,
      );
    }
  }

  private handleData(data: Uint8Array): void {
    this.buffer += this.decoder.decode(data, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        this.handleMessage(JSON.parse(line) as EngineWireMessage);
      } catch (error) {
        this.rejectPending(
          new EngineProtocolError(
            `Engine sent invalid NDJSON: ${error instanceof Error ? error.message : String(error)}`,
            "engine_error",
          ),
        );
      }
    }
  }

  private handleMessage(message: EngineWireMessage): void {
    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }

    if (message.type === "event") {
      this.handleEvent(message);
    }
  }

  private handleResponse(message: EngineWireResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    if (message.ok) {
      pending.resolve(message.result);
      if (!pending.events) {
        this.pending.delete(message.id);
      }
      return;
    }

    const error = new EngineProtocolError(
      message.error.message,
      message.error.code,
      message.error.retryable === true,
    );
    pending.reject(error);
    pending.events?.fail(error);
    this.pending.delete(message.id);
  }

  private handleEvent(message: EngineWireEvent): void {
    const pending = this.pending.get(message.id);
    if (!pending?.events) {
      return;
    }

    pending.events.push(message.event);
    if (message.event.type === "done") {
      pending.events.close();
      this.pending.delete(message.id);
    }
    if (message.event.type === "error") {
      pending.events.close();
      this.pending.delete(message.id);
    }
  }

  private rejectPending(error: unknown): void {
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      pending.events?.fail(error);
      this.pending.delete(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEngineDescriptor(value: unknown): EngineDescriptor {
  if (
    !isRecord(value) ||
    value.protocol !== "sloppy.engine" ||
    value.protocolVersion !== 1 ||
    typeof value.engine !== "string" ||
    !isRecord(value.model) ||
    typeof value.model.id !== "string" ||
    !isRecord(value.capabilities)
  ) {
    throw new EngineProtocolError("Engine returned an invalid descriptor.");
  }
  return value as EngineDescriptor;
}

function parseSyncResult(value: unknown, fallbackSessionId: string): EngineSyncResult {
  if (!isRecord(value)) {
    return { sessionId: fallbackSessionId };
  }

  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : fallbackSessionId,
    position: typeof value.position === "number" ? value.position : undefined,
    contextWindowTokens:
      typeof value.contextWindowTokens === "number" ? value.contextWindowTokens : undefined,
    cachedPrefixTokens:
      typeof value.cachedPrefixTokens === "number" ? value.cachedPrefixTokens : undefined,
    evaluatedTokens: typeof value.evaluatedTokens === "number" ? value.evaluatedTokens : undefined,
    rebuilt: typeof value.rebuilt === "boolean" ? value.rebuilt : undefined,
    promptHash: typeof value.promptHash === "string" ? value.promptHash : undefined,
  };
}

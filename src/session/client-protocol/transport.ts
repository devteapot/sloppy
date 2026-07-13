import { createConnection, type Socket } from "node:net";

export type JsonTransportHandlers = {
  message: (message: unknown) => void;
  close: (error?: Error) => void;
};

export interface JsonClientTransport {
  connect(handlers: JsonTransportHandlers): Promise<void>;
  send(message: unknown): void;
  close(): void;
}

export class UnixJsonClientTransport implements JsonClientTransport {
  private socket: Socket | null = null;
  private buffer = "";

  constructor(private readonly socketPath: string) {}

  connect(handlers: JsonTransportHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failedBeforeConnect = false;
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        settled = true;
        resolve();
      });
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handlers.message(JSON.parse(line));
          } catch (error) {
            handlers.close(
              new Error(
                `Invalid session client protocol message: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        }
      });
      socket.once("error", (error) => {
        if (!settled) {
          failedBeforeConnect = true;
          reject(error);
          return;
        }
        handlers.close(error);
      });
      socket.once("close", () => {
        if (!failedBeforeConnect) handlers.close();
      });
    });
  }

  send(message: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Session client transport is not connected.");
    }
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

export class WebSocketJsonClientTransport implements JsonClientTransport {
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {}

  connect(handlers: JsonTransportHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failedBeforeConnect = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        settled = true;
        resolve();
      });
      socket.addEventListener("message", (event) => {
        try {
          const text =
            typeof event.data === "string"
              ? event.data
              : event.data instanceof ArrayBuffer
                ? new TextDecoder().decode(event.data)
                : String(event.data);
          handlers.message(JSON.parse(text));
        } catch (error) {
          handlers.close(
            new Error(
              `Invalid session client protocol message: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      });
      socket.addEventListener("error", () => {
        const error = new Error(`WebSocket connection failed: ${this.url}`);
        if (!settled) {
          failedBeforeConnect = true;
          reject(error);
          return;
        }
        handlers.close(error);
      });
      socket.addEventListener("close", () => {
        if (!failedBeforeConnect) handlers.close();
      });
    });
  }

  send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Session client WebSocket is not connected.");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

export function createJsonClientTransport(endpoint: string): JsonClientTransport {
  return endpoint.startsWith("ws://") || endpoint.startsWith("wss://")
    ? new WebSocketJsonClientTransport(endpoint)
    : new UnixJsonClientTransport(endpoint);
}

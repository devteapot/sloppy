import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type {
  ClientTransport,
  Connection,
  MessageHandler,
  SlopMessage,
} from "@slop-ai/consumer/browser";

export class NodeSocketClientTransport implements ClientTransport {
  constructor(private socketPath: string) {}

  async connect(): Promise<Connection> {
    const socket = await this.connectSocket();
    const messageHandlers: MessageHandler[] = [];
    const closeHandlers: Array<() => void> = [];
    const reader = createInterface({ input: socket });

    reader.on("line", (line) => {
      if (!line) {
        return;
      }

      try {
        const message = JSON.parse(line) as SlopMessage;
        for (const handler of messageHandlers) {
          handler(message);
        }
      } catch (error) {
        console.warn("[sloppy] failed to parse unix socket message:", error);
      }
    });

    socket.on("close", () => {
      reader.close();
      for (const handler of closeHandlers) {
        handler();
      }
    });

    return {
      send(message: SlopMessage) {
        socket.write(`${JSON.stringify(message)}\n`);
      },
      onMessage(handler: MessageHandler) {
        messageHandlers.push(handler);
      },
      onClose(handler: () => void) {
        closeHandlers.push(handler);
      },
      close() {
        reader.close();
        socket.end();
      },
    } satisfies Connection;
  }

  private connectSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error) => {
        reject(new Error(`Unix socket connection failed: ${this.socketPath}: ${error.message}`));
      });
    });
  }
}

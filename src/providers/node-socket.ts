import type {
  ClientTransport,
  Connection,
  MessageHandler,
  SlopMessage,
} from "@slop-ai/consumer/browser";

export class NodeSocketClientTransport implements ClientTransport {
  constructor(private socketPath: string) {}

  async connect(): Promise<Connection> {
    const messageHandlers: MessageHandler[] = [];
    const closeHandlers: Array<() => void> = [];
    const decoder = new TextDecoder();
    let buffer = "";
    let closed = false;
    const socket = await this.connectSocket(() => {
      if (closed) {
        return;
      }

      closed = true;
      for (const handler of closeHandlers) {
        handler();
      }
    });

    socket.data.onMessage = (data) => {
      buffer += decoder.decode(data, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) {
          continue;
        }

        try {
          const message = JSON.parse(line) as SlopMessage;
          for (const handler of messageHandlers) {
            handler(message);
          }
        } catch (error) {
          console.warn("[sloppy] failed to parse unix socket message:", error);
        }
      }
    };

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
        socket.end();
      },
    } satisfies Connection;
  }

  private async connectSocket(
    onClose: () => void,
  ): Promise<Bun.Socket<{ onMessage: (data: Uint8Array) => void }>> {
    try {
      return await Bun.connect<{ onMessage: (data: Uint8Array) => void }>({
        unix: this.socketPath,
        data: {
          onMessage: () => undefined,
        },
        socket: {
          binaryType: "uint8array",
          data(socket, data) {
            socket.data.onMessage(data);
          },
          close() {
            onClose();
          },
          error(_socket, error) {
            console.warn("[sloppy] unix socket connection error:", error);
          },
        },
      });
    } catch (error) {
      throw new Error(
        `Unix socket connection failed: ${this.socketPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

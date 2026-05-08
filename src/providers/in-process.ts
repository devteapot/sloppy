import type {
  ClientTransport,
  Connection,
  MessageHandler,
  SlopMessage,
} from "@slop-ai/consumer/browser";
import type { Connection as ServerConnection, SlopServer } from "@slop-ai/server";

export class InProcessTransport implements ClientTransport {
  constructor(private server: SlopServer) {}

  async connect(): Promise<Connection> {
    const messageHandlers: MessageHandler[] = [];
    const closeHandlers = new Set<() => void>();
    const buffer: SlopMessage[] = [];
    let ready = false;
    let closed = false;

    const dispatch = (message: SlopMessage) => {
      if (!ready) {
        buffer.push(message);
        return;
      }

      for (const handler of messageHandlers) {
        handler(message);
      }
    };

    const serverConnection: ServerConnection = {
      send: (message: unknown) => {
        dispatch(message as SlopMessage);
      },
      close: () => {
        if (closed) {
          return;
        }

        closed = true;
        for (const handler of closeHandlers) {
          handler();
        }
      },
    };

    this.server.handleConnection(serverConnection);

    return {
      send: (message: SlopMessage) => {
        void this.server.handleMessage(serverConnection, message);
      },
      onMessage: (handler: MessageHandler) => {
        messageHandlers.push(handler);
        if (ready) {
          return;
        }

        ready = true;
        for (const message of buffer.splice(0)) {
          handler(message);
        }
      },
      onClose: (handler: () => void) => {
        closeHandlers.add(handler);
      },
      close: () => {
        if (closed) {
          return;
        }

        closed = true;
        this.server.handleDisconnect(serverConnection);
        for (const handler of closeHandlers) {
          handler();
        }
      },
    } satisfies Connection;
  }
}

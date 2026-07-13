import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";

import { z } from "zod";

import { unlinkSocketPath } from "../socket";
import type { ClientRequest, ClientServerMessage } from "./types";

const requestSchema = z
  .object({
    type: z.literal("request"),
    id: z.string().min(1),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type RpcConnection<TSnapshot> = {
  owner: object;
  socket: Socket;
  send(message: ClientServerMessage<TSnapshot>): void;
};

export function listenClientProtocol<TSnapshot>(options: {
  socketPath: string;
  protocol: string;
  version: number;
  snapshot: () => TSnapshot | Promise<TSnapshot>;
  subscribe: (listener: () => void) => () => void;
  handleRequest: (
    owner: object,
    method: string,
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  onConnect?: (owner: object) => void;
  onDisconnect?: (owner: object) => void;
}): { close(): void } {
  unlinkSocketPath(options.socketPath);
  mkdirSync(dirname(options.socketPath), { recursive: true });
  const connections = new Set<RpcConnection<TSnapshot>>();
  let revision = 1;
  let publishChain = Promise.resolve();

  const publishSnapshot = () => {
    publishChain = publishChain
      .then(async () => {
        revision += 1;
        const snapshot = await options.snapshot();
        for (const connection of connections) {
          connection.send({ type: "snapshot", revision, snapshot });
        }
      })
      .catch((error) => {
        console.warn(
          `[sloppy] ${options.protocol} snapshot publication failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const unsubscribe = options.subscribe(publishSnapshot);

  const server = createServer((socket) => {
    const owner = {};
    let buffer = "";
    let requestChain = Promise.resolve();
    const connection: RpcConnection<TSnapshot> = {
      owner,
      socket,
      send(message) {
        if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
      },
    };
    connections.add(connection);
    socket.setEncoding("utf8");

    void Promise.resolve(options.snapshot())
      .then((snapshot) => {
        connection.send({
          type: "hello",
          protocol: options.protocol,
          version: options.version,
          revision,
          snapshot,
        });
        options.onConnect?.(owner);
      })
      .catch((error) => {
        connection.send({
          type: "response",
          id: "hello",
          ok: false,
          error: {
            code: "snapshot_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        socket.end();
      });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        requestChain = requestChain.then(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            connection.send({
              type: "response",
              id: "invalid",
              ok: false,
              error: { code: "invalid_json", message: "Request was not valid JSON." },
            });
            return;
          }
          const requestResult = requestSchema.safeParse(parsed);
          if (!requestResult.success) {
            connection.send({
              type: "response",
              id:
                parsed && typeof parsed === "object" && "id" in parsed
                  ? String((parsed as { id: unknown }).id)
                  : "invalid",
              ok: false,
              error: { code: "invalid_request", message: "Invalid client protocol request." },
            });
            return;
          }
          const request = requestResult.data satisfies ClientRequest;
          try {
            const result = await options.handleRequest(owner, request.method, request.params ?? {});
            connection.send({ type: "response", id: request.id, ok: true, result });
          } catch (error) {
            connection.send({
              type: "response",
              id: request.id,
              ok: false,
              error: {
                code: "request_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        });
      }
    });

    socket.once("close", () => {
      connections.delete(connection);
      options.onDisconnect?.(owner);
    });
    socket.once("error", () => {
      connections.delete(connection);
    });
  });

  server.listen(options.socketPath, () => {
    try {
      chmodSync(options.socketPath, 0o600);
    } catch (error) {
      console.warn(`[sloppy] failed to chmod client socket ${options.socketPath} to 0600:`, error);
    }
  });

  return {
    close() {
      unsubscribe();
      for (const connection of connections) connection.socket.end();
      connections.clear();
      server.close();
      unlinkSocketPath(options.socketPath);
    },
  };
}

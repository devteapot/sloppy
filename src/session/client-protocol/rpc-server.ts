import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";

import { z } from "zod";

import { unlinkSocketPath } from "../socket";
import { createSnapshotPatch } from "./snapshot-patch";
import type { ClientRequest, ClientServerMessage } from "./types";

const SNAPSHOT_COALESCE_MS = 16;
const MAX_QUEUED_MESSAGES = 100;
const MAX_INPUT_BUFFER_BYTES = 1024 * 1024;

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
  ready: boolean;
  snapshot: TSnapshot | null;
  backpressured: boolean;
  pendingSnapshot: { revision: number; snapshot: TSnapshot } | null;
  queuedMessages: ClientServerMessage<TSnapshot>[];
  send(message: ClientServerMessage<TSnapshot>): void;
  sendSnapshot(revision: number, snapshot: TSnapshot): void;
  flush(): void;
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
  concurrentRequestMethods?: ReadonlySet<string>;
  onConnect?: (owner: object) => void;
  onDisconnect?: (owner: object) => void;
}): { close(): void } {
  unlinkSocketPath(options.socketPath);
  mkdirSync(dirname(options.socketPath), { recursive: true });
  const connections = new Set<RpcConnection<TSnapshot>>();
  let revision = 1;
  let stopped = false;
  let publishDirty = false;
  let publishInFlight = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let publicationChain = Promise.resolve();

  const publishCurrentSnapshot = (): Promise<void> => {
    const publication = publicationChain.then(async () => {
      if (stopped) return;
      const snapshot = await options.snapshot();
      if (stopped) return;
      revision += 1;
      for (const connection of connections) {
        if (connection.ready) connection.sendSnapshot(revision, snapshot);
      }
    });
    publicationChain = publication.catch((error) => {
      console.warn(
        `[sloppy] ${options.protocol} snapshot publication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return publication;
  };

  const schedulePublication = () => {
    if (stopped || publishTimer || publishInFlight || !publishDirty) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      publishInFlight = true;
      publishDirty = false;
      void publishCurrentSnapshot()
        .catch(() => {})
        .finally(() => {
          publishInFlight = false;
          schedulePublication();
        });
    }, SNAPSHOT_COALESCE_MS);
  };

  const publishSnapshot = () => {
    publishDirty = true;
    schedulePublication();
  };
  const unsubscribe = options.subscribe(publishSnapshot);

  const server = createServer((socket) => {
    const owner = {};
    let buffer = "";
    let closed = false;
    let registered = false;
    const connection: RpcConnection<TSnapshot> = {
      owner,
      socket,
      ready: false,
      snapshot: null,
      backpressured: false,
      pendingSnapshot: null,
      queuedMessages: [],
      send(message) {
        if (socket.destroyed) return;
        if (connection.backpressured) {
          if (connection.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
            socket.destroy(
              new Error(`${options.protocol} client output queue exceeded its limit.`),
            );
            return;
          }
          connection.queuedMessages.push(message);
          return;
        }
        connection.backpressured = !socket.write(`${JSON.stringify(message)}\n`);
      },
      sendSnapshot(nextRevision, snapshot) {
        if (socket.destroyed || !connection.ready) return;
        if (connection.backpressured || connection.queuedMessages.length > 0) {
          connection.pendingSnapshot = { revision: nextRevision, snapshot };
          return;
        }
        const operations = createSnapshotPatch(connection.snapshot, snapshot);
        connection.snapshot = snapshot;
        if (operations.length > 0) {
          connection.send({ type: "patch", revision: nextRevision, operations });
        }
      },
      flush() {
        if (socket.destroyed) return;
        connection.backpressured = false;
        while (!connection.backpressured && connection.queuedMessages.length > 0) {
          const message = connection.queuedMessages.shift();
          if (message) connection.send(message);
        }
        if (!connection.backpressured && connection.pendingSnapshot) {
          const pending = connection.pendingSnapshot;
          connection.pendingSnapshot = null;
          connection.sendSnapshot(pending.revision, pending.snapshot);
        }
      },
    };
    connections.add(connection);
    socket.setEncoding("utf8");

    const hello = Promise.resolve(options.snapshot())
      .then((snapshot) => {
        if (closed) return;
        connection.send({
          type: "hello",
          protocol: options.protocol,
          version: options.version,
          revision,
          snapshot,
        });
        connection.snapshot = snapshot;
        connection.ready = true;
        registered = true;
        options.onConnect?.(owner);
        publishSnapshot();
      })
      .catch((error) => {
        if (closed) return;
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
    let requestChain = hello;

    const executeRequest = async (request: ClientRequest) => {
      try {
        const result = await options.handleRequest(owner, request.method, request.params ?? {});
        try {
          await publishCurrentSnapshot();
        } catch {
          // Publication failures are logged by publishCurrentSnapshot. The
          // command already committed and must not be reported as failed.
        }
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
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_INPUT_BUFFER_BYTES) {
        socket.destroy(new Error(`${options.protocol} client input exceeded its limit.`));
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        requestChain = requestChain.then(async () => {
          if (!connection.ready) return;
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
          if (options.concurrentRequestMethods?.has(request.method)) {
            void executeRequest(request);
            return;
          }
          await executeRequest(request);
        });
      }
    });
    socket.on("drain", () => connection.flush());

    socket.once("close", () => {
      closed = true;
      connection.ready = false;
      connection.queuedMessages.length = 0;
      connection.pendingSnapshot = null;
      connections.delete(connection);
      if (registered) options.onDisconnect?.(owner);
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
      stopped = true;
      unsubscribe();
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = null;
      for (const connection of connections) connection.socket.end();
      connections.clear();
      server.close();
      unlinkSocketPath(options.socketPath);
    },
  };
}

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Connection } from "@slop-ai/server";
import type { SessionSupervisorProvider } from "./supervisor";

const DESCRIPTOR_FILENAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function listenSessionSupervisor(
  provider: SessionSupervisorProvider,
  socketPath: string,
  options: { register?: boolean } = {},
): { close: () => void } {
  removeSocketIfPresent(socketPath);
  mkdirSync(dirname(socketPath), { recursive: true });

  const server = createServer((socket: Socket) => {
    const conn = createNdjsonConnection(socket);
    provider.server.handleConnection(conn);

    conn.onMessage(async (msg: Record<string, unknown>) => {
      if (await handleSupervisorInvoke(provider, conn, msg)) {
        return;
      }
      await provider.server.handleMessage(conn, msg);
    });

    conn.onClose(() => {
      provider.removeConnection(conn);
      provider.server.handleDisconnect(conn);
    });
  });

  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch (error) {
      console.warn(`[slop] failed to chmod socket ${socketPath} to 0600:`, error);
    }
    if (options.register) {
      registerProvider(provider.server.id, provider.server.name, socketPath);
    }
  });

  return {
    close() {
      server.close();
      removeSocketIfPresent(socketPath);
      if (options.register) {
        unregisterProvider(provider.server.id);
      }
    },
  };
}

interface NdjsonConnection extends Connection {
  onMessage(handler: (msg: Record<string, unknown>) => void | Promise<void>): void;
  onClose(handler: () => void): void;
}

async function handleSupervisorInvoke(
  provider: SessionSupervisorProvider,
  conn: Connection,
  msg: Record<string, unknown>,
): Promise<boolean> {
  if (msg.type !== "invoke") {
    return false;
  }
  const id = typeof msg.id === "string" ? msg.id : "";
  const path = typeof msg.path === "string" ? msg.path : "";
  const action = typeof msg.action === "string" ? msg.action : "";
  const params =
    msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};

  try {
    const data = await provider.handleConnectionInvoke(conn, path, action, params);
    if (data === null) {
      return false;
    }
    conn.send({ type: "result", id, status: "ok", data });
    provider.server.refresh();
    return true;
  } catch (error) {
    conn.send({
      type: "result",
      id,
      status: "error",
      error: {
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    provider.server.refresh();
    return true;
  }
}

function createNdjsonConnection(socket: Socket): NdjsonConnection {
  const messageHandlers: Array<(msg: Record<string, unknown>) => void | Promise<void>> = [];
  const closeHandlers: Array<() => void> = [];
  const rl = createInterface({ input: socket });

  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      for (const handler of messageHandlers) {
        void handler(msg);
      }
    } catch (error) {
      console.warn("[slop] failed to parse socket message:", error);
    }
  });

  rl.on("close", () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    send(message: unknown) {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    },
    close() {
      socket.end();
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}

function removeSocketIfPresent(socketPath: string): void {
  if (!existsSync(socketPath)) {
    return;
  }
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error(`Refusing to remove non-socket file at ${socketPath}.`);
  }
  unlinkSync(socketPath);
}

function getDiscoveryDir(): string {
  return join(homedir(), ".slop", "providers");
}

function registerProvider(id: string, name: string, socketPath: string): void {
  if (!DESCRIPTOR_FILENAME_RE.test(id)) {
    throw new Error(
      `[slop] provider id ${JSON.stringify(id)} is not a valid descriptor filename stem.`,
    );
  }
  const dir = getDiscoveryDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify({ id, name, transport: `unix:${socketPath}` }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function unregisterProvider(id: string): void {
  const path = join(getDiscoveryDir(), `${id}.json`);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

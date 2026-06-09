import { lstatSync, unlinkSync } from "node:fs";
import type { Connection, SlopServer } from "@slop-ai/server";

export type Listener = {
  close: () => void;
};

export type UnixListener = Listener;

export type WebSocketListenOptions = {
  host?: string;
  port: number;
  path?: string;
  token?: string;
  allowedOrigins?: string[];
  publicUrl?: string;
  discovery?: boolean;
};

export type WebSocketListener = Listener & {
  url: string;
  host: string;
  port: number;
  path: string;
};

type WebSocketHooks = {
  providerId: string;
  providerName: string;
  options: WebSocketListenOptions;
  handleConnection: (conn: Connection) => void;
  handleMessage: (conn: Connection, msg: Record<string, unknown>) => void | Promise<void>;
  handleDisconnect: (conn: Connection) => void;
};

const DEFAULT_WS_HOST = "127.0.0.1";
const DEFAULT_WS_PATH = "/slop";
const WS_CAPABILITIES = [
  "state",
  "patches",
  "affordances",
  "attention",
  "windowing",
  "async",
  "content_refs",
];

export function unlinkSocketPath(socketPath: string): void {
  try {
    if (lstatSync(socketPath).isSocket()) {
      unlinkSync(socketPath);
    }
  } catch {
    // Best-effort cleanup. A listener implementation may already unlink, or
    // the process may be shutting down after the path disappeared.
  }
}

export function closeUnixListener(
  listener: UnixListener | null | undefined,
  socketPath: string,
): void {
  try {
    listener?.close();
  } catch {
    // Closing is best-effort during shutdown; removing stale sockets matters
    // more for the next managed TUI/session start.
  } finally {
    unlinkSocketPath(socketPath);
  }
}

export function listenWebSocketSlop(
  slop: SlopServer,
  options: WebSocketListenOptions,
): WebSocketListener {
  return listenWebSocketConnections({
    providerId: slop.id,
    providerName: slop.name,
    options,
    handleConnection: (conn) => slop.handleConnection(conn),
    handleMessage: (conn, msg) => slop.handleMessage(conn, msg),
    handleDisconnect: (conn) => slop.handleDisconnect(conn),
  });
}

export function listenWebSocketConnections(hooks: WebSocketHooks): WebSocketListener {
  const host = hooks.options.host ?? DEFAULT_WS_HOST;
  const path = normalizeWebSocketPath(hooks.options.path);
  const connections = new WeakMap<Bun.ServerWebSocket<undefined>, Connection>();

  const server: Bun.Server<undefined> = Bun.serve({
    hostname: host,
    port: hooks.options.port,
    fetch: async (req, bunServer) => {
      const url = new URL(req.url);

      if (url.pathname === path && req.headers.get("upgrade") === "websocket") {
        const rejected = await rejectWebSocketUpgrade(req, url, bunServer, hooks.options);
        if (rejected) {
          return rejected;
        }
        return bunServer.upgrade(req)
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 500 });
      }

      if (hooks.options.discovery !== false && url.pathname === "/.well-known/slop") {
        return Response.json({
          id: hooks.providerId,
          name: hooks.providerName,
          slop_version: "0.1",
          transport: { type: "ws", url: webSocketUrl(hooks.options, requirePort(bunServer.port)) },
          capabilities: WS_CAPABILITIES,
        });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const conn: Connection = {
          send(message: unknown) {
            try {
              ws.send(JSON.stringify(message));
            } catch (error) {
              console.warn("[sloppy] failed to send WebSocket message:", error);
            }
          },
          close() {
            ws.close();
          },
        };
        connections.set(ws, conn);
        hooks.handleConnection(conn);
      },
      message(ws, message) {
        const conn = connections.get(ws);
        if (!conn) {
          return;
        }
        try {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          const parsed = JSON.parse(text) as Record<string, unknown>;
          void Promise.resolve(hooks.handleMessage(conn, parsed)).catch((error: unknown) => {
            console.warn("[sloppy] failed to handle WebSocket message:", error);
          });
        } catch (error) {
          console.warn("[sloppy] failed to parse WebSocket message:", error);
        }
      },
      close(ws) {
        const conn = connections.get(ws);
        if (!conn) {
          return;
        }
        hooks.handleDisconnect(conn);
        connections.delete(ws);
      },
    },
  });

  return {
    url: webSocketUrl(hooks.options, requirePort(server.port)),
    host,
    port: requirePort(server.port),
    path,
    close() {
      server.stop(true);
    },
  };
}

function normalizeWebSocketPath(path: string | undefined): string {
  if (!path || path === "/") {
    return DEFAULT_WS_PATH;
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function webSocketUrl(options: WebSocketListenOptions, actualPort: number): string {
  if (options.publicUrl) {
    return options.publicUrl;
  }
  const host = options.host ?? DEFAULT_WS_HOST;
  const displayHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "localhost" : host;
  const bracketedHost =
    displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  return `ws://${bracketedHost}:${actualPort}${normalizeWebSocketPath(options.path)}`;
}

function requirePort(port: number | undefined): number {
  if (port === undefined) {
    throw new Error("WebSocket listener did not expose a port.");
  }
  return port;
}

async function rejectWebSocketUpgrade(
  req: Request,
  url: URL,
  server: Bun.Server<undefined>,
  options: WebSocketListenOptions,
): Promise<Response | null> {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (!options.allowedOrigins) {
      console.warn("[sloppy] refusing browser WebSocket upgrade: no allowed origins configured.");
      return new Response("Forbidden", { status: 403 });
    }
    if (!options.allowedOrigins.includes(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  if (options.token) {
    return tokenMatches(req, url, options.token)
      ? null
      : new Response("Unauthorized", { status: 401 });
  }

  const remote = server.requestIP(req)?.address ?? "";
  if (isLoopbackAddress(remote)) {
    return null;
  }

  console.warn(
    "[sloppy] refusing non-loopback WebSocket upgrade: configure --ws-token-env or --ws-token.",
  );
  return new Response("Unauthorized", { status: 401 });
}

function tokenMatches(req: Request, url: URL, expected: string): boolean {
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${expected}`) {
    return true;
  }
  return (
    url.searchParams.get("token") === expected || url.searchParams.get("access_token") === expected
  );
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

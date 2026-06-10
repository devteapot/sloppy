/**
 * Standalone WS gateway: exposes a SLOP supervisor and its sessions over a
 * single WebSocket port. `/supervisor` relays the supervisor's unix socket;
 * `/sessions/<id>` relays that session's unix socket. The gateway owns all
 * remote-exposure policy (auth, origins) — the session core stays unix-only.
 */

import { createDefaultAuthorizer, type GatewayAuthorizer } from "./auth";
import {
  type GatewaySocketData,
  RELAY_CLOSE,
  type Relay,
  type RelayCloseInfo,
  startRelay,
} from "./relay";
import { SessionRouteTable } from "./routes";

export type WsGatewayOptions = {
  supervisorSocketPath: string;
  port: number;
  host?: string;
  /** Path that relays the supervisor socket. Default: "/supervisor". */
  supervisorPath?: string;
  /** Path prefix for per-session relays. Default: "/sessions/". */
  sessionsPathPrefix?: string;
  /** Display/discovery URL override, e.g. a TLS-terminated proxy address. */
  publicUrl?: string;
  /** Serve /.well-known/slop. Default: true. */
  discovery?: boolean;
  /** Replaces the default token/origin/loopback policy entirely when set. */
  authorize?: GatewayAuthorizer;
  /** Used only by the default authorizer. */
  token?: string;
  /** Used only by the default authorizer. */
  allowedOrigins?: string[];
};

export type WsGateway = {
  url: string;
  host: string;
  port: number;
  sessionUrl(sessionId: string): string;
  close(): Promise<void>;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SUPERVISOR_PATH = "/supervisor";
const DEFAULT_SESSIONS_PREFIX = "/sessions/";
const GATEWAY_CAPABILITIES = [
  "state",
  "patches",
  "affordances",
  "attention",
  "windowing",
  "async",
  "content_refs",
];

export async function startWsGateway(options: WsGatewayOptions): Promise<WsGateway> {
  const host = options.host ?? DEFAULT_HOST;
  const supervisorPath = normalizeWebSocketPath(options.supervisorPath, DEFAULT_SUPERVISOR_PATH);
  const sessionsPrefix = normalizeSessionsPrefix(
    options.sessionsPathPrefix ?? DEFAULT_SESSIONS_PREFIX,
  );
  const authorize =
    options.authorize ??
    createDefaultAuthorizer({ token: options.token, allowedOrigins: options.allowedOrigins });
  if (options.authorize && (options.token || options.allowedOrigins)) {
    console.warn(
      "[sloppy] gateway: token/allowedOrigins are ignored when a custom authorize hook is set.",
    );
  }

  const routes = new SessionRouteTable({ supervisorSocketPath: options.supervisorSocketPath });
  routes.start();
  const relays = new Set<Relay>();

  const server = Bun.serve<GatewaySocketData>({
    hostname: host,
    port: options.port,
    fetch: async (req, bunServer) => {
      const url = new URL(req.url);
      const isUpgrade = req.headers.get("upgrade") === "websocket";

      if (isUpgrade && url.pathname === supervisorPath) {
        const rejected = await authorize(req, bunServer);
        if (rejected) {
          return rejected;
        }
        return upgradeWithData(bunServer, req, {
          upstreamSocketPath: options.supervisorSocketPath,
          unavailableClose: RELAY_CLOSE.supervisorUnavailable,
        });
      }

      if (isUpgrade && url.pathname.startsWith(sessionsPrefix)) {
        const rejected = await authorize(req, bunServer);
        if (rejected) {
          return rejected;
        }
        const segment = url.pathname.slice(sessionsPrefix.length);
        if (!segment || segment.includes("/")) {
          return new Response("Not found", { status: 404 });
        }
        const route = await routes.resolve(safeDecode(segment));
        if (route.status === "unknown") {
          return new Response("Unknown session", { status: 404 });
        }
        if (route.status === "dormant") {
          return upgradeWithData(bunServer, req, {
            upstreamSocketPath: "",
            unavailableClose: RELAY_CLOSE.sessionNotLive,
            immediateClose: RELAY_CLOSE.sessionNotLive,
          });
        }
        return upgradeWithData(bunServer, req, {
          upstreamSocketPath: route.socketPath,
          unavailableClose: RELAY_CLOSE.sessionNotLive,
        });
      }

      if (options.discovery !== false && url.pathname === "/.well-known/slop") {
        return Response.json({
          id: "sloppy-ws-gateway",
          name: "Sloppy WS Gateway",
          slop_version: "0.1",
          transport: { type: "ws", url: gatewayUrl() },
          capabilities: GATEWAY_CAPABILITIES,
          paths: {
            supervisor: supervisorPath,
            session_template: `${sessionsPrefix}{session_id}`,
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.immediateClose) {
          ws.close(ws.data.immediateClose.code, ws.data.immediateClose.reason);
          return;
        }
        const relay = startRelay({
          ws,
          upstreamSocketPath: ws.data.upstreamSocketPath,
          unavailableClose: ws.data.unavailableClose,
          onEnd: () => relays.delete(relay),
        });
        ws.data.relay = relay;
        relays.add(relay);
      },
      message(ws, message) {
        ws.data.relay?.handleFrame(message);
      },
      drain(ws) {
        ws.data.relay?.handleDrain();
      },
      close(ws) {
        const relay = ws.data.relay;
        ws.data.relay = undefined;
        if (relay) {
          relays.delete(relay);
          relay.handleClose();
        }
      },
    },
  });

  const port = requirePort(server.port);

  function gatewayUrl(): string {
    return formatWebSocketUrl({ host, publicUrl: options.publicUrl, path: supervisorPath }, port);
  }

  return {
    url: gatewayUrl(),
    host,
    port,
    sessionUrl(sessionId: string): string {
      const sessionPath = `${sessionsPrefix}${encodeURIComponent(sessionId)}`;
      if (options.publicUrl) {
        const url = new URL(options.publicUrl);
        // A proxied public URL may mount the gateway under a prefix; keep it.
        const prefix = url.pathname.endsWith(supervisorPath)
          ? url.pathname.slice(0, -supervisorPath.length)
          : "";
        url.pathname = `${prefix}${sessionPath}`;
        return url.toString();
      }
      return formatWebSocketUrl({ host, path: sessionPath }, port);
    },
    async close(): Promise<void> {
      routes.stop();
      for (const relay of [...relays]) {
        relay.destroy();
      }
      relays.clear();
      server.stop(true);
    },
  };
}

function upgradeWithData(
  server: Bun.Server<GatewaySocketData>,
  req: Request,
  data: GatewaySocketData,
): Response | undefined {
  return server.upgrade(req, { data })
    ? undefined
    : new Response("WebSocket upgrade failed", { status: 500 });
}

export function normalizeWebSocketPath(path: string | undefined, fallback: string): string {
  if (!path || path === "/") {
    return fallback;
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSessionsPrefix(prefix: string): string {
  const withLeading = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

export function formatWebSocketUrl(
  options: { host?: string; publicUrl?: string; path: string },
  actualPort: number,
): string {
  if (options.publicUrl) {
    return options.publicUrl;
  }
  const host = options.host ?? DEFAULT_HOST;
  const displayHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "localhost" : host;
  const bracketedHost =
    displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  return `ws://${bracketedHost}:${actualPort}${options.path}`;
}

export function requirePort(port: number | undefined): number {
  if (port === undefined) {
    throw new Error("WebSocket listener did not expose a port.");
  }
  return port;
}

export type { GatewayAuthorizer, RelayCloseInfo };

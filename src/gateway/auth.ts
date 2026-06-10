/**
 * Upgrade authorization policy for the WS gateway.
 *
 * The default policy mirrors what the in-core WS transport enforced:
 * browser origins must be allowlisted, non-loopback clients must present a
 * token, and loopback connections without a configured token are allowed.
 * Embedders replace the whole policy via `WsGatewayOptions.authorize`.
 */

export type GatewayAuthorizer = (
  req: Request,
  server: Bun.Server<unknown>,
) => Response | null | Promise<Response | null>;

export function createDefaultAuthorizer(options: {
  token?: string;
  allowedOrigins?: string[];
}): GatewayAuthorizer {
  return (req, server) => {
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
      return tokenMatches(req, options.token)
        ? null
        : new Response("Unauthorized", { status: 401 });
    }

    const remote = server.requestIP(req)?.address ?? "";
    if (isLoopbackAddress(remote)) {
      return null;
    }

    console.warn(
      "[sloppy] refusing non-loopback WebSocket upgrade: configure --token-env or --token.",
    );
    return new Response("Unauthorized", { status: 401 });
  };
}

let warnedQueryParamToken = false;

function tokenMatches(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${expected}`) {
    return true;
  }
  const url = new URL(req.url);
  const queryMatch =
    url.searchParams.get("token") === expected || url.searchParams.get("access_token") === expected;
  if (queryMatch && !warnedQueryParamToken) {
    // Query params are accepted because browser WebSocket clients cannot set
    // headers, but URLs end up in proxy/server logs — prefer the Bearer header.
    warnedQueryParamToken = true;
    console.warn(
      "[sloppy] WebSocket client authenticated with a query-param token; tokens in URLs can leak into logs. Prefer the Authorization: Bearer header.",
    );
  }
  return queryMatch;
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

import { parseRouteEnvelope } from "./message-envelope";
import type { RouteMessageEnvelope, RouteRule } from "./meta-runtime-model";

export function routeMessageBody(message: string | RouteMessageEnvelope): string {
  return typeof message === "string" ? message : message.body;
}

export function normalizeRouteEnvelope(
  source: string,
  message: string | RouteMessageEnvelope,
): RouteMessageEnvelope {
  if (typeof message === "string") {
    return {
      id: `message-${crypto.randomUUID()}`,
      source,
      body: message,
    };
  }

  return parseRouteEnvelope(message, { fallbackSource: source });
}

export function parseRouteMessage(raw: unknown): string | RouteMessageEnvelope {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("message must be a string or route message envelope.");
  }

  return parseRouteEnvelope(raw);
}

export function matchingRoutes(
  routes: RouteRule[],
  envelope: RouteMessageEnvelope,
  fanout: boolean,
): RouteRule[] {
  const matches = routes
    .filter((route) => {
      if (!route.enabled) return false;
      if (route.source !== "*" && route.source !== envelope.source) return false;
      return route.match === "*" || envelope.body.includes(route.match);
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

  return fanout ? matches : matches.slice(0, 1);
}

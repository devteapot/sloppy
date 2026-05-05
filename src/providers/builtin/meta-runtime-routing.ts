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

  return {
    ...message,
    id: message.id || `message-${crypto.randomUUID()}`,
    source: message.source || source,
  };
}

export function parseRouteMessage(raw: unknown): string | RouteMessageEnvelope {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("message must be a string or route message envelope.");
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.body !== "string" || record.body.trim() === "") {
    throw new Error("message.body must be a non-empty string.");
  }

  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  return {
    id: typeof record.id === "string" ? record.id : `message-${crypto.randomUUID()}`,
    source: typeof record.source === "string" ? record.source : "",
    body: record.body,
    topic: typeof record.topic === "string" ? record.topic : undefined,
    channelId: typeof record.channelId === "string" ? record.channelId : undefined,
    inReplyTo: typeof record.inReplyTo === "string" ? record.inReplyTo : undefined,
    causationId: typeof record.causationId === "string" ? record.causationId : undefined,
    metadata,
  };
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

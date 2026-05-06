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

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function trafficSampleAllows(route: RouteRule, envelope: RouteMessageEnvelope): boolean {
  const sampleRate = route.traffic?.sampleRate;
  if (sampleRate === undefined || sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const bucket = stableHash(`${route.id}:${envelope.id}`) / 0xffffffff;
  return bucket < sampleRate;
}

function envelopeFieldValue(envelope: RouteMessageEnvelope, field: string | undefined): unknown {
  if (field === undefined || field === "body") return envelope.body;
  if (field === "topic") return envelope.topic;
  if (field === "channelId") return envelope.channelId;
  if (!field.startsWith("metadata.")) return undefined;

  let current: unknown = envelope.metadata;
  for (const part of field.slice("metadata.".length).split(".")) {
    if (!part || !current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function routeFieldMatches(route: RouteRule, envelope: RouteMessageEnvelope): boolean {
  const mode = route.matchMode ?? "substring";
  const value = envelopeFieldValue(envelope, route.matchField);
  if (mode === "exists") {
    return value !== undefined && value !== null;
  }
  if (route.match === "*") {
    return true;
  }
  if (value === undefined || value === null) {
    return false;
  }

  const rawCandidate =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : (JSON.stringify(value) ?? String(value));
  const caseSensitive = route.caseSensitive !== false;
  const candidate = caseSensitive ? rawCandidate : rawCandidate.toLowerCase();
  const match = caseSensitive ? route.match : route.match.toLowerCase();

  switch (mode) {
    case "exact":
      return candidate === match;
    case "prefix":
      return candidate.startsWith(match);
    case "regex": {
      const regex = new RegExp(route.match, caseSensitive ? undefined : "i");
      return regex.test(rawCandidate);
    }
    default:
      return candidate.includes(match);
  }
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
      if (!trafficSampleAllows(route, envelope)) return false;
      return routeFieldMatches(route, envelope);
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

  return fanout ? matches : matches.slice(0, 1);
}

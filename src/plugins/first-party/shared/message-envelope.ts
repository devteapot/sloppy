export type RouteMessageEnvelope = {
  id: string;
  source: string;
  body: string;
  topic?: string;
  channelId?: string;
  inReplyTo?: string;
  causationId?: string;
  metadata?: Record<string, unknown>;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("envelope.metadata must be an object when provided.");
  }
  return value as Record<string, unknown>;
}

export function parseRouteEnvelope(
  raw: unknown,
  options: { fallbackSource?: string; fallbackBody?: string } = {},
): RouteMessageEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("envelope must be an object.");
  }

  const record = raw as Record<string, unknown>;
  const body =
    typeof record.body === "string" && record.body.trim() !== ""
      ? record.body
      : options.fallbackBody;
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("envelope.body must be a non-empty string.");
  }

  return {
    id: optionalString(record.id) ?? `message-${crypto.randomUUID()}`,
    source: optionalString(record.source) ?? options.fallbackSource ?? "",
    body,
    topic: optionalString(record.topic),
    channelId: optionalString(record.channelId),
    inReplyTo: optionalString(record.inReplyTo),
    causationId: optionalString(record.causationId),
    metadata: optionalMetadata(record.metadata),
  };
}

export function parseOptionalRouteEnvelope(
  raw: unknown,
  options: { fallbackSource?: string; fallbackBody?: string } = {},
): RouteMessageEnvelope | undefined {
  if (raw === undefined || raw === null) return undefined;
  return parseRouteEnvelope(raw, options);
}

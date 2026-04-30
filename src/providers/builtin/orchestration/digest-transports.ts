import type {
  DigestDeliveryTransport,
  DigestRecord,
  EmailDigestTransportOptions,
  SlackDigestTransportOptions,
} from "./types";

function normalizeChannel(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function digestText(digest: DigestRecord): string {
  const gates = digest.sections.escalations
    .slice(0, 5)
    .map((gate) => `- ${gate.gate_type}: ${gate.summary}`);
  const actions = digest.actions.slice(0, 5).map((action) => `- ${action.label}`);
  return [
    `Digest ${digest.id}: ${digest.status}`,
    ...digest.headline,
    gates.length > 0 ? "Escalations:" : undefined,
    ...gates,
    actions.length > 0 ? "Actions:" : undefined,
    ...actions,
    `Pull: ${digest.delivery.pull_ref}`,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

async function responseText(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.trim().length > 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function externalRefFromBody(body: string | undefined, fallback: string): string {
  if (!body) return fallback;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.id === "string" && record.id.length > 0) return record.id;
      if (typeof record.message_id === "string" && record.message_id.length > 0) {
        return record.message_id;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function createSlackDigestTransport(
  options: SlackDigestTransportOptions,
): DigestDeliveryTransport {
  const channel = normalizeChannel(options.channel, "slack");
  const fetchImpl = options.fetch ?? fetch;
  return {
    channel,
    async deliver({ digest }) {
      const response = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: digestText(digest),
          username: options.username,
          icon_emoji: options.iconEmoji,
        }),
      });
      const body = await responseText(response);
      if (!response.ok) {
        return {
          ok: false,
          error: body ?? `Slack webhook returned HTTP ${response.status}.`,
          retryable: retryableStatus(response.status),
        };
      }
      return {
        ok: true,
        external_ref: externalRefFromBody(body, `slack:${digest.id}`),
      };
    },
  };
}

export function createEmailDigestTransport(
  options: EmailDigestTransportOptions,
): DigestDeliveryTransport {
  const channel = normalizeChannel(options.channel, "email");
  const fetchImpl = options.fetch ?? fetch;
  return {
    channel,
    async deliver({ digest }) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options.headers ?? {}),
      };
      if (options.apiKey) {
        headers.authorization = `Bearer ${options.apiKey}`;
      }
      const response = await fetchImpl(options.endpointUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: options.from,
          to: options.to,
          subject: `${options.subjectPrefix ?? "Sloppy digest"}: ${digest.status}`,
          text: digestText(digest),
        }),
      });
      const body = await responseText(response);
      if (!response.ok) {
        return {
          ok: false,
          error: body ?? `Email endpoint returned HTTP ${response.status}.`,
          retryable: retryableStatus(response.status),
        };
      }
      return {
        ok: true,
        external_ref: externalRefFromBody(body, `email:${digest.id}`),
      };
    },
  };
}

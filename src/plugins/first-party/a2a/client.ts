import {
  type A2AAgentCard,
  type A2AAgentInterface,
  type A2AAgentState,
  asRecord,
  configuredCardUrl,
  type FetchLike,
  maybeRecord,
  normalizeBinding,
  optionalString,
} from "./model";

export type AgentCardFetchResult =
  | { kind: "not-modified" }
  | {
      kind: "updated";
      card: A2AAgentCard;
      selectedInterface: A2AAgentInterface;
      etag?: string;
      lastModified?: string;
    };

export class A2AClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchAgentCard(agent: A2AAgentState): Promise<AgentCardFetchResult> {
    const headers = this.buildHeaders(agent);
    if (agent.etag) headers.set("If-None-Match", agent.etag);
    if (agent.lastModified) headers.set("If-Modified-Since", agent.lastModified);

    const response = await this.fetchWithTimeout(agent, configuredCardUrl(agent.config), {
      method: "GET",
      headers,
    });
    if (response.status === 304 && agent.card) {
      return { kind: "not-modified" };
    }
    if (!response.ok) {
      throw new Error(`Agent Card fetch failed: HTTP ${response.status} ${response.statusText}`);
    }

    const card = asRecord(await response.json(), "A2A Agent Card") as A2AAgentCard;
    return {
      kind: "updated",
      card,
      selectedInterface: this.selectJsonRpcInterface(agent, card),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
  }

  async invokeJsonRpc(
    agent: A2AAgentState,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!agent.interfaceUrl) {
      throw new Error(`A2A agent ${agent.id} has no selected JSONRPC interface.`);
    }
    const response = await this.fetchWithTimeout(agent, agent.interfaceUrl, {
      method: "POST",
      headers: this.buildHeaders(agent, { json: true }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `a2a-${crypto.randomUUID()}`,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    if (!response.ok) {
      throw new Error(`A2A ${method} failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = asRecord(await response.json(), `A2A ${method} response`);
    const error = maybeRecord(payload.error);
    if (error) {
      const message = optionalString(error.message) ?? `A2A ${method} returned an error.`;
      const wrapped = new Error(message) as Error & { code?: string; data?: unknown };
      wrapped.code =
        typeof error.code === "string" ? error.code : String(error.code ?? "a2a_error");
      wrapped.data = error.data;
      throw wrapped;
    }
    return payload.result;
  }

  selectJsonRpcInterface(agent: A2AAgentState, card: A2AAgentCard): A2AAgentInterface {
    if (agent.config.url) {
      return {
        url: agent.config.url,
        protocolBinding: "JSONRPC",
        protocolVersion: agent.config.protocolVersion,
      };
    }
    for (const rawInterface of card.supportedInterfaces ?? []) {
      const candidate = maybeRecord(rawInterface);
      if (!candidate || normalizeBinding(candidate.protocolBinding) !== "JSONRPC") continue;
      const url = optionalString(candidate.url);
      if (!url) continue;
      return {
        url,
        protocolBinding: "JSONRPC",
        protocolVersion: optionalString(candidate.protocolVersion),
        tenant: optionalString(candidate.tenant),
      };
    }
    const fallbackUrl = optionalString(card.url);
    if (fallbackUrl) {
      return {
        url: fallbackUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: agent.config.protocolVersion,
      };
    }
    throw new Error(`A2A agent ${agent.id} does not expose a JSONRPC interface.`);
  }

  private buildHeaders(agent: A2AAgentState, options: { json?: boolean } = {}): Headers {
    const headers = new Headers(agent.config.headers ?? {});
    headers.set("Accept", "application/json");
    if (options.json) headers.set("Content-Type", "application/json");
    const protocolVersion = agent.protocolVersion ?? agent.config.protocolVersion;
    if (protocolVersion) headers.set("A2A-Version", protocolVersion);

    if (agent.config.bearerTokenEnv) {
      const value = Bun.env[agent.config.bearerTokenEnv];
      if (!value) {
        throw new Error(
          `A2A agent ${agent.id} requires ${agent.config.bearerTokenEnv} for bearer auth.`,
        );
      }
      headers.set("Authorization", `Bearer ${value}`);
    }
    if (agent.config.apiKeyEnv) {
      if (!agent.config.apiKeyHeader) {
        throw new Error(`A2A agent ${agent.id} sets apiKeyEnv without apiKeyHeader.`);
      }
      const value = Bun.env[agent.config.apiKeyEnv];
      if (!value) throw new Error(`A2A agent ${agent.id} requires ${agent.config.apiKeyEnv}.`);
      headers.set(agent.config.apiKeyHeader, value);
    }
    return headers;
  }

  private async fetchWithTimeout(
    agent: A2AAgentState,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const timeoutMs = agent.config.timeoutMs;
    const controller = new AbortController();
    const timer = timeoutMs == null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`A2A request to ${url} timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

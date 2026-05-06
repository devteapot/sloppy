import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

export type A2AAgentConfig = {
  name?: string;
  cardUrl?: string;
  url?: string;
  protocolVersion?: string;
  headers?: Record<string, string>;
  bearerTokenEnv?: string;
  apiKeyEnv?: string;
  apiKeyHeader?: string;
  timeoutMs?: number;
  fetchOnStart?: boolean;
};

type A2AAgentStatus = "unfetched" | "refreshing" | "ready" | "error";

type A2AAgentCard = Record<string, unknown> & {
  name?: string;
  description?: string;
  version?: string;
  supportedInterfaces?: unknown[];
  capabilities?: Record<string, unknown>;
  skills?: unknown[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
};

type A2AAgentInterface = {
  url: string;
  protocolBinding: string;
  protocolVersion?: string;
  tenant?: string;
};

type A2APart = Record<string, unknown>;
type A2ATask = Record<string, unknown> & {
  id?: string;
  contextId?: string;
  status?: Record<string, unknown>;
};

type A2ATaskRecord = {
  id: string;
  agentId: string;
  taskId: string;
  contextId?: string;
  statusState?: string;
  lastUpdatedAt: string;
  source: "send" | "get" | "list" | "cancel";
  task: A2ATask;
};

type A2AAgentState = {
  id: string;
  config: A2AAgentConfig;
  status: A2AAgentStatus;
  error?: string;
  card?: A2AAgentCard;
  interfaceUrl?: string;
  protocolVersion?: string;
  tenant?: string;
  etag?: string;
  lastModified?: string;
  lastRefreshAt?: string;
  extendedCardAt?: string;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodeId(value: string): string {
  return encodeURIComponent(value);
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  const record = maybeRecord(value);
  if (!record) {
    throw new Error(`${context} must be an object.`);
  }
  return record;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalRecord(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asRecord(value, fieldName);
}

function optionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  return value;
}

function parseParts(value: unknown): A2APart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("parts must be a non-empty array.");
  }

  return value.map((part, index) => {
    const record = asRecord(part, `parts[${index}]`);
    const contentFields = ["text", "raw", "url", "data"].filter((key) => key in record);
    if (contentFields.length !== 1) {
      throw new Error(`parts[${index}] must contain exactly one of text, raw, url, or data.`);
    }
    return record;
  });
}

function normalizeBinding(value: unknown): string {
  return String(value ?? "")
    .replace(/[-_+\s]/g, "")
    .toUpperCase();
}

function taskKey(agentId: string, taskId: string): string {
  return `${agentId}:${taskId}`;
}

function taskStatusState(task: A2ATask): string | undefined {
  return optionalString(maybeRecord(task.status)?.state);
}

function taskStatusTimestamp(task: A2ATask): string | undefined {
  return optionalString(maybeRecord(task.status)?.timestamp);
}

function taskFromResponse(value: unknown): A2ATask | undefined {
  const response = maybeRecord(value);
  if (!response) {
    return undefined;
  }

  const nestedTask = maybeRecord(response.task);
  if (nestedTask) {
    return nestedTask as A2ATask;
  }

  return typeof response.id === "string" ? (response as A2ATask) : undefined;
}

function tasksFromListResponse(value: unknown): A2ATask[] {
  const response = maybeRecord(value);
  const tasks = Array.isArray(response?.tasks) ? response.tasks : Array.isArray(value) ? value : [];
  return tasks
    .map((task) => maybeRecord(task))
    .filter((task): task is A2ATask => Boolean(task && typeof task.id === "string"));
}

function agentName(agent: A2AAgentState): string {
  return agent.card?.name ?? agent.config.name ?? agent.id;
}

function configuredCardUrl(config: A2AAgentConfig): string {
  if (config.cardUrl) {
    return config.cardUrl;
  }
  if (config.url) {
    return new URL("/.well-known/agent-card.json", config.url).toString();
  }
  throw new Error("A2A agent requires cardUrl or url.");
}

export class A2AProvider {
  readonly server: SlopServer;
  private readonly fetchImpl: FetchLike;
  private readonly fetchOnStart: boolean;
  private readonly agents = new Map<string, A2AAgentState>();
  private readonly tasks = new Map<string, A2ATaskRecord>();

  constructor(
    options: {
      agents?: Record<string, A2AAgentConfig>;
      fetchOnStart?: boolean;
      fetchImpl?: FetchLike;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fetchOnStart = options.fetchOnStart ?? true;

    for (const [id, config] of Object.entries(options.agents ?? {})) {
      this.agents.set(id, {
        id,
        config,
        status: "unfetched",
      });
    }

    this.server = createSlopServer({
      id: "a2a",
      name: "A2A",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("agents", () => this.buildAgentsDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
  }

  start(): void {
    if (!this.fetchOnStart) {
      return;
    }

    void this.refreshStartAgents();
  }

  stop(): void {
    this.server.stop();
  }

  private async refreshStartAgents(): Promise<void> {
    await Promise.all(
      [...this.agents.values()]
        .filter((agent) => agent.config.fetchOnStart ?? true)
        .map((agent) => this.refreshAgent(agent.id).catch(() => undefined)),
    );
  }

  private requireAgent(agentId: string): A2AAgentState {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown A2A agent: ${agentId}`);
    }
    return agent;
  }

  private async ensureReady(agentId: string): Promise<A2AAgentState> {
    const agent = this.requireAgent(agentId);
    if (agent.status === "ready" && agent.interfaceUrl) {
      return agent;
    }

    await this.refreshAgent(agentId);
    return this.requireAgent(agentId);
  }

  private buildHeaders(agent: A2AAgentState, options: { json?: boolean } = {}): Headers {
    const headers = new Headers(agent.config.headers ?? {});
    headers.set("Accept", "application/json");
    if (options.json) {
      headers.set("Content-Type", "application/json");
    }

    const protocolVersion = agent.protocolVersion ?? agent.config.protocolVersion;
    if (protocolVersion) {
      headers.set("A2A-Version", protocolVersion);
    }

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
      if (!value) {
        throw new Error(`A2A agent ${agent.id} requires ${agent.config.apiKeyEnv}.`);
      }
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
    const timer =
      timeoutMs == null
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, timeoutMs);

    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`A2A request to ${url} timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private selectJsonRpcInterface(agent: A2AAgentState, card: A2AAgentCard): A2AAgentInterface {
    if (agent.config.url) {
      return {
        url: agent.config.url,
        protocolBinding: "JSONRPC",
        protocolVersion: agent.config.protocolVersion,
      };
    }

    const supportedInterfaces = Array.isArray(card.supportedInterfaces)
      ? card.supportedInterfaces
      : [];
    for (const rawInterface of supportedInterfaces) {
      const candidate = maybeRecord(rawInterface);
      if (!candidate || normalizeBinding(candidate.protocolBinding) !== "JSONRPC") {
        continue;
      }

      const url = optionalString(candidate.url);
      if (!url) {
        continue;
      }

      return {
        url,
        protocolBinding: "JSONRPC",
        protocolVersion: optionalString(candidate.protocolVersion),
        tenant: optionalString(candidate.tenant),
      };
    }

    const legacyUrl = optionalString(card.url);
    if (legacyUrl) {
      return {
        url: legacyUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: agent.config.protocolVersion,
      };
    }

    throw new Error(`A2A agent ${agent.id} does not expose a JSONRPC interface.`);
  }

  private async refreshAgent(agentId: string): Promise<{
    id: string;
    status: A2AAgentStatus;
    name: string;
    interfaceUrl: string | null;
    skillCount: number;
  }> {
    const agent = this.requireAgent(agentId);
    const cardUrl = configuredCardUrl(agent.config);
    agent.status = "refreshing";
    agent.error = undefined;
    this.server.refresh();

    try {
      const headers = this.buildHeaders(agent);
      if (agent.etag) {
        headers.set("If-None-Match", agent.etag);
      }
      if (agent.lastModified) {
        headers.set("If-Modified-Since", agent.lastModified);
      }

      const response = await this.fetchWithTimeout(agent, cardUrl, {
        method: "GET",
        headers,
      });

      if (response.status === 304 && agent.card) {
        agent.status = "ready";
        agent.lastRefreshAt = now();
        this.server.refresh();
        return {
          id: agent.id,
          status: agent.status,
          name: agentName(agent),
          interfaceUrl: agent.interfaceUrl ?? null,
          skillCount: Array.isArray(agent.card.skills) ? agent.card.skills.length : 0,
        };
      }

      if (!response.ok) {
        throw new Error(`Agent Card fetch failed: HTTP ${response.status} ${response.statusText}`);
      }

      const card = asRecord(await response.json(), "A2A Agent Card") as A2AAgentCard;
      const selectedInterface = this.selectJsonRpcInterface(agent, card);
      agent.card = card;
      agent.interfaceUrl = selectedInterface.url;
      agent.protocolVersion =
        agent.config.protocolVersion ?? selectedInterface.protocolVersion ?? "1.0";
      agent.tenant = selectedInterface.tenant;
      agent.etag = response.headers.get("etag") ?? undefined;
      agent.lastModified = response.headers.get("last-modified") ?? undefined;
      agent.status = "ready";
      agent.error = undefined;
      agent.lastRefreshAt = now();
      this.server.refresh();

      return {
        id: agent.id,
        status: agent.status,
        name: agentName(agent),
        interfaceUrl: agent.interfaceUrl ?? null,
        skillCount: Array.isArray(agent.card.skills) ? agent.card.skills.length : 0,
      };
    } catch (error) {
      agent.status = "error";
      agent.error = errorMessage(error);
      agent.lastRefreshAt = now();
      this.server.refresh();
      throw error;
    }
  }

  private async refreshAllAgents(): Promise<
    Array<{
      id: string;
      status: A2AAgentStatus;
      error?: string;
      skillCount: number;
    }>
  > {
    return Promise.all(
      [...this.agents.keys()].map(async (agentId) => {
        try {
          const result = await this.refreshAgent(agentId);
          return {
            id: result.id,
            status: result.status,
            skillCount: result.skillCount,
          };
        } catch (error) {
          const agent = this.requireAgent(agentId);
          return {
            id: agentId,
            status: agent.status,
            error: errorMessage(error),
            skillCount: Array.isArray(agent.card?.skills) ? agent.card.skills.length : 0,
          };
        }
      }),
    );
  }

  private async invokeJsonRpc(
    agentId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const agent = await this.ensureReady(agentId);
    if (!agent.interfaceUrl) {
      throw new Error(`A2A agent ${agentId} has no selected JSONRPC interface.`);
    }

    const requestId = `a2a-${crypto.randomUUID()}`;
    const response = await this.fetchWithTimeout(agent, agent.interfaceUrl, {
      method: "POST",
      headers: this.buildHeaders(agent, { json: true }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
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
      const code = error.code;
      wrapped.code = typeof code === "string" ? code : String(code ?? "a2a_error");
      wrapped.data = error.data;
      throw wrapped;
    }

    return payload.result;
  }

  private rememberTask(
    agentId: string,
    task: A2ATask,
    source: A2ATaskRecord["source"],
  ): A2ATaskRecord | undefined {
    if (!task.id) {
      return undefined;
    }

    const timestamp = taskStatusTimestamp(task) ?? now();
    const record: A2ATaskRecord = {
      id: taskKey(agentId, task.id),
      agentId,
      taskId: task.id,
      contextId: optionalString(task.contextId),
      statusState: taskStatusState(task),
      lastUpdatedAt: timestamp,
      source,
      task,
    };
    this.tasks.set(record.id, record);
    return record;
  }

  private buildSendParams(
    agent: A2AAgentState,
    parts: A2APart[],
    rawOptions: Record<string, unknown>,
  ): Record<string, unknown> {
    const message: Record<string, unknown> = {
      messageId: `message-${crypto.randomUUID()}`,
      role: "ROLE_USER",
      parts,
    };
    const contextId = optionalString(rawOptions.context_id);
    const taskId = optionalString(rawOptions.task_id);
    const referenceTaskIds = optionalStringArray(
      rawOptions.reference_task_ids,
      "reference_task_ids",
    );
    if (contextId) {
      message.contextId = contextId;
    }
    if (taskId) {
      message.taskId = taskId;
    }
    if (referenceTaskIds) {
      message.referenceTaskIds = referenceTaskIds;
    }
    const messageMetadata = optionalRecord(rawOptions.message_metadata, "message_metadata");
    if (messageMetadata) {
      message.metadata = messageMetadata;
    }

    const configuration: Record<string, unknown> = {};
    const acceptedOutputModes = optionalStringArray(
      rawOptions.accepted_output_modes,
      "accepted_output_modes",
    );
    const historyLength = optionalNumber(rawOptions.history_length);
    const returnImmediately = optionalBoolean(rawOptions.return_immediately);
    if (acceptedOutputModes) {
      configuration.acceptedOutputModes = acceptedOutputModes;
    }
    if (historyLength !== undefined) {
      configuration.historyLength = historyLength;
    }
    if (returnImmediately !== undefined) {
      configuration.returnImmediately = returnImmediately;
    }

    const params: Record<string, unknown> = {
      message,
    };
    if (agent.tenant) {
      params.tenant = agent.tenant;
    }
    if (Object.keys(configuration).length > 0) {
      params.configuration = configuration;
    }
    const metadata = optionalRecord(rawOptions.metadata, "metadata");
    if (metadata) {
      params.metadata = metadata;
    }
    return params;
  }

  private async sendParts(
    agentId: string,
    parts: A2APart[],
    options: Record<string, unknown>,
  ): Promise<{
    agent_id: string;
    task_id: string | null;
    context_id: string | null;
    response: unknown;
  }> {
    const agent = await this.ensureReady(agentId);
    const result = await this.invokeJsonRpc(
      agentId,
      "SendMessage",
      this.buildSendParams(agent, parts, options),
    );
    const task = taskFromResponse(result);
    const record = task ? this.rememberTask(agentId, task, "send") : undefined;
    this.server.refresh();
    return {
      agent_id: agentId,
      task_id: record?.taskId ?? null,
      context_id: record?.contextId ?? null,
      response: result,
    };
  }

  private async sendText(
    agentId: string,
    text: string,
    options: Record<string, unknown>,
  ): Promise<{
    agent_id: string;
    task_id: string | null;
    context_id: string | null;
    response: unknown;
  }> {
    if (text.trim() === "") {
      throw new Error("text must be non-empty.");
    }
    return this.sendParts(agentId, [{ text }], options);
  }

  private async listTasks(agentId: string, options: Record<string, unknown>): Promise<unknown> {
    const agent = await this.ensureReady(agentId);
    const params: Record<string, unknown> = {};
    if (agent.tenant) {
      params.tenant = agent.tenant;
    }
    const contextId = optionalString(options.context_id);
    const status = optionalString(options.status);
    const pageToken = optionalString(options.page_token);
    const statusTimestampAfter = optionalString(options.status_timestamp_after);
    const pageSize = optionalNumber(options.page_size);
    const historyLength = optionalNumber(options.history_length);
    const includeArtifacts = optionalBoolean(options.include_artifacts);
    if (contextId) params.contextId = contextId;
    if (status) params.status = status;
    if (pageToken) params.pageToken = pageToken;
    if (statusTimestampAfter) params.statusTimestampAfter = statusTimestampAfter;
    if (pageSize !== undefined) params.pageSize = pageSize;
    if (historyLength !== undefined) params.historyLength = historyLength;
    if (includeArtifacts !== undefined) params.includeArtifacts = includeArtifacts;

    const result = await this.invokeJsonRpc(agentId, "ListTasks", params);
    for (const task of tasksFromListResponse(result)) {
      this.rememberTask(agentId, task, "list");
    }
    this.server.refresh();
    return result;
  }

  private async getTask(
    agentId: string,
    taskId: string,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    const agent = await this.ensureReady(agentId);
    const params: Record<string, unknown> = { id: taskId };
    if (agent.tenant) {
      params.tenant = agent.tenant;
    }
    const historyLength = optionalNumber(options.history_length);
    if (historyLength !== undefined) {
      params.historyLength = historyLength;
    }
    const result = await this.invokeJsonRpc(agentId, "GetTask", params);
    const task = taskFromResponse(result);
    if (task) {
      this.rememberTask(agentId, task, "get");
    }
    this.server.refresh();
    return result;
  }

  private async cancelTask(
    agentId: string,
    taskId: string,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    const agent = await this.ensureReady(agentId);
    const params: Record<string, unknown> = { id: taskId };
    if (agent.tenant) {
      params.tenant = agent.tenant;
    }
    const metadata = optionalRecord(options.metadata, "metadata");
    if (metadata) {
      params.metadata = metadata;
    }

    const result = await this.invokeJsonRpc(agentId, "CancelTask", params);
    const task = taskFromResponse(result);
    if (task) {
      this.rememberTask(agentId, task, "cancel");
    }
    this.server.refresh();
    return result;
  }

  private async getExtendedCard(agentId: string): Promise<unknown> {
    const agent = await this.ensureReady(agentId);
    const params: Record<string, unknown> = {};
    if (agent.tenant) {
      params.tenant = agent.tenant;
    }
    const result = await this.invokeJsonRpc(agentId, "GetExtendedAgentCard", params);
    const card = maybeRecord(result);
    if (card) {
      agent.card = card as A2AAgentCard;
      const selectedInterface = this.selectJsonRpcInterface(agent, agent.card);
      agent.interfaceUrl = selectedInterface.url;
      agent.protocolVersion =
        agent.config.protocolVersion ??
        selectedInterface.protocolVersion ??
        agent.protocolVersion ??
        "1.0";
      agent.tenant = selectedInterface.tenant;
      agent.extendedCardAt = now();
      this.server.refresh();
    }
    return result;
  }

  private agentTasks(agentId: string): A2ATaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => task.agentId === agentId)
      .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
  }

  private buildSessionDescriptor() {
    const agents = [...this.agents.values()];
    const ready = agents.filter((agent) => agent.status === "ready").length;
    const errored = agents.filter((agent) => agent.status === "error").length;
    const skillCount = agents.reduce(
      (sum, agent) => sum + (Array.isArray(agent.card?.skills) ? agent.card.skills.length : 0),
      0,
    );

    return {
      type: "context",
      props: {
        agent_count: agents.length,
        ready_count: ready,
        error_count: errored,
        skill_count: skillCount,
        task_count: this.tasks.size,
        supported_binding: "JSONRPC",
      },
      summary:
        "A2A interoperability provider exposing remote Agent Cards and task lifecycle as SLOP state.",
      actions: {
        refresh_all: action(async () => this.refreshAllAgents(), {
          label: "Refresh A2A Agents",
          description: "Fetch configured A2A Agent Cards and select JSON-RPC interfaces.",
          idempotent: true,
          estimate: "slow",
        }),
      },
      meta: {
        focus: errored > 0,
        salience: agents.length > 0 ? 0.72 : 0.25,
        urgency: errored > 0 ? ("medium" as const) : ("low" as const),
      },
    };
  }

  private buildAgentsDescriptor() {
    const items: ItemDescriptor[] = [...this.agents.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => this.buildAgentItem(agent));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Configured external A2A agents.",
      items,
    };
  }

  private buildAgentItem(agent: A2AAgentState): ItemDescriptor {
    const capabilities = maybeRecord(agent.card?.capabilities);
    const skills = Array.isArray(agent.card?.skills) ? agent.card.skills : [];
    const tasks = this.agentTasks(agent.id);

    return {
      id: nodeId(agent.id),
      props: {
        id: agent.id,
        name: agentName(agent),
        description: agent.card?.description ?? null,
        version: agent.card?.version ?? null,
        status: agent.status,
        error: agent.error ?? null,
        card_url: configuredCardUrl(agent.config),
        interface_url: agent.interfaceUrl ?? null,
        protocol_binding: agent.interfaceUrl ? "JSONRPC" : null,
        protocol_version: agent.protocolVersion ?? null,
        tenant: agent.tenant ?? null,
        last_refresh_at: agent.lastRefreshAt ?? null,
        extended_card_at: agent.extendedCardAt ?? null,
        task_count: tasks.length,
        skill_count: skills.length,
        default_input_modes: agent.card?.defaultInputModes ?? [],
        default_output_modes: agent.card?.defaultOutputModes ?? [],
        capabilities: capabilities ?? null,
      },
      summary:
        agent.status === "error"
          ? `${agentName(agent)}: ${agent.error ?? "A2A Agent Card error"}`
          : `${agentName(agent)}: ${skills.length} skills, ${tasks.length} observed tasks`,
      actions: {
        refresh_card: action(async () => this.refreshAgent(agent.id), {
          label: "Refresh Card",
          description: "Fetch this A2A agent's Agent Card and choose a JSON-RPC interface.",
          idempotent: true,
          estimate: "slow",
        }),
        send_message: action(
          {
            text: "string",
            context_id: { type: "string", optional: true },
            task_id: { type: "string", optional: true },
            reference_task_ids: {
              type: "array",
              items: { type: "string" },
              optional: true,
            },
            accepted_output_modes: {
              type: "array",
              items: { type: "string" },
              optional: true,
            },
            history_length: { type: "number", optional: true },
            return_immediately: { type: "boolean", optional: true },
            metadata: {
              type: "object",
              description: "Optional SendMessage request metadata.",
              optional: true,
            },
            message_metadata: {
              type: "object",
              description: "Optional metadata attached to the A2A Message.",
              optional: true,
            },
          },
          async ({ text, ...options }) => this.sendText(agent.id, text, options),
          {
            label: "Send Message",
            description: "Send a text message to this A2A agent.",
            estimate: "slow",
          },
        ),
        send_parts: action(
          {
            parts: {
              type: "array",
              items: { type: "object" },
              description:
                "A2A message parts. Each part must contain exactly one of text, raw, url, or data.",
            },
            context_id: { type: "string", optional: true },
            task_id: { type: "string", optional: true },
            reference_task_ids: {
              type: "array",
              items: { type: "string" },
              optional: true,
            },
            accepted_output_modes: {
              type: "array",
              items: { type: "string" },
              optional: true,
            },
            history_length: { type: "number", optional: true },
            return_immediately: { type: "boolean", optional: true },
            metadata: {
              type: "object",
              description: "Optional SendMessage request metadata.",
              optional: true,
            },
            message_metadata: {
              type: "object",
              description: "Optional metadata attached to the A2A Message.",
              optional: true,
            },
          },
          async ({ parts, ...options }) => this.sendParts(agent.id, parseParts(parts), options),
          {
            label: "Send Parts",
            description: "Send text, file, URL, or structured data parts to this A2A agent.",
            estimate: "slow",
          },
        ),
        list_tasks: action(
          {
            context_id: { type: "string", optional: true },
            status: { type: "string", optional: true },
            page_size: { type: "number", optional: true },
            page_token: { type: "string", optional: true },
            history_length: { type: "number", optional: true },
            status_timestamp_after: { type: "string", optional: true },
            include_artifacts: { type: "boolean", optional: true },
          },
          async (options) => this.listTasks(agent.id, options),
          {
            label: "List Tasks",
            description: "List visible remote A2A tasks for this agent.",
            idempotent: true,
            estimate: "slow",
          },
        ),
        get_task: action(
          {
            task_id: "string",
            history_length: { type: "number", optional: true },
          },
          async ({ task_id, ...options }) => this.getTask(agent.id, task_id, options),
          {
            label: "Get Task",
            description: "Refresh one remote A2A task.",
            idempotent: true,
            estimate: "slow",
          },
        ),
        cancel_task: action(
          {
            task_id: "string",
            metadata: {
              type: "object",
              description: "Optional cancellation metadata.",
              optional: true,
            },
          },
          async ({ task_id, ...options }) => this.cancelTask(agent.id, task_id, options),
          {
            label: "Cancel Task",
            description: "Request cancellation of one remote A2A task.",
            dangerous: true,
            idempotent: true,
            estimate: "slow",
          },
        ),
        get_extended_card: action(async () => this.getExtendedCard(agent.id), {
          label: "Get Extended Card",
          description: "Fetch this A2A agent's authenticated extended Agent Card.",
          idempotent: true,
          estimate: "slow",
        }),
      },
      children: {
        skills: this.buildSkillsDescriptor(agent),
        tasks: this.buildAgentTasksDescriptor(agent.id),
      },
      meta: {
        salience: agent.status === "ready" ? 0.72 : 0.5,
        urgency: agent.status === "error" ? "medium" : "low",
      },
    };
  }

  private buildSkillsDescriptor(agent: A2AAgentState) {
    const skills = Array.isArray(agent.card?.skills) ? agent.card.skills : [];
    return {
      type: "collection",
      props: {
        count: skills.length,
      },
      summary: `A2A skills declared by ${agentName(agent)}.`,
      items: skills.map((rawSkill, index) => {
        const skill = maybeRecord(rawSkill) ?? {};
        const id = optionalString(skill.id) ?? `skill-${index}`;
        return {
          id: nodeId(id),
          props: {
            id,
            name: optionalString(skill.name) ?? id,
            description: optionalString(skill.description) ?? null,
            tags: Array.isArray(skill.tags)
              ? skill.tags.filter((tag) => typeof tag === "string")
              : [],
            examples: Array.isArray(skill.examples)
              ? skill.examples.filter((example) => typeof example === "string")
              : [],
            input_modes: Array.isArray(skill.inputModes)
              ? skill.inputModes.filter((mode) => typeof mode === "string")
              : (agent.card?.defaultInputModes ?? []),
            output_modes: Array.isArray(skill.outputModes)
              ? skill.outputModes.filter((mode) => typeof mode === "string")
              : (agent.card?.defaultOutputModes ?? []),
          },
          summary: optionalString(skill.description) ?? optionalString(skill.name) ?? id,
          meta: {
            salience: 0.55,
          },
        };
      }),
    };
  }

  private buildAgentTasksDescriptor(agentId: string) {
    const tasks = this.agentTasks(agentId);
    return {
      type: "collection",
      props: {
        count: tasks.length,
      },
      summary: `Observed A2A tasks for ${agentId}.`,
      items: tasks.map((task) => this.buildTaskItem(task, true)),
    };
  }

  private buildTasksDescriptor() {
    const tasks = [...this.tasks.values()].sort((left, right) =>
      right.lastUpdatedAt.localeCompare(left.lastUpdatedAt),
    );
    const active = tasks.filter(
      (task) =>
        task.statusState &&
        ![
          "TASK_STATE_COMPLETED",
          "TASK_STATE_FAILED",
          "TASK_STATE_CANCELED",
          "TASK_STATE_REJECTED",
        ].includes(task.statusState),
    ).length;
    return {
      type: "collection",
      props: {
        count: tasks.length,
        active_count: active,
      },
      summary: "Observed remote A2A tasks across configured agents.",
      items: tasks.map((task) => this.buildTaskItem(task, false)),
    };
  }

  private buildTaskItem(record: A2ATaskRecord, scopedToAgent: boolean): ItemDescriptor {
    return {
      id: nodeId(scopedToAgent ? record.taskId : record.id),
      props: {
        id: record.taskId,
        agent_id: record.agentId,
        context_id: record.contextId ?? null,
        status_state: record.statusState ?? null,
        last_updated_at: record.lastUpdatedAt,
        source: record.source,
        artifact_count: Array.isArray(record.task.artifacts) ? record.task.artifacts.length : 0,
        history_count: Array.isArray(record.task.history) ? record.task.history.length : 0,
        task: record.task,
      },
      summary: `${record.agentId}/${record.taskId}: ${record.statusState ?? "unknown"}`,
      actions: {
        refresh: action(
          {
            history_length: { type: "number", optional: true },
          },
          async (options) => this.getTask(record.agentId, record.taskId, options),
          {
            label: "Refresh Task",
            description: "Fetch the latest remote A2A task state.",
            idempotent: true,
            estimate: "slow",
          },
        ),
        send_followup: action(
          {
            text: "string",
            accepted_output_modes: {
              type: "array",
              items: { type: "string" },
              optional: true,
            },
            history_length: { type: "number", optional: true },
            return_immediately: { type: "boolean", optional: true },
            metadata: {
              type: "object",
              description: "Optional SendMessage request metadata.",
              optional: true,
            },
          },
          async ({ text, ...options }) =>
            this.sendText(record.agentId, text, {
              ...options,
              task_id: record.taskId,
              context_id: record.contextId,
            }),
          {
            label: "Send Follow-up",
            description: "Continue this A2A task with a text message.",
            estimate: "slow",
          },
        ),
        cancel: action(
          {
            metadata: {
              type: "object",
              description: "Optional cancellation metadata.",
              optional: true,
            },
          },
          async (options) => this.cancelTask(record.agentId, record.taskId, options),
          {
            label: "Cancel",
            description: "Request cancellation of this remote A2A task.",
            dangerous: true,
            idempotent: true,
            estimate: "slow",
          },
        ),
      },
      meta: {
        salience: record.statusState === "TASK_STATE_INPUT_REQUIRED" ? 0.85 : 0.62,
        urgency: record.statusState === "TASK_STATE_INPUT_REQUIRED" ? "medium" : "low",
      },
    };
  }
}

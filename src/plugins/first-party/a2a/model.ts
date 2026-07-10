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

export type A2AAgentStatus = "unfetched" | "refreshing" | "ready" | "error";

export type A2AAgentCard = Record<string, unknown> & {
  name?: string;
  description?: string;
  version?: string;
  supportedInterfaces?: unknown[];
  capabilities?: Record<string, unknown>;
  skills?: unknown[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
};

export type A2AAgentInterface = {
  url: string;
  protocolBinding: string;
  protocolVersion?: string;
  tenant?: string;
};

export type A2APart = Record<string, unknown>;

export type A2ATask = Record<string, unknown> & {
  id?: string;
  contextId?: string;
  status?: Record<string, unknown>;
};

export type A2ATaskRecord = {
  id: string;
  agentId: string;
  taskId: string;
  contextId?: string;
  statusState?: string;
  lastUpdatedAt: string;
  source: "send" | "get" | "list" | "cancel";
  task: A2ATask;
};

export type A2AAgentState = {
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

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function nodeId(value: string): string {
  return encodeURIComponent(value);
}

export function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asRecord(value: unknown, context: string): Record<string, unknown> {
  const record = maybeRecord(value);
  if (!record) {
    throw new Error(`${context} must be an object.`);
  }
  return record;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function optionalRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asRecord(value, fieldName);
}

export function optionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  return value;
}

export function parseParts(value: unknown): A2APart[] {
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

export function normalizeBinding(value: unknown): string {
  return String(value ?? "")
    .replace(/[-_+\s]/g, "")
    .toUpperCase();
}

export function taskKey(agentId: string, taskId: string): string {
  return `${agentId}:${taskId}`;
}

export function taskStatusState(task: A2ATask): string | undefined {
  return optionalString(maybeRecord(task.status)?.state);
}

export function taskStatusTimestamp(task: A2ATask): string | undefined {
  return optionalString(maybeRecord(task.status)?.timestamp);
}

export function taskFromResponse(value: unknown): A2ATask | undefined {
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

export function tasksFromListResponse(value: unknown): A2ATask[] {
  const response = maybeRecord(value);
  const tasks = Array.isArray(response?.tasks) ? response.tasks : Array.isArray(value) ? value : [];
  return tasks
    .map((task) => maybeRecord(task))
    .filter((task): task is A2ATask => Boolean(task && typeof task.id === "string"));
}

export function agentName(agent: A2AAgentState): string {
  return agent.card?.name ?? agent.config.name ?? agent.id;
}

export function configuredCardUrl(config: A2AAgentConfig): string {
  if (config.cardUrl) {
    return config.cardUrl;
  }
  if (config.url) {
    return new URL("/.well-known/agent-card.json", config.url).toString();
  }
  throw new Error("A2A agent requires cardUrl or url.");
}

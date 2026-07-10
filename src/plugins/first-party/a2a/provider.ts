import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { errorMessage, now } from "../shared/runtime-helpers";
import { A2AClient } from "./client";
import {
  type A2AAgentCard,
  type A2AAgentConfig,
  type A2AAgentState,
  type A2AAgentStatus,
  type A2APart,
  type A2ATask,
  type A2ATaskRecord,
  agentName,
  configuredCardUrl,
  type FetchLike,
  maybeRecord,
  nodeId,
  optionalBoolean,
  optionalNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  parseParts,
  taskFromResponse,
  taskKey,
  taskStatusState,
  taskStatusTimestamp,
  tasksFromListResponse,
} from "./model";

export type { A2AAgentConfig } from "./model";

export class A2AProvider {
  readonly server: SlopServer;
  private readonly client: A2AClient;
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
    this.client = new A2AClient(options.fetchImpl);
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

  private async refreshAgent(agentId: string): Promise<{
    id: string;
    status: A2AAgentStatus;
    name: string;
    interfaceUrl: string | null;
    skillCount: number;
  }> {
    const agent = this.requireAgent(agentId);
    agent.status = "refreshing";
    agent.error = undefined;
    this.server.refresh();

    try {
      const result = await this.client.fetchAgentCard(agent);
      if (result.kind === "not-modified") {
        agent.status = "ready";
        agent.lastRefreshAt = now();
        this.server.refresh();
        return {
          id: agent.id,
          status: agent.status,
          name: agentName(agent),
          interfaceUrl: agent.interfaceUrl ?? null,
          skillCount: Array.isArray(agent.card?.skills) ? agent.card.skills.length : 0,
        };
      }

      agent.card = result.card;
      agent.interfaceUrl = result.selectedInterface.url;
      agent.protocolVersion =
        agent.config.protocolVersion ?? result.selectedInterface.protocolVersion ?? "1.0";
      agent.tenant = result.selectedInterface.tenant;
      agent.etag = result.etag;
      agent.lastModified = result.lastModified;
      agent.status = "ready";
      agent.error = undefined;
      agent.lastRefreshAt = now();
      this.server.refresh();

      return {
        id: agent.id,
        status: agent.status,
        name: agentName(agent),
        interfaceUrl: agent.interfaceUrl ?? null,
        skillCount: Array.isArray(result.card.skills) ? result.card.skills.length : 0,
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
    return this.client.invokeJsonRpc(await this.ensureReady(agentId), method, params);
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
      const selectedInterface = this.client.selectJsonRpcInterface(agent, agent.card);
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
        urgency: record.statusState === "TASK_STATE_INPUT_REQUIRED" ? "medium" : "low",
      },
    };
  }
}

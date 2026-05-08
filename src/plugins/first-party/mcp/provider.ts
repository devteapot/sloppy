import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

export type McpStdioServerConfig = {
  name?: string;
  transport: "stdio";
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  envAllowlist?: string[];
  inheritEnv?: boolean;
  timeoutMs?: number;
  connectOnStart?: boolean;
};

export type McpStreamableHttpServerConfig = {
  name?: string;
  transport: "streamableHttp";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  connectOnStart?: boolean;
};

export type McpServerConfig = McpStdioServerConfig | McpStreamableHttpServerConfig;

type McpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

type McpResourceInfo = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

type McpResourceTemplateInfo = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

type McpPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
};

type McpCallToolResult = {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  toolResult?: unknown;
};

type McpReadResourceResult = {
  contents: unknown[];
};

type McpGetPromptResult = {
  description?: string;
  messages: unknown[];
};

export interface McpClientSession {
  connect(): Promise<void>;
  close(): Promise<void>;
  getServerVersion?(): unknown;
  getServerCapabilities?(): unknown;
  getInstructions?(): string | undefined;
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult>;
  listResources(): Promise<{ resources: McpResourceInfo[] }>;
  listResourceTemplates(): Promise<{ resourceTemplates: McpResourceTemplateInfo[] }>;
  readResource(params: { uri: string }): Promise<McpReadResourceResult>;
  listPrompts(): Promise<{ prompts: McpPromptInfo[] }>;
  getPrompt(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpGetPromptResult>;
}

export type CreateMcpClientSession = (
  serverId: string,
  config: McpServerConfig,
) => McpClientSession;

type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";

type McpServerState = {
  id: string;
  config: McpServerConfig;
  status: McpServerStatus;
  error?: string;
  connectedAt?: string;
  lastRefreshAt?: string;
  serverVersion?: unknown;
  capabilities?: unknown;
  instructions?: string;
  listErrors: Record<string, string>;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
  prompts: McpPromptInfo[];
  client?: McpClientSession;
};

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodeId(value: string): string {
  return encodeURIComponent(value);
}

function humanTransport(config: McpServerConfig): string {
  switch (config.transport) {
    case "stdio":
      return `stdio:${config.command.join(" ")}`;
    case "streamableHttp":
      return `streamableHttp:${config.url}`;
  }
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isToolListKnown(server: McpServerState): boolean {
  return Boolean(server.lastRefreshAt && !server.listErrors.tools);
}

function hasDestructiveTool(server: McpServerState): boolean {
  return server.tools.some((tool) => tool.annotations?.destructiveHint === true);
}

function buildHeaders(headers: Record<string, string> | undefined): HeadersInit | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }
  return headers;
}

function buildStdioEnv(config: McpStdioServerConfig): Record<string, string> {
  const env: Record<string, string> = config.inheritEnv
    ? Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => {
          const [, value] = entry;
          return typeof value === "string";
        }),
      )
    : getDefaultEnvironment();

  for (const key of config.envAllowlist ?? []) {
    const value = Bun.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...(config.env ?? {}),
  };
}

function createSdkTransport(config: McpServerConfig): Transport {
  switch (config.transport) {
    case "stdio": {
      const [command, ...args] = config.command;
      if (!command) {
        throw new Error("MCP stdio server command cannot be empty.");
      }
      return new StdioClientTransport({
        command,
        args,
        cwd: config.cwd,
        env: buildStdioEnv(config),
      });
    }
    case "streamableHttp":
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: buildHeaders(config.headers),
        },
      });
  }
}

class SdkMcpClientSession implements McpClientSession {
  private readonly client: Client;
  private readonly transport: Transport;
  private readonly timeoutMs: number | undefined;

  constructor(config: McpServerConfig) {
    this.client = new Client({
      name: "sloppy-mcp-provider",
      version: "0.0.0",
    });
    this.transport = createSdkTransport(config);
    this.timeoutMs = config.timeoutMs;
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  getServerVersion(): unknown {
    return this.client.getServerVersion();
  }

  getServerCapabilities(): unknown {
    return this.client.getServerCapabilities();
  }

  getInstructions(): string | undefined {
    return this.client.getInstructions();
  }

  async listTools(): Promise<{ tools: McpToolInfo[] }> {
    return this.client.listTools(undefined, this.requestOptions());
  }

  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult> {
    return this.client.callTool(
      params,
      undefined,
      this.requestOptions(),
    ) as Promise<McpCallToolResult>;
  }

  async listResources(): Promise<{ resources: McpResourceInfo[] }> {
    return this.client.listResources(undefined, this.requestOptions());
  }

  async listResourceTemplates(): Promise<{ resourceTemplates: McpResourceTemplateInfo[] }> {
    return this.client.listResourceTemplates(undefined, this.requestOptions());
  }

  async readResource(params: { uri: string }): Promise<McpReadResourceResult> {
    return this.client.readResource(params, this.requestOptions());
  }

  async listPrompts(): Promise<{ prompts: McpPromptInfo[] }> {
    return this.client.listPrompts(undefined, this.requestOptions());
  }

  async getPrompt(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpGetPromptResult> {
    return this.client.getPrompt(
      {
        name: params.name,
        arguments: params.arguments as Record<string, string> | undefined,
      },
      this.requestOptions(),
    );
  }

  private requestOptions(): RequestOptions | undefined {
    if (!this.timeoutMs) {
      return undefined;
    }

    return {
      timeout: this.timeoutMs,
      maxTotalTimeout: this.timeoutMs,
    };
  }
}

async function optionalList<T>(
  target: Record<string, string>,
  key: string,
  list: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await list();
  } catch (error) {
    target[key] = errorMessage(error);
    return fallback;
  }
}

export class McpProvider {
  readonly server: SlopServer;
  private readonly createClientSession: CreateMcpClientSession;
  private readonly connectOnStart: boolean;
  private readonly servers = new Map<string, McpServerState>();

  constructor(
    options: {
      servers?: Record<string, McpServerConfig>;
      connectOnStart?: boolean;
      createClientSession?: CreateMcpClientSession;
    } = {},
  ) {
    this.connectOnStart = options.connectOnStart ?? true;
    this.createClientSession =
      options.createClientSession ?? ((_, config) => new SdkMcpClientSession(config));

    for (const [id, config] of Object.entries(options.servers ?? {})) {
      this.servers.set(id, {
        id,
        config,
        status: "disconnected",
        listErrors: {},
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
      });
    }

    this.server = createSlopServer({
      id: "mcp",
      name: "MCP",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("servers", () => this.buildServersDescriptor());
  }

  start(): void {
    if (!this.connectOnStart) {
      return;
    }

    void this.refreshStartServers();
  }

  stop(): void {
    for (const server of this.servers.values()) {
      void server.client?.close();
      server.client = undefined;
      server.status = "disconnected";
    }
    this.server.stop();
  }

  private async refreshStartServers(): Promise<void> {
    await Promise.all(
      [...this.servers.values()]
        .filter((server) => server.config.connectOnStart ?? true)
        .map((server) => this.refreshServer(server.id).catch(() => undefined)),
    );
  }

  private requireServer(serverId: string): McpServerState {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  private async ensureConnected(server: McpServerState): Promise<McpClientSession> {
    if (server.client && server.status === "connected") {
      return server.client;
    }

    await server.client?.close().catch(() => undefined);
    server.client = this.createClientSession(server.id, server.config);
    server.status = "connecting";
    server.error = undefined;
    this.server.refresh();

    await server.client.connect();
    server.status = "connected";
    server.connectedAt = now();
    server.serverVersion = server.client.getServerVersion?.();
    server.capabilities = server.client.getServerCapabilities?.();
    server.instructions = server.client.getInstructions?.();
    this.server.refresh();
    return server.client;
  }

  private async refreshServer(serverId: string): Promise<{
    id: string;
    status: McpServerStatus;
    tools: number;
    resources: number;
    resourceTemplates: number;
    prompts: number;
    listErrors: Record<string, string>;
  }> {
    const server = this.requireServer(serverId);
    server.status = "connecting";
    server.error = undefined;
    server.listErrors = {};
    this.server.refresh();

    try {
      const client = await this.ensureConnected(server);
      const listErrors: Record<string, string> = {};
      const tools = await optionalList(
        listErrors,
        "tools",
        async () => (await client.listTools()).tools,
        [],
      );
      const resources = await optionalList(
        listErrors,
        "resources",
        async () => (await client.listResources()).resources,
        [],
      );
      const resourceTemplates = await optionalList(
        listErrors,
        "resource_templates",
        async () => (await client.listResourceTemplates()).resourceTemplates,
        [],
      );
      const prompts = await optionalList(
        listErrors,
        "prompts",
        async () => (await client.listPrompts()).prompts,
        [],
      );

      server.tools = tools;
      server.resources = resources;
      server.resourceTemplates = resourceTemplates;
      server.prompts = prompts;
      server.listErrors = listErrors;
      server.status = "connected";
      server.lastRefreshAt = now();
      server.error = undefined;
      this.server.refresh();

      return {
        id: server.id,
        status: server.status,
        tools: server.tools.length,
        resources: server.resources.length,
        resourceTemplates: server.resourceTemplates.length,
        prompts: server.prompts.length,
        listErrors,
      };
    } catch (error) {
      server.status = "error";
      server.error = errorMessage(error);
      server.lastRefreshAt = now();
      this.server.refresh();
      throw error;
    }
  }

  private async refreshAllServers(): Promise<
    Array<{
      id: string;
      status: McpServerStatus;
      error?: string;
      tools: number;
      resources: number;
      resourceTemplates: number;
      prompts: number;
    }>
  > {
    return Promise.all(
      [...this.servers.keys()].map(async (serverId) => {
        try {
          const result = await this.refreshServer(serverId);
          return {
            id: result.id,
            status: result.status,
            tools: result.tools,
            resources: result.resources,
            resourceTemplates: result.resourceTemplates,
            prompts: result.prompts,
          };
        } catch (error) {
          const server = this.requireServer(serverId);
          return {
            id: serverId,
            status: server.status,
            error: errorMessage(error),
            tools: server.tools.length,
            resources: server.resources.length,
            resourceTemplates: server.resourceTemplates.length,
            prompts: server.prompts.length,
          };
        }
      }),
    );
  }

  private async disconnectServer(
    serverId: string,
  ): Promise<{ id: string; status: "disconnected" }> {
    const server = this.requireServer(serverId);
    await server.client?.close().catch(() => undefined);
    server.client = undefined;
    server.status = "disconnected";
    server.error = undefined;
    this.server.refresh();
    return { id: serverId, status: "disconnected" };
  }

  private async disconnectAllServers(): Promise<Array<{ id: string; status: "disconnected" }>> {
    return Promise.all([...this.servers.keys()].map((serverId) => this.disconnectServer(serverId)));
  }

  private async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
  ): Promise<McpCallToolResult> {
    const server = this.requireServer(serverId);
    if (!isToolListKnown(server)) {
      await this.refreshServer(serverId);
    }
    const tool = server.tools.find((item) => item.name === toolName);
    if (!tool) {
      const listError = server.listErrors.tools;
      throw new Error(
        listError
          ? `Cannot call MCP tool '${toolName}' on server '${serverId}' because the tool list is unavailable: ${listError}`
          : `Unknown MCP tool '${toolName}' on server '${serverId}'. Refresh the server and call one of the listed tools.`,
      );
    }
    const client = await this.ensureConnected(server);
    return client.callTool({
      name: tool.name,
      arguments: maybeRecord(args) ?? {},
    });
  }

  private async readResource(serverId: string, uri: string): Promise<McpReadResourceResult> {
    const server = this.requireServer(serverId);
    const client = await this.ensureConnected(server);
    return client.readResource({ uri });
  }

  private async getPrompt(
    serverId: string,
    promptName: string,
    args: unknown,
  ): Promise<McpGetPromptResult> {
    const server = this.requireServer(serverId);
    const client = await this.ensureConnected(server);
    return client.getPrompt({
      name: promptName,
      arguments: maybeRecord(args) ?? {},
    });
  }

  private buildSessionDescriptor() {
    const servers = [...this.servers.values()];
    const connected = servers.filter((server) => server.status === "connected").length;
    const errored = servers.filter((server) => server.status === "error").length;
    const tools = servers.reduce((sum, server) => sum + server.tools.length, 0);
    const resources = servers.reduce((sum, server) => sum + server.resources.length, 0);
    const prompts = servers.reduce((sum, server) => sum + server.prompts.length, 0);

    return {
      type: "context",
      props: {
        server_count: servers.length,
        connected_count: connected,
        error_count: errored,
        tool_count: tools,
        resource_count: resources,
        prompt_count: prompts,
      },
      summary:
        "MCP compatibility provider exposing configured MCP servers as SLOP state and affordances.",
      actions: {
        refresh_all: action(async () => this.refreshAllServers(), {
          label: "Refresh MCP Servers",
          description:
            "Connect to every configured MCP server and refresh tools/resources/prompts.",
          idempotent: true,
          estimate: "slow",
        }),
        disconnect_all: action(async () => this.disconnectAllServers(), {
          label: "Disconnect MCP Servers",
          description: "Close all active MCP server client connections.",
          idempotent: true,
          estimate: "fast",
        }),
      },
      meta: {
        focus: errored > 0,
        salience: servers.length > 0 ? 0.75 : 0.25,
        urgency: errored > 0 ? ("medium" as const) : ("low" as const),
      },
    };
  }

  private buildServersDescriptor() {
    const items: ItemDescriptor[] = [...this.servers.values()].map((server) =>
      this.buildServerItem(server),
    );

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Configured MCP servers and their exposed tools/resources/prompts.",
      items,
    };
  }

  private buildServerItem(server: McpServerState): ItemDescriptor {
    return {
      id: nodeId(server.id),
      props: {
        id: server.id,
        name: server.config.name ?? server.id,
        status: server.status,
        transport: humanTransport(server.config),
        error: server.error ?? null,
        connected_at: server.connectedAt ?? null,
        last_refresh_at: server.lastRefreshAt ?? null,
        tool_count: server.tools.length,
        resource_count: server.resources.length,
        resource_template_count: server.resourceTemplates.length,
        prompt_count: server.prompts.length,
        list_errors: server.listErrors,
        server_version: server.serverVersion ?? null,
        capabilities: server.capabilities ?? null,
        instructions: server.instructions ?? null,
      },
      summary:
        server.status === "error"
          ? `${server.config.name ?? server.id}: ${server.error ?? "MCP server error"}`
          : `${server.config.name ?? server.id}: ${server.tools.length} tools, ${server.resources.length} resources, ${server.prompts.length} prompts`,
      actions: {
        refresh: action(async () => this.refreshServer(server.id), {
          label: "Refresh",
          description: "Connect to this MCP server and refresh tools/resources/prompts.",
          idempotent: true,
          estimate: "slow",
        }),
        disconnect: action(async () => this.disconnectServer(server.id), {
          label: "Disconnect",
          description: "Close this MCP server connection.",
          idempotent: true,
          estimate: "fast",
        }),
        call_tool: action(
          {
            tool_name: "string",
            arguments: {
              type: "object",
              description: "JSON arguments for the MCP tool.",
            },
          },
          async ({ tool_name, arguments: args }) => this.callTool(server.id, tool_name, args),
          {
            label: "Call Tool",
            description: "Call a named MCP tool on this server.",
            dangerous: !isToolListKnown(server) || hasDestructiveTool(server),
            estimate: "slow",
          },
        ),
        read_resource: action(
          {
            uri: "string",
          },
          async ({ uri }) => this.readResource(server.id, uri),
          {
            label: "Read Resource",
            description: "Read a named MCP resource URI from this server.",
            idempotent: true,
            estimate: "slow",
          },
        ),
        get_prompt: action(
          {
            prompt_name: "string",
            arguments: {
              type: "object",
              description: "JSON arguments for the MCP prompt.",
            },
          },
          async ({ prompt_name, arguments: args }) => this.getPrompt(server.id, prompt_name, args),
          {
            label: "Get Prompt",
            description: "Retrieve a named MCP prompt from this server.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
      children: {
        tools: this.buildToolsDescriptor(server),
        resources: this.buildResourcesDescriptor(server),
        "resource-templates": this.buildResourceTemplatesDescriptor(server),
        prompts: this.buildPromptsDescriptor(server),
      },
      meta: {
        salience: server.status === "connected" ? 0.75 : 0.55,
        urgency: server.status === "error" ? "medium" : "low",
      },
    };
  }

  private buildToolsDescriptor(server: McpServerState) {
    return {
      type: "collection",
      props: {
        count: server.tools.length,
      },
      summary: `MCP tools exposed by ${server.config.name ?? server.id}.`,
      items: server.tools.map((tool) => this.buildToolItem(server, tool)),
    };
  }

  private buildToolItem(server: McpServerState, tool: McpToolInfo): ItemDescriptor {
    return {
      id: nodeId(tool.name),
      props: {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: tool.description ?? null,
        input_schema: tool.inputSchema ?? null,
        output_schema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? null,
      },
      summary: tool.description ?? tool.title ?? tool.name,
      actions: {
        call: action(
          {
            arguments: {
              type: "object",
              description: "JSON arguments for this MCP tool.",
            },
          },
          async ({ arguments: args }) => this.callTool(server.id, tool.name, args),
          {
            label: tool.title ?? tool.name,
            description: tool.description ?? `Call MCP tool ${tool.name}.`,
            dangerous: tool.annotations?.destructiveHint === true,
            idempotent: tool.annotations?.idempotentHint === true,
            estimate: tool.annotations?.openWorldHint === true ? "slow" : "fast",
          },
        ),
      },
      meta: {
        salience: tool.annotations?.readOnlyHint === true ? 0.65 : 0.75,
      },
    };
  }

  private buildResourcesDescriptor(server: McpServerState) {
    return {
      type: "collection",
      props: {
        count: server.resources.length,
      },
      summary: `MCP resources exposed by ${server.config.name ?? server.id}.`,
      items: server.resources.map((resource) => this.buildResourceItem(server, resource)),
    };
  }

  private buildResourceItem(server: McpServerState, resource: McpResourceInfo): ItemDescriptor {
    return {
      id: nodeId(resource.uri),
      props: {
        uri: resource.uri,
        name: resource.name,
        title: resource.title ?? null,
        description: resource.description ?? null,
        mime_type: resource.mimeType ?? null,
        size: resource.size ?? null,
      },
      summary: resource.description ?? resource.title ?? resource.name,
      actions: {
        read: action(async () => this.readResource(server.id, resource.uri), {
          label: "Read",
          description: `Read MCP resource ${resource.uri}.`,
          idempotent: true,
          estimate: "fast",
        }),
      },
      meta: {
        salience: 0.6,
      },
    };
  }

  private buildResourceTemplatesDescriptor(server: McpServerState) {
    return {
      type: "collection",
      props: {
        count: server.resourceTemplates.length,
      },
      summary: `MCP resource templates exposed by ${server.config.name ?? server.id}.`,
      items: server.resourceTemplates.map((template) => ({
        id: nodeId(template.uriTemplate),
        props: {
          uri_template: template.uriTemplate,
          name: template.name,
          title: template.title ?? null,
          description: template.description ?? null,
          mime_type: template.mimeType ?? null,
        },
        summary: template.description ?? template.title ?? template.name,
        meta: {
          salience: 0.45,
        },
      })),
    };
  }

  private buildPromptsDescriptor(server: McpServerState) {
    return {
      type: "collection",
      props: {
        count: server.prompts.length,
      },
      summary: `MCP prompts exposed by ${server.config.name ?? server.id}.`,
      items: server.prompts.map((prompt) => this.buildPromptItem(server, prompt)),
    };
  }

  private buildPromptItem(server: McpServerState, prompt: McpPromptInfo): ItemDescriptor {
    return {
      id: nodeId(prompt.name),
      props: {
        name: prompt.name,
        title: prompt.title ?? null,
        description: prompt.description ?? null,
        arguments: prompt.arguments ?? [],
      },
      summary: prompt.description ?? prompt.title ?? prompt.name,
      actions: {
        get: action(
          {
            arguments: {
              type: "object",
              description: "JSON arguments for this MCP prompt.",
            },
          },
          async ({ arguments: args }) => this.getPrompt(server.id, prompt.name, args),
          {
            label: prompt.title ?? prompt.name,
            description: prompt.description ?? `Retrieve MCP prompt ${prompt.name}.`,
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
      meta: {
        salience: 0.6,
      },
    };
  }
}

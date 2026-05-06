import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import {
  type McpClientSession,
  McpProvider,
  type McpServerConfig,
} from "../src/providers/builtin/mcp";

type FakeCall = {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown> | undefined;
};

const providers: McpProvider[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  while (providers.length > 0) {
    providers.pop()?.stop();
  }

  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

class FakeMcpClientSession implements McpClientSession {
  connected = false;
  closed = false;
  calls: FakeCall[];
  listResourcesError?: string;

  constructor(
    private readonly serverId: string,
    calls: FakeCall[],
    options: { listResourcesError?: string } = {},
  ) {
    this.calls = calls;
    this.listResourcesError = options.listResourcesError;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  getServerVersion(): unknown {
    return { name: "fake-mcp", version: "1.0.0" };
  }

  getServerCapabilities(): unknown {
    return {
      tools: {},
      resources: {},
      prompts: {},
    };
  }

  getInstructions(): string {
    return "Fake MCP server for provider tests.";
  }

  async listTools() {
    return {
      tools: [
        {
          name: "echo",
          title: "Echo",
          description: "Echo input text.",
          inputSchema: {
            type: "object" as const,
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
          },
        },
        {
          name: "delete-record",
          description: "Delete a record.",
          inputSchema: {
            type: "object" as const,
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
          annotations: {
            destructiveHint: true,
          },
        },
      ],
    };
  }

  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    this.calls.push({
      serverId: this.serverId,
      toolName: params.name,
      arguments: params.arguments,
    });

    return {
      content: [
        {
          type: "text",
          text: `called ${params.name}`,
        },
      ],
    };
  }

  async listResources() {
    if (this.listResourcesError) {
      throw new Error(this.listResourcesError);
    }

    return {
      resources: [
        {
          uri: "file:///tmp/demo.txt",
          name: "demo.txt",
          description: "Demo resource",
          mimeType: "text/plain",
        },
      ],
    };
  }

  async listResourceTemplates() {
    return {
      resourceTemplates: [
        {
          uriTemplate: "file:///{path}",
          name: "file-template",
          description: "File template",
        },
      ],
    };
  }

  async readResource(params: { uri: string }) {
    return {
      contents: [
        {
          uri: params.uri,
          text: "resource body",
          mimeType: "text/plain",
        },
      ],
    };
  }

  async listPrompts() {
    return {
      prompts: [
        {
          name: "summarize",
          description: "Summarize text.",
          arguments: [{ name: "text", required: true }],
        },
      ],
    };
  }

  async getPrompt(params: { name: string; arguments?: Record<string, unknown> }) {
    return {
      description: `Prompt ${params.name}`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: String(params.arguments?.text ?? ""),
          },
        },
      ],
    };
  }
}

function createProvider(options: {
  servers: Record<string, McpServerConfig>;
  listResourcesError?: string;
}) {
  const calls: FakeCall[] = [];
  const provider = new McpProvider({
    servers: options.servers,
    connectOnStart: false,
    createClientSession: (serverId) =>
      new FakeMcpClientSession(serverId, calls, {
        listResourcesError: options.listResourcesError,
      }),
  });
  providers.push(provider);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  return { provider, consumer, calls };
}

describe("McpProvider", () => {
  test("connects to a real stdio MCP server through the SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-mcp-provider-"));
    tempPaths.push(root);
    const scriptPath = join(root, "fixture-server.mjs");
    const sdkServerUrl = pathToFileURL(
      join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js"),
    ).href;
    const sdkStdioUrl = pathToFileURL(
      join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"),
    ).href;
    const zodUrl = pathToFileURL(join(process.cwd(), "node_modules/zod/index.js")).href;
    await writeFile(
      scriptPath,
      [
        `import { McpServer } from "${sdkServerUrl}";`,
        `import { StdioServerTransport } from "${sdkStdioUrl}";`,
        `import { z } from "${zodUrl}";`,
        "",
        'const server = new McpServer({ name: "fixture-mcp", version: "1.0.0" });',
        'server.registerTool("greet", {',
        '  title: "Greet",',
        '  description: "Greet a named target.",',
        "  inputSchema: { name: z.string() },",
        "  annotations: { readOnlyHint: true, idempotentHint: true },",
        "}, async ({ name }) => ({",
        '  content: [{ type: "text", text: "Hello, " + name + "!" }],',
        "}));",
        'server.registerResource("fixture-resource", "fixture://message", {',
        '  title: "Fixture Resource",',
        '  description: "A fixture resource.",',
        '  mimeType: "text/plain",',
        "}, async () => ({",
        '  contents: [{ uri: "fixture://message", text: "resource text" }],',
        "}));",
        "",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );

    const provider = new McpProvider({
      connectOnStart: false,
      servers: {
        fixture: {
          transport: "stdio",
          command: [process.execPath, scriptPath],
          cwd: process.cwd(),
          timeoutMs: 5000,
        },
      },
    });
    providers.push(provider);
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    await consumer.connect();
    const refresh = await consumer.invoke("/servers/fixture", "refresh", {});
    expect(refresh.status).toBe("ok");

    const session = await consumer.query("/session", 2);
    expect(session.properties?.tool_count).toBe(1);
    expect(session.properties?.resource_count).toBe(1);

    const call = await consumer.invoke("/servers/fixture/tools/greet", "call", {
      arguments: { name: "Sloppy" },
    });
    expect(call.status).toBe("ok");
    expect((call.data as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "Hello, Sloppy!",
    );
  });

  test("exposes MCP servers, tools, resources, and prompts as SLOP state", async () => {
    const { consumer, calls } = createProvider({
      servers: {
        demo: {
          name: "Demo MCP",
          transport: "stdio",
          command: ["fake-mcp"],
        },
      },
    });

    await consumer.connect();
    await consumer.subscribe("/", 6);

    const initialSession = await consumer.query("/session", 2);
    expect(initialSession.properties?.server_count).toBe(1);
    expect(initialSession.properties?.tool_count).toBe(0);

    const refresh = await consumer.invoke("/servers/demo", "refresh", {});
    expect(refresh.status).toBe("ok");

    const session = await consumer.query("/session", 2);
    expect(session.properties?.connected_count).toBe(1);
    expect(session.properties?.tool_count).toBe(2);
    expect(session.properties?.resource_count).toBe(1);
    expect(session.properties?.prompt_count).toBe(1);

    const tools = await consumer.query("/servers/demo/tools", 2);
    expect(tools.children?.map((child) => child.id)).toEqual(["echo", "delete-record"]);
    const destructiveTool = await consumer.query("/servers/demo/tools/delete-record", 1);
    expect(destructiveTool.affordances?.[0]?.dangerous).toBe(true);
    const server = await consumer.query("/servers/demo", 1);
    expect(
      server.affordances?.some(
        (affordance) => affordance.action === "call_tool" && affordance.dangerous === true,
      ),
    ).toBe(true);

    const call = await consumer.invoke("/servers/demo/tools/echo", "call", {
      arguments: { text: "hello" },
    });
    expect(call.status).toBe("ok");
    expect(calls).toEqual([
      {
        serverId: "demo",
        toolName: "echo",
        arguments: { text: "hello" },
      },
    ]);

    const read = await consumer.invoke(
      "/servers/demo/resources/file%3A%2F%2F%2Ftmp%2Fdemo.txt",
      "read",
      {},
    );
    expect(read.status).toBe("ok");
    expect((read.data as { contents: Array<{ text: string }> }).contents[0]?.text).toBe(
      "resource body",
    );

    const prompt = await consumer.invoke("/servers/demo/prompts/summarize", "get", {
      arguments: { text: "content" },
    });
    expect(prompt.status).toBe("ok");
    expect(
      (prompt.data as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text,
    ).toBe("content");
  });

  test("generic call_tool is dangerous before discovery and rejects unknown tool names", async () => {
    const { consumer, calls } = createProvider({
      servers: {
        demo: {
          name: "Demo MCP",
          transport: "stdio",
          command: ["fake-mcp"],
        },
      },
    });

    await consumer.connect();

    const initialServer = await consumer.query("/servers/demo", 1);
    expect(
      initialServer.affordances?.some(
        (affordance) => affordance.action === "call_tool" && affordance.dangerous === true,
      ),
    ).toBe(true);

    const missing = await consumer.invoke("/servers/demo", "call_tool", {
      tool_name: "unknown-tool",
      arguments: {},
    });
    expect(missing.status).toBe("error");
    expect(missing.error?.message).toContain("Unknown MCP tool 'unknown-tool'");
    expect(calls).toEqual([]);

    const known = await consumer.invoke("/servers/demo", "call_tool", {
      tool_name: "echo",
      arguments: { text: "hello" },
    });
    expect(known.status).toBe("ok");
    expect(calls).toEqual([
      {
        serverId: "demo",
        toolName: "echo",
        arguments: { text: "hello" },
      },
    ]);
  });

  test("keeps a server connected when one optional MCP list is unsupported", async () => {
    const { consumer } = createProvider({
      servers: {
        partial: {
          transport: "streamableHttp",
          url: "https://mcp.example.test/mcp",
        },
      },
      listResourcesError: "resources not supported",
    });

    await consumer.connect();

    const refresh = await consumer.invoke("/servers/partial", "refresh", {});
    expect(refresh.status).toBe("ok");

    const server = await consumer.query("/servers/partial", 2);
    expect(server.properties?.status).toBe("connected");
    expect(server.properties?.resource_count).toBe(0);
    expect(server.properties?.list_errors).toEqual({
      resources: "resources not supported",
    });
  });
});

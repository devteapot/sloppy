import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, createSlopServer } from "@slop-ai/server";
import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import { runLoop } from "../src/core/loop";
import type { CredentialStore } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import type { ModelBackend } from "../src/llm/types";
import { InProcessTransport } from "../src/providers/in-process";
import { createTestConfig } from "./helpers/config";

type MockEngineScenario = "text" | "tool";

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  async getStatus() {
    return "available" as const;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}
}

class MockEngineServer {
  private server: Server | null = null;
  private generationCount = 0;

  constructor(
    readonly socketPath: string,
    private readonly scenario: MockEngineScenario,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private handleSocket(socket: Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        this.handleMessage(socket, message);
      }
    });
  }

  private handleMessage(
    socket: Socket,
    message: { id: string; method: string; params?: Record<string, unknown> },
  ): void {
    switch (message.method) {
      case "engine.describe":
        this.write(socket, {
          type: "response",
          id: message.id,
          ok: true,
          result: {
            protocol: "sloppy.engine",
            protocolVersion: 1,
            engine: "ds4",
            model: { id: "mock-ds4", contextWindowTokens: 1000000 },
            runtime: { backend: "mock" },
            capabilities: {
              renderedTextInput: true,
              prefixSync: true,
              textStreaming: true,
              prefillProgress: true,
            },
          },
        });
        break;
      case "session.create":
        this.write(socket, {
          type: "response",
          id: message.id,
          ok: true,
          result: { sessionId: "mock-session" },
        });
        break;
      case "session.sync":
        if (!isDs4RenderedSync(message.params)) {
          this.write(socket, {
            type: "response",
            id: message.id,
            ok: false,
            error: {
              code: "invalid_request",
              message: "session.sync prefix was not rendered DS4 chat text",
            },
          });
          break;
        }
        this.write(socket, {
          type: "response",
          id: message.id,
          ok: true,
          result: {
            sessionId: "mock-session",
            position: 42,
            evaluatedTokens: 12,
            cachedPrefixTokens: 4,
          },
        });
        break;
      case "session.generate":
        this.write(socket, {
          type: "response",
          id: message.id,
          ok: true,
          result: { accepted: true },
        });
        this.generate(socket, message.id);
        break;
      case "session.destroy":
      case "session.interrupt":
        this.write(socket, { type: "response", id: message.id, ok: true, result: {} });
        break;
      default:
        this.write(socket, {
          type: "response",
          id: message.id,
          ok: false,
          error: { code: "unsupported", message: `Unsupported method: ${message.method}` },
        });
        break;
    }
  }

  private generate(socket: Socket, id: string): void {
    this.generationCount += 1;
    if (this.scenario === "text") {
      this.event(socket, id, { type: "text", text: "Hello " });
      this.event(socket, id, { type: "token", id: 1, text: "engine." });
      this.event(socket, id, { type: "done", reason: "eos" });
      return;
    }

    if (this.generationCount === 1) {
      this.event(socket, id, { type: "text", text: "I need to inspect that.\n<DSML｜tool" });
      this.event(socket, id, {
        type: "text",
        text: '_calls>\n<DSML｜invoke name="demo__workspace__read">\n<DSML｜parameter name="path" string="true">README.md</DSML｜parameter>\n</DSML｜invoke>\n</DSML｜tool_calls>',
      });
      this.event(socket, id, { type: "done", reason: "stop" });
      return;
    }

    this.event(socket, id, { type: "text", text: "The README says Sloppy." });
    this.event(socket, id, { type: "done", reason: "eos" });
  }

  private write(socket: Socket, message: unknown): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }

  private event(socket: Socket, id: string, event: unknown): void {
    this.write(socket, { type: "event", id, event });
  }
}

function isDs4RenderedSync(params: Record<string, unknown> | undefined): boolean {
  const prefix = params?.prefix;
  if (!prefix || typeof prefix !== "object" || Array.isArray(prefix)) {
    return false;
  }
  const text = (prefix as { text?: unknown }).text;
  return (
    typeof text === "string" &&
    text.startsWith("<｜begin▁of▁sentence｜>") &&
    text.includes("<｜User｜>") &&
    text.endsWith("<｜Assistant｜></think>")
  );
}

function createEngineConfig(socketPath: string): SloppyConfig {
  return createTestConfig({
    llm: {
      defaultProfileId: "mock-ds4",
      profiles: [
        {
          id: "mock-ds4",
          kind: "engine",
          label: "Mock DS4",
          engine: "ds4",
          model: "mock-ds4",
          dialect: "dsml",
          transport: {
            type: "unix",
            path: socketPath,
          },
          contextWindowTokens: 1000000,
        },
      ],
    },
    agent: { maxIterations: 4 },
  });
}

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) {
    await item();
  }
});

describe("engine-native model backend", () => {
  test("streams final text through a DS4-compatible Unix NDJSON engine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sloppy-engine-text-"));
    const socketPath = join(dir, "engine.sock");
    const engine = new MockEngineServer(socketPath, "text");
    await engine.start();
    cleanup.push(
      () => rm(dir, { recursive: true, force: true }),
      () => engine.close(),
    );

    const config = createEngineConfig(socketPath);
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    const backend = await manager.createAdapter();
    let streamed = "";

    const response = await backend.chat({
      system: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "Say hi." }] }],
      maxTokens: 64,
      onText: (chunk) => {
        streamed += chunk;
      },
    });

    expect((backend as ModelBackend).kind).toBe("engine");
    expect(streamed).toBe("Hello engine.");
    expect(response).toEqual({
      content: [{ type: "text", text: "Hello engine." }],
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 1 },
    });
  });

  test("parses DSML tool calls and lets the normal SLOP tool loop continue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sloppy-engine-tool-"));
    const socketPath = join(dir, "engine.sock");
    const engine = new MockEngineServer(socketPath, "tool");
    await engine.start();
    cleanup.push(
      () => rm(dir, { recursive: true, force: true }),
      () => engine.close(),
    );

    const server = createSlopServer({ id: "demo", name: "Demo" });
    let providerInvocations = 0;
    server.register("workspace", () => ({
      type: "collection",
      actions: {
        read: action(
          { path: "string" },
          async ({ path }) => {
            providerInvocations += 1;
            return { content: `read:${path}` };
          },
          {
            label: "Read",
            description: "Read a path.",
            estimate: "instant",
          },
        ),
      },
    }));
    cleanup.push(() => server.stop());

    const config = createEngineConfig(socketPath);
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    const hub = new ConsumerHub(
      [
        {
          id: "demo",
          name: "Demo",
          kind: "first-party",
          transport: new InProcessTransport(server),
          transportLabel: "in-process:test",
          stop: () => server.stop(),
        },
      ],
      config,
    );
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    history.addUserText("Read the README.");
    const streamed: string[] = [];

    try {
      await hub.connect();
      const result = await runLoop({
        config,
        hub,
        history,
        llm: await manager.createAdapter(),
        onText: (chunk) => streamed.push(chunk),
      });

      expect(result).toEqual({
        status: "completed",
        response: "The README says Sloppy.",
        usage: { inputTokens: 24, outputTokens: 0 },
      });
      expect(providerInvocations).toBe(1);
      expect(streamed.join("")).toBe("I need to inspect that.\nThe README says Sloppy.");
    } finally {
      hub.shutdown();
    }
  });
});

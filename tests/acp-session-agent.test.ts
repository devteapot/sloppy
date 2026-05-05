import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { AcpSessionAgent } from "../src/runtime/acp";
import { AgentSessionProvider } from "../src/session/provider";
import { SessionRuntime } from "../src/session/runtime";

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
    profiles: [],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 12,
    contextBudgetTokens: 24000,
    minSalience: 0.2,
    overviewDepth: 2,
    overviewMaxNodes: 200,
    detailDepth: 4,
    detailMaxNodes: 200,
    historyTurns: 8,
    toolResultMaxChars: 16000,
  },
  maxToolResultSize: 4096,
  providers: {
    builtin: {
      terminal: false,
      filesystem: false,
      memory: false,
      skills: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
      metaRuntime: false,
      spec: false,
      vision: false,
    },
    discovery: {
      enabled: false,
      paths: [],
    },
    terminal: {
      cwd: ".",
      historyLimit: 10,
      syncTimeoutMs: 30000,
    },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: {
      maxMemories: 500,
      defaultWeight: 0.5,
      compactThreshold: 0.2,
    },
    skills: {
      skillsDir: "~/.hermes/skills",
    },
    web: {
      historyLimit: 20,
    },
    browser: {
      viewportWidth: 1280,
      viewportHeight: 720,
    },
    cron: {
      maxJobs: 50,
    },
    messaging: {
      maxMessages: 500,
    },
    delegation: {
      maxAgents: 10,
    },
    metaRuntime: { globalRoot: "~/.sloppy/meta-runtime", workspaceRoot: ".sloppy/meta-runtime" },
    vision: {
      maxImages: 50,
      defaultWidth: 512,
      defaultHeight: 512,
    },
  },
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeAcpAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "sloppy-acp-test-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-agent.mjs");
  const sdkUrl = pathToFileURL(
    join(process.cwd(), "node_modules", "@agentclientprotocol", "sdk", "dist", "acp.js"),
  ).href;
  writeFileSync(
    scriptPath,
    `
import * as acp from ${JSON.stringify(sdkUrl)};
import { Readable, Writable } from "node:stream";

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
    this.controllers = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession() {
    const sessionId = "fake-session";
    return { sessionId };
  }

  async prompt(params) {
    const text = params.prompt.find((block) => block.type === "text")?.text ?? "";
    const controller = new AbortController();
    this.controllers.set(params.sessionId, controller);
    try {
      if (text.includes("approval")) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before approval " },
          },
        });
        const toolCall = {
          toolCallId: "tool-1",
          title: "Write demo file",
          kind: "edit",
          status: "pending",
          rawInput: { path: "demo.txt" },
        };
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            ...toolCall,
          },
        });
        const permission = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall,
          options: [
            { kind: "allow_once", name: "Allow once", optionId: "allow" },
            { kind: "reject_once", name: "Reject once", optionId: "reject" },
          ],
        });
        if (permission.outcome.outcome === "cancelled") {
          return { stopReason: "cancelled" };
        }
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: permission.outcome.optionId === "allow" ? "completed" : "failed",
            rawOutput: { optionId: permission.outcome.optionId },
          },
        });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: permission.outcome.optionId === "allow" ? "approved" : "rejected",
            },
          },
        });
        return { stopReason: "end_turn" };
      }

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from acp" },
        },
      });
      return { stopReason: "end_turn" };
    } finally {
      this.controllers.delete(params.sessionId);
    }
  }

  async cancel(params) {
    this.controllers.get(params.sessionId)?.abort();
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );
  return scriptPath;
}

function createRuntime(scriptPath: string): SessionRuntime {
  return new SessionRuntime({
    config: TEST_CONFIG,
    sessionId: "acp-session",
    title: "ACP session",
    requiresLlmProfile: false,
    externalAgentState: {
      provider: "acp",
      model: "fake",
      profileId: "acp-fake",
      label: "ACP fake",
    },
    agentFactory: (callbacks) =>
      new AcpSessionAgent({
        adapterId: "fake",
        adapter: {
          command: ["node", scriptPath],
        },
        callbacks,
        workspaceRoot: process.cwd(),
      }),
  });
}

async function connect(runtime: SessionRuntime): Promise<{
  provider: AgentSessionProvider;
  consumer: SlopConsumer;
}> {
  const provider = new AgentSessionProvider(runtime, {
    providerId: "sloppy-acp-session",
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await runtime.start();
  await consumer.connect();
  await consumer.subscribe("/", 5);
  return { provider, consumer };
}

async function waitFor<T>(check: () => T | null, timeoutMs = 5000, intervalMs = 25): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("AcpSessionAgent", () => {
  test("streams ACP text through the session provider without LLM credentials", async () => {
    const runtime = createRuntime(createFakeAcpAgent());
    const { provider, consumer } = await connect(runtime);

    try {
      const llm = await consumer.query("/llm", 2);
      expect(llm.properties?.status).toBe("ready");
      expect(llm.properties?.selected_provider).toBe("acp");

      const sendResult = await consumer.invoke("/composer", "send_message", {
        text: "hello",
      });
      expect(sendResult.status).toBe("ok");

      await runtime.waitForIdle();
      const assistant = runtime.store
        .getSnapshot()
        .transcript.find((message) => message.role === "assistant");
      expect(assistant?.content[0]?.type).toBe("text");
      expect(assistant?.content[0]?.type === "text" ? assistant.content[0].text : "").toBe(
        "hello from acp",
      );
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("surfaces ACP permission requests as session approvals and resumes on approve", async () => {
    const runtime = createRuntime(createFakeAcpAgent());
    const { provider, consumer } = await connect(runtime);

    try {
      const sendResult = await consumer.invoke("/composer", "send_message", {
        text: "needs approval",
      });
      expect(sendResult.status).toBe("ok");

      const approval = await waitFor(() => {
        return (
          runtime.store
            .getSnapshot()
            .approvals.find((item) => item.status === "pending" && item.provider === "acp:fake") ??
          null
        );
      });
      expect(approval.action).toBe("edit");
      expect(approval.canApprove).toBe(true);
      expect(approval.canReject).toBe(true);

      const approveResult = await consumer.invoke(`/approvals/${approval.id}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      await runtime.waitForIdle();
      const snapshot = runtime.store.getSnapshot();
      const resolved = snapshot.approvals.find((item) => item.id === approval.id);
      expect(resolved?.status).toBe("approved");
      const assistant = snapshot.transcript.find((message) => message.role === "assistant");
      expect(assistant?.content[0]?.type).toBe("text");
      expect(assistant?.content[0]?.type === "text" ? assistant.content[0].text : "").toContain(
        "approved",
      );
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });
});

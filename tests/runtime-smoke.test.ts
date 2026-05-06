import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SloppyConfig } from "../src/config/schema";
import type { LlmProfileManager, LlmStateSnapshot } from "../src/llm/profile-manager";
import type { LlmAdapter } from "../src/llm/types";
import { runRuntimeSmoke } from "../src/runtime/smoke-runner";

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    profiles: [],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 4,
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
      metaRuntime: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
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
    metaRuntime: {
      globalRoot: "~/.sloppy/meta-runtime",
      workspaceRoot: ".sloppy/meta-runtime",
    },
    vision: {
      maxImages: 50,
      defaultWidth: 512,
      defaultHeight: 512,
    },
  },
};

const READY_LLM_STATE: LlmStateSnapshot = {
  status: "ready" as const,
  message: "ready",
  activeProfileId: "stub",
  selectedProvider: "openai",
  selectedModel: "stub-model",
  secureStoreKind: "keychain",
  secureStoreStatus: "available",
  profiles: [
    {
      id: "stub",
      label: "Stub",
      provider: "openai" as const,
      model: "stub-model",
      apiKeyEnv: "STUB_KEY",
      baseUrl: undefined,
      isDefault: true,
      hasKey: true,
      keySource: "env" as const,
      ready: true,
      managed: true,
      origin: "managed" as const,
      canDeleteProfile: false,
      canDeleteApiKey: false,
    },
  ],
};

async function createFakeAcpAgent(workspaceRoot: string): Promise<string> {
  const scriptPath = join(workspaceRoot, "fake-acp-agent.mjs");
  const sdkUrl = pathToFileURL(
    join(process.cwd(), "node_modules", "@agentclientprotocol", "sdk", "dist", "acp.js"),
  ).href;
  await writeFile(
    scriptPath,
    `
import * as acp from ${JSON.stringify(sdkUrl)};
import { Readable, Writable } from "node:stream";

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
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
    return { sessionId: "fake-session" };
  }

  async prompt(params) {
    const text = params.prompt.find((block) => block.type === "text")?.text ?? "";
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: \`acp received: \${text}\` },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
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

async function createFakeCliAgent(workspaceRoot: string): Promise<string> {
  const scriptPath = join(workspaceRoot, "fake-cli-agent.mjs");
  await writeFile(
    scriptPath,
    `
const prompt = process.argv.slice(2).join(" ");
process.stdout.write(\`cli received: \${prompt}\`);
`,
  );
  return scriptPath;
}

describe("runtime smoke runner", () => {
  test("runs provider-level meta-runtime routing end-to-end", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-test-"));
    try {
      const result = await runRuntimeSmoke({
        config: TEST_CONFIG,
        mode: "providers",
        workspaceRoot,
      });

      expect(result.mode).toBe("providers");
      expect(result.proposalId).toStartWith("proposal-");
      expect(result.channelId).toBeString();
      expect(result.channelId.length).toBeGreaterThan(0);
      expect(result.channelHistory).toHaveLength(1);
      expect(result.channelHistory[0]).toMatchObject({
        content: "runtime smoke: verify typed envelope routing",
        envelope: {
          id: "smoke-message",
          source: "root",
          body: "runtime smoke: verify typed envelope routing",
          topic: "runtime-smoke",
          metadata: { mode: "providers" },
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("runs native delegated-agent smoke with an injected LLM profile manager", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-native-"));
    const config = TEST_CONFIG;
    const manager = {
      ensureReady: async () => READY_LLM_STATE,
      getState: async () => READY_LLM_STATE,
      getConfig: () => config,
      updateConfig: () => undefined,
      createAdapter: async () =>
        ({
          async chat(options) {
            const lastUser = [...options.messages]
              .reverse()
              .find((message) => message.role === "user");
            const text =
              lastUser?.content.find((block) => block.type === "text")?.text ?? "missing goal";
            options.onText?.(`native received: ${text}`);
            return {
              content: [{ type: "text", text: `native received: ${text}` }],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        }) satisfies LlmAdapter,
    } satisfies Partial<LlmProfileManager> as unknown as LlmProfileManager;

    try {
      const result = await runRuntimeSmoke({
        config,
        llmProfileManager: manager,
        mode: "native",
        workspaceRoot,
      });

      expect(result.mode).toBe("native");
      expect(result.delegatedAgent?.id).toStartWith("agent-");
      expect(result.delegatedAgent?.status).toBe("completed");
      expect(result.delegatedAgent?.resultPreview).toContain("native received:");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("runs ACP delegated-agent smoke through a configured adapter", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-acp-"));
    try {
      const scriptPath = await createFakeAcpAgent(workspaceRoot);
      await mkdir(join(workspaceRoot, ".sloppy"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".sloppy", "config.yaml"),
        [
          "providers:",
          "  delegation:",
          "    acp:",
          "      enabled: true",
          "      adapters:",
          "        fake:",
          `          command: ["node", ${JSON.stringify(scriptPath)}]`,
          "",
        ].join("\n"),
      );

      const result = await runRuntimeSmoke({
        acpAdapterId: "fake",
        mode: "acp",
        workspaceRoot,
      });

      expect(result.mode).toBe("acp");
      expect(result.delegatedAgent?.id).toStartWith("agent-");
      expect(result.delegatedAgent?.status).toBe("completed");
      expect(result.delegatedAgent?.resultPreview).toContain("acp received:");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("runs CLI delegated-agent smoke through a configured adapter", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-cli-"));
    try {
      const scriptPath = await createFakeCliAgent(workspaceRoot);
      await mkdir(join(workspaceRoot, ".sloppy"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".sloppy", "config.yaml"),
        [
          "providers:",
          "  delegation:",
          "    cli:",
          "      enabled: true",
          "      adapters:",
          "        fake:",
          `          command: ["node", ${JSON.stringify(scriptPath)}]`,
          "",
        ].join("\n"),
      );

      const result = await runRuntimeSmoke({
        cliAdapterId: "fake",
        mode: "cli",
        workspaceRoot,
      });

      expect(result.mode).toBe("cli");
      expect(result.delegatedAgent?.id).toStartWith("agent-");
      expect(result.delegatedAgent?.status).toBe("completed");
      expect(result.delegatedAgent?.resultPreview).toContain("cli received:");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

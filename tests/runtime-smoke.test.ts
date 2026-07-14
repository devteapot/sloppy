import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SloppyConfig } from "../src/config/schema";
import type { LlmProfileManager, LlmStateSnapshot } from "../src/llm/profile-manager";
import type { LlmAdapter } from "../src/llm/types";
import { runRuntimeSmoke } from "../src/runtime/smoke-runner";
import { createTestConfig } from "./helpers/config";

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalHome = process.env.HOME;
const originalEndpoint = process.env.SLOPPY_LLM_ENDPOINT;
const originalProfile = process.env.SLOPPY_LLM_PROFILE;
const originalModel = process.env.SLOPPY_MODEL;

const TEST_CONFIG = createTestConfig({
  agent: { maxIterations: 4 },
});

const READY_LLM_STATE: LlmStateSnapshot = {
  status: "ready" as const,
  message: "ready",
  activeProfileId: "openai-main",
  selectedEndpointId: "openai",
  selectedProtocol: "openai-chat",
  selectedModel: "stub-model",
  secureStoreKind: "keychain",
  secureStoreStatus: "available",
  profiles: [
    {
      kind: "native",
      id: "openai-main",
      label: "Stub",
      endpointId: "openai",
      protocol: "openai-chat",
      model: "stub-model",
      authEnv: "STUB_KEY",
      baseUrl: undefined,
      isDefault: true,
      hasKey: true,
      keySource: "env" as const,
      ready: true,
      managed: true,
      origin: "managed" as const,
      canDeleteProfile: false,
      canDeleteApiKey: false,
      thinking: {
        enabled: true,
        display: "visible",
        effort: "medium",
        effectiveEnabled: true,
        effectiveReason: "configured",
        effectiveEffort: "medium",
      },
    },
  ],
};

const RUNTIME_READY_LLM_STATE: LlmStateSnapshot = {
  ...READY_LLM_STATE,
  activeProfileId: "runtime",
  selectedModel: "local/test-model",
  profiles: [
    {
      ...READY_LLM_STATE.profiles[0]!,
      id: "runtime",
      label: "Runtime Override",
      model: "local/test-model",
    },
  ],
};

function restoreEnv(): void {
  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalOpenAIKey == null) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  if (originalEndpoint == null) {
    delete process.env.SLOPPY_LLM_ENDPOINT;
  } else {
    process.env.SLOPPY_LLM_ENDPOINT = originalEndpoint;
  }
  if (originalProfile == null) {
    delete process.env.SLOPPY_LLM_PROFILE;
  } else {
    process.env.SLOPPY_LLM_PROFILE = originalProfile;
  }
  if (originalModel == null) {
    delete process.env.SLOPPY_MODEL;
  } else {
    process.env.SLOPPY_MODEL = originalModel;
  }
}

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

describe("runtime smoke runner", () => {
  test("runs provider-level meta-runtime routing end-to-end", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-test-"));
    const eventLogPath = join(workspaceRoot, "events.jsonl");
    try {
      const result = await runRuntimeSmoke({
        config: TEST_CONFIG,
        mode: "providers",
        workspaceRoot,
        eventLogPath,
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
      expect(result.eventLogPath).toBe(eventLogPath);

      const eventKinds = (await readFile(eventLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind);
      expect(eventKinds).toContain("proposal.created");
      expect(eventKinds).toContain("proposal.applied");
      expect(eventKinds).toContain("route.dispatched");
      expect(eventKinds).toContain("runtime_smoke.channel_verified");
      expect(eventKinds).toContain("runtime_smoke.completed");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("runs native delegated-agent smoke with an injected LLM profile manager", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-native-"));
    const eventLogPath = join(workspaceRoot, "events.jsonl");
    const config = TEST_CONFIG;
    const manager = {
      acquireProfileBinding: () => Symbol("native-smoke-profile-binding"),
      moveProfileBinding: () => undefined,
      releaseProfileBinding: () => undefined,
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
        eventLogPath,
      });

      expect(result.mode).toBe("native");
      expect(result.delegatedAgent?.id).toStartWith("agent-");
      expect(result.delegatedAgent?.status).toBe("completed");
      expect(result.delegatedAgent?.resultPreview).toContain("native received:");

      const eventKinds = (await readFile(eventLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind);
      expect(eventKinds).toContain("delegated_agent.state");
      expect(eventKinds).toContain("runtime_smoke.completed");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("native smoke honors explicit runtime env routing instead of managed profiles", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-env-"));
    process.env.OPENAI_API_KEY = "router-key";
    process.env.SLOPPY_LLM_ENDPOINT = "openai";
    process.env.SLOPPY_MODEL = "local/test-model";
    delete process.env.SLOPPY_LLM_PROFILE;

    const config: SloppyConfig = {
      ...TEST_CONFIG,
      llm: {
        ...TEST_CONFIG.llm,
        defaultProfileId: "managed-openai",
        profiles: [
          {
            kind: "native",
            id: "managed-openai",
            label: "Managed OpenAI",
            endpointId: "openai",
            model: "gpt-5.4",
          },
        ],
      },
    };
    const manager = {
      acquireProfileBinding: () => Symbol("env-smoke-profile-binding"),
      moveProfileBinding: () => undefined,
      releaseProfileBinding: () => undefined,
      ensureReady: async () => RUNTIME_READY_LLM_STATE,
      getState: async () => RUNTIME_READY_LLM_STATE,
      getConfig: () => config,
      updateConfig: () => undefined,
      createAdapter: async (profileId?: string) => {
        expect(profileId).toBe("runtime");
        return {
          async chat(options) {
            options.onText?.("env-routed native received");
            return {
              content: [{ type: "text", text: "env-routed native received" }],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        } satisfies LlmAdapter;
      },
    } satisfies Partial<LlmProfileManager> as unknown as LlmProfileManager;

    try {
      const result = await runRuntimeSmoke({
        config,
        llmProfileManager: manager,
        mode: "native",
        workspaceRoot,
      });

      expect(result.delegatedAgent?.status).toBe("completed");
      expect(result.delegatedAgent?.resultPreview).toContain("env-routed native received");
    } finally {
      restoreEnv();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("runs ACP delegated-agent smoke through a configured adapter", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-acp-"));
    try {
      process.env.HOME = home;
      const scriptPath = await createFakeAcpAgent(workspaceRoot);
      await mkdir(join(workspaceRoot, ".sloppy"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".sloppy", "config.yaml"),
        [
          "plugins:",
          "  delegation:",
          "    enabled: true",
          "    acp:",
          "      enabled: true",
          "      adapters:",
          "        fake:",
          `          command: ["node", ${JSON.stringify(scriptPath)}]`,
          "          capabilities:",
          "            spawn_allowed: true",
          "            shell_allowed: true",
          "            network_allowed: true",
          "            filesystem_reads_allowed: true",
          "            filesystem_writes_allowed: true",
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
      restoreEnv();
      await rm(home, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

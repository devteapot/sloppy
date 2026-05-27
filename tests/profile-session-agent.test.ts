import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SloppyConfig } from "../src/config/schema";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { SessionRuntime } from "../src/session/runtime";
import { createTestConfig } from "./helpers/config";

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  async getStatus(): Promise<CredentialStoreStatus> {
    return "available";
  }

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}
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
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession() {
    return { sessionId: "fake-profile-session" };
  }

  async prompt(params) {
    const text = params.prompt.find((block) => block.type === "text")?.text ?? "";
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "main " + process.env.MODEL + ": " + text },
      },
    });
    return { stopReason: "end_turn" };
  }
}

let connection;
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
new acp.AgentSideConnection((clientConnection) => {
  connection = clientConnection;
  return new FakeAgent();
}, stream);
`,
    "utf8",
  );
  return scriptPath;
}

function buildConfig(workspaceRoot: string, scriptPath: string): SloppyConfig {
  return createTestConfig({
    llm: {
      defaultProfileId: "fake-acp",
      profiles: [
        {
          kind: "session-agent",
          id: "fake-acp",
          label: "Fake ACP",
          model: "sonnet",
          adapterId: "fake",
        },
      ],
      maxTokens: 4096,
    },
    plugins: {
      terminal: { enabled: false, cwd: workspaceRoot, historyLimit: 10, syncTimeoutMs: 30000 },
      filesystem: {
        enabled: false,
        root: workspaceRoot,
        focus: workspaceRoot,
        recentLimit: 10,
        searchLimit: 20,
        readMaxBytes: 65536,
        contentRefThresholdBytes: 8192,
        previewBytes: 2048,
      },
      skills: { enabled: false, skillsDir: join(workspaceRoot, "skills") },
      delegation: {
        enabled: false,
        maxAgents: 10,
        acp: {
          enabled: true,
          adapters: {
            fake: {
              command: ["node", scriptPath],
              env: {
                MODEL: "{model}",
              },
            },
          },
        },
      },
      "meta-runtime": {
        enabled: false,
        globalRoot: join(workspaceRoot, "global-meta"),
        workspaceRoot: join(workspaceRoot, "workspace-meta"),
      },
    },
  });
}

describe("ProfileSessionAgent", () => {
  test("runs ACP adapter profiles as the main session model", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-profile-agent-"));
    try {
      const scriptPath = await createFakeAcpAgent(workspaceRoot);
      const config = buildConfig(workspaceRoot, scriptPath);
      const runtime = new SessionRuntime({
        config,
        sessionId: "profile-acp",
        llmProfileManager: new LlmProfileManager({
          config,
          credentialStore: new MemoryCredentialStore(),
          writeConfig: async () => undefined,
        }),
      });

      try {
        await runtime.start();
        await runtime.sendMessage("hello from main");
        await runtime.waitForIdle();

        const snapshot = runtime.store.getSnapshot();
        expect(snapshot.llm.status).toBe("ready");
        expect(snapshot.llm.selectedProtocol).toBe("session-agent");
        expect(snapshot.llm.selectedModel).toBe("sonnet");
        const lastBlock = snapshot.transcript.at(-1)?.content[0];
        expect(lastBlock?.type).toBe("text");
        expect(lastBlock?.type === "text" ? lastBlock.text : undefined).toBe(
          "main sonnet: hello from main",
        );
      } finally {
        runtime.shutdown();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

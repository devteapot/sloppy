import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { SessionRuntime } from "../src/session/runtime";

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

function buildConfig(workspaceRoot: string, scriptPath: string): SloppyConfig {
  return {
    llm: {
      provider: "cli",
      model: "gpt-5.5",
      adapterId: "codex",
      defaultProfileId: "codex-gpt55",
      profiles: [
        {
          id: "codex-gpt55",
          label: "Codex GPT-5.5",
          provider: "cli",
          model: "gpt-5.5",
          adapterId: "codex",
        },
      ],
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
      discovery: { enabled: false, paths: [] },
      terminal: { cwd: workspaceRoot, historyLimit: 10, syncTimeoutMs: 30000 },
      filesystem: {
        root: workspaceRoot,
        focus: workspaceRoot,
        recentLimit: 10,
        searchLimit: 20,
        readMaxBytes: 65536,
        contentRefThresholdBytes: 8192,
        previewBytes: 2048,
      },
      memory: { maxMemories: 500, defaultWeight: 0.5, compactThreshold: 0.2 },
      skills: { skillsDir: join(workspaceRoot, "skills") },
      web: { historyLimit: 20 },
      browser: { viewportWidth: 1280, viewportHeight: 720 },
      cron: { maxJobs: 50 },
      messaging: { maxMessages: 500 },
      delegation: {
        maxAgents: 10,
        cli: {
          enabled: true,
          adapters: {
            codex: {
              command: ["node", scriptPath, "{model}", "{prompt}"],
            },
          },
        },
      },
      metaRuntime: {
        globalRoot: join(workspaceRoot, "global-meta"),
        workspaceRoot: join(workspaceRoot, "workspace-meta"),
      },
      vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
    },
  };
}

describe("ProfileSessionAgent", () => {
  test("runs CLI adapter profiles as the main session model", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-profile-agent-"));
    try {
      const scriptPath = join(workspaceRoot, "agent.mjs");
      await writeFile(
        scriptPath,
        `
const [model, prompt] = process.argv.slice(2);
process.stdout.write("main " + model + ": " + prompt);
`,
        "utf8",
      );
      const runtime = new SessionRuntime({
        config: buildConfig(workspaceRoot, scriptPath),
        sessionId: "profile-cli",
        llmProfileManager: new LlmProfileManager({
          config: buildConfig(workspaceRoot, scriptPath),
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
        expect(snapshot.llm.selectedProvider).toBe("cli");
        expect(snapshot.llm.selectedModel).toBe("gpt-5.5");
        const lastBlock = snapshot.transcript.at(-1)?.content[0];
        expect(lastBlock?.type).toBe("text");
        expect(lastBlock?.type === "text" ? lastBlock.text : undefined).toBe(
          "main gpt-5.5: hello from main",
        );
      } finally {
        runtime.shutdown();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

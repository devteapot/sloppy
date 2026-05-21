import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadlessSingleShot } from "../src/cli-headless";
import type { SloppyConfig } from "../src/config/schema";
import type { AgentToolInvocation } from "../src/core/agent";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import type { SessionAgent, SessionAgentFactory } from "../src/session/runtime";
import { createTestConfig } from "./helpers/config";

const TEST_CONFIG = createTestConfig({
  llm: {
    apiKeyEnv: "OPENAI_API_KEY",
    defaultProfileId: "test-openai",
    profiles: [
      {
        id: "test-openai",
        label: "Test OpenAI",
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ],
  },
});

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private status: CredentialStoreStatus = "available",
    private secrets = new Map<string, string>([["test-openai", "test-key"]]),
  ) {}

  async getStatus(): Promise<CredentialStoreStatus> {
    return this.status;
  }

  async get(profileId: string): Promise<string | null> {
    return this.secrets.get(profileId) ?? null;
  }

  async set(profileId: string, secret: string): Promise<void> {
    this.secrets.set(profileId, secret);
  }

  async delete(profileId: string): Promise<void> {
    this.secrets.delete(profileId);
  }
}

function createTestProfileManager(config: SloppyConfig = TEST_CONFIG): LlmProfileManager {
  return new LlmProfileManager({
    config,
    credentialStore: new MemoryCredentialStore(),
    writeConfig: async () => undefined,
  });
}

function createBaseSessionAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    start: async () => undefined,
    chat: async (userMessage: string) => ({ status: "completed", response: userMessage }),
    resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
    invokeProvider: async () => ({ type: "result", id: "inv-test", status: "ok" }),
    resolveApprovalDirect: async () => ({ type: "result", id: "inv-test", status: "ok" }),
    rejectApprovalDirect: () => undefined,
    cancelActiveTurn: () => false,
    clearPendingApproval: () => undefined,
    shutdown: () => undefined,
    ...overrides,
  };
}

function createCompletedAgentFactory(): SessionAgentFactory {
  return (callbacks): SessionAgent =>
    createBaseSessionAgent({
      chat: async (userMessage: string) => {
        const invocation: AgentToolInvocation = {
          toolUseId: "tool-1",
          toolName: "filesystem__workspace__read",
          kind: "affordance",
          providerId: "filesystem",
          path: "/workspace",
          action: "read",
          params: { path: "README.md" },
        };
        callbacks.onToolEvent?.({
          kind: "started",
          invocation,
          summary: "filesystem:read /workspace",
        });
        callbacks.onToolEvent?.({
          kind: "completed",
          invocation,
          summary: "filesystem:read /workspace",
          status: "ok",
        });
        callbacks.onTurnUsage?.({
          inputTokens: 12,
          outputTokens: 4,
          inputTokenSource: "reported",
          outputTokenSource: "reported",
          stateContextTokens: 20,
          stateContextTokenSource: "local",
        });
        return {
          status: "completed",
          response: `done: ${userMessage}`,
          usage: { inputTokens: 12, outputTokens: 4 },
        };
      },
    });
}

function createApprovalAgentHarness(): {
  factory: SessionAgentFactory;
  rejected: Array<{ approvalId: string; reason?: string }>;
} {
  const rejected: Array<{ approvalId: string; reason?: string }> = [];
  const invocation: AgentToolInvocation = {
    toolUseId: "tool-approval",
    toolName: "terminal__session__execute",
    kind: "affordance",
    providerId: "terminal",
    path: "/session",
    action: "execute",
    params: { command: "rm demo.txt" },
  };

  return {
    rejected,
    factory: (callbacks): SessionAgent =>
      createBaseSessionAgent({
        chat: async () => {
          callbacks.onToolEvent?.({
            kind: "approval_requested",
            invocation,
            summary: "terminal:execute /session",
            approvalId: "source-approval-1",
            errorCode: "approval_required",
            errorMessage: "Dangerous command requires approval.",
          });
          return {
            status: "waiting_approval",
            invocation,
          };
        },
        rejectApprovalDirect: (approvalId, reason) => {
          rejected.push({ approvalId, reason });
        },
        clearPendingApproval: () => undefined,
      }),
  };
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function withEventLog<T>(logPath: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.SLOPPY_EVENT_LOG;
  process.env.SLOPPY_EVENT_LOG = logPath;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SLOPPY_EVENT_LOG;
    } else {
      process.env.SLOPPY_EVENT_LOG = previous;
    }
  }
}

describe("runHeadlessSingleShot", () => {
  test("drives single-shot CLI through the public session provider surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-cli-headless-"));
    tempPaths.push(root);
    const logPath = join(root, "events.jsonl");
    const metricsPath = join(root, "metrics.json");
    let stdout = "";
    let stderr = "";

    const exitCode = await withEventLog(logPath, () =>
      runHeadlessSingleShot({
        prompt: "inspect workspace",
        config: TEST_CONFIG,
        llmProfileManager: createTestProfileManager(),
        agentFactory: createCompletedAgentFactory(),
        sessionId: "cli-test-success",
        providerId: "sloppy-session-cli-test-success",
        metricsPath,
        writeStdout: (chunk) => {
          stdout += chunk;
        },
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[tool] filesystem:read /workspace");
    expect(stdout).toContain("[result] filesystem:read /workspace");
    expect(stdout).toContain("done: inspect workspace");
    expect(stderr).toContain("[sloppy] providers:");

    const records = await readJsonLines(logPath);
    const kinds = records.map((record) => record.kind);
    expect(kinds).toContain("turn_started");
    expect(kinds).toContain("turn_completed");
    expect(kinds).toContain("tool_started");
    expect(kinds).toContain("tool_completed");
    expect(records.find((record) => record.kind === "turn_started")?.actor).toMatchObject({
      id: "cli-single-shot",
      name: "Sloppy CLI",
    });

    const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as {
      status: string;
      exitCode: number;
      sessionId: string;
      turnId?: string;
      responseChars: number;
      toolCalls: number;
      toolResults: number;
      usage?: Record<string, unknown>;
    };
    expect(metrics.status).toBe("completed");
    expect(metrics.exitCode).toBe(0);
    expect(metrics.sessionId).toBe("cli-test-success");
    expect(metrics.turnId).toMatch(/^turn-/);
    expect(metrics.responseChars).toBeGreaterThan(0);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolResults).toBe(1);
    expect(metrics.usage?.current_turn_input_tokens).toBe(12);
    expect(metrics.usage?.current_turn_output_tokens).toBe(4);
  });

  test("cancels approval-gated single-shot turns through /turn.cancel_turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-cli-approval-"));
    tempPaths.push(root);
    const logPath = join(root, "events.jsonl");
    const metricsPath = join(root, "metrics.json");
    const harness = createApprovalAgentHarness();
    let stdout = "";
    let stderr = "";

    const exitCode = await withEventLog(logPath, () =>
      runHeadlessSingleShot({
        prompt: "delete demo file",
        config: TEST_CONFIG,
        llmProfileManager: createTestProfileManager(),
        agentFactory: harness.factory,
        sessionId: "cli-test-approval",
        providerId: "sloppy-session-cli-test-approval",
        metricsPath,
        writeStdout: (chunk) => {
          stdout += chunk;
        },
        writeStderr: (chunk) => {
          stderr += chunk;
        },
      }),
    );

    expect(exitCode).toBe(2);
    expect(stdout).toContain("[approval] turn was cancelled");
    expect(stdout).toContain("Dangerous command requires approval.");
    expect(stderr).not.toContain("[error]");
    expect(harness.rejected).toEqual([
      { approvalId: "source-approval-1", reason: "Turn cancelled by user." },
    ]);

    const records = await readJsonLines(logPath);
    const kinds = records.map((record) => record.kind);
    expect(kinds).toContain("turn_started");
    expect(kinds).toContain("tool_approval_requested");
    expect(kinds).toContain("turn_waiting_approval");
    expect(kinds).toContain("turn_cancelled");

    const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as {
      status: string;
      exitCode: number;
      turn?: Record<string, unknown>;
    };
    expect(metrics.status).toBe("approval_cancelled");
    expect(metrics.exitCode).toBe(2);
    expect(metrics.turn?.state).toBe("idle");
  });

  test("treats CLI metrics as best-effort diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-cli-metrics-"));
    tempPaths.push(root);
    const notDirectory = join(root, "not-a-directory");
    await writeFile(notDirectory, "occupied");
    let stdout = "";
    let stderr = "";

    const exitCode = await runHeadlessSingleShot({
      prompt: "inspect workspace",
      config: TEST_CONFIG,
      llmProfileManager: createTestProfileManager(),
      agentFactory: createCompletedAgentFactory(),
      sessionId: "cli-test-metrics",
      providerId: "sloppy-session-cli-test-metrics",
      metricsPath: join(notDirectory, "metrics.json"),
      writeStdout: (chunk) => {
        stdout += chunk;
      },
      writeStderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("done: inspect workspace");
    expect(stderr).toContain("[warning] failed to write CLI metrics");
    expect(stderr).not.toContain("[error]");
  });
});

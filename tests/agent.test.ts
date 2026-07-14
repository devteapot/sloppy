import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent";
import type { ExternalProviderState } from "../src/core/consumer";
import type { CredentialStore } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import type { ConversationMessage, LlmAdapter } from "../src/llm/types";
import { LlmAbortError } from "../src/llm/types";
import { createTestConfig } from "./helpers/config";

const tempPaths: string[] = [];

const TEST_CONFIG = createTestConfig({ discovery: { enabled: true } });

class EmptyCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  async getStatus() {
    return "available" as const;
  }

  async get(): Promise<null> {
    return null;
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}
}

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }

    await rm(path, { recursive: true, force: true });
  }
});

describe("Agent", () => {
  test("pins one native adapter across repeated approval resumptions", async () => {
    const config = createTestConfig({
      llm: {
        defaultProfileId: "approval-test",
        profiles: [
          {
            kind: "native",
            id: "approval-test",
            endpointId: "approval-test",
            model: "approval-model",
          },
        ],
        endpoints: {
          "approval-test": {
            protocol: "openai-chat",
            auth: { type: "none" },
            models: { "approval-model": {} },
          },
        },
      },
      plugins: {
        terminal: { enabled: true, cwd: process.cwd() },
        filesystem: { enabled: false },
      },
    });
    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new EmptyCredentialStore(),
      writeConfig: async () => undefined,
    });
    let adapterCreations = 0;
    const adapterChatCalls: number[] = [];
    llmProfileManager.createAdapter = async () => {
      adapterCreations += 1;
      const adapterId = adapterCreations;
      let chatCall = 0;
      return {
        async chat(options) {
          chatCall += 1;
          adapterChatCalls.push(adapterId);
          if (chatCall <= 2) {
            return {
              content: [
                {
                  type: "tool_use",
                  id: `approval-call-${chatCall}`,
                  name: "terminal__session__execute",
                  input: {
                    command: `printf blocked-${chatCall} > approval-adapter-pin.txt`,
                    background: false,
                  },
                },
              ],
              stopReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }

          const text = `adapter-${adapterId} completed`;
          options.onText?.(text);
          return {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      } satisfies LlmAdapter;
    };
    const approvalIds: string[] = [];
    const agent = new Agent({
      config,
      llmProfileManager,
      onToolEvent(event) {
        if (event.kind === "approval_requested" && event.approvalId) {
          approvalIds.push(event.approvalId);
        }
      },
    });

    try {
      await agent.start();
      const firstWaiting = await agent.chat("request two dangerous commands");
      expect(firstWaiting.status).toBe("waiting_approval");
      if (firstWaiting.status !== "waiting_approval") {
        throw new Error("Expected the first approval request.");
      }
      const firstApprovalId = approvalIds.at(-1);
      if (!firstApprovalId) throw new Error("Expected the first approval id.");
      agent.rejectApprovalDirect(firstApprovalId, "Rejected first command.");

      const secondWaiting = await agent.resumeWithToolResult({
        block: {
          type: "tool_result",
          toolUseId: firstWaiting.invocation.toolUseId,
          content: "Rejected first command.",
          isError: true,
        },
        status: "cancelled",
        summary: "terminal:execute /session",
        errorCode: "approval_rejected",
      });
      expect(secondWaiting.status).toBe("waiting_approval");
      if (secondWaiting.status !== "waiting_approval") {
        throw new Error("Expected the repeated approval request.");
      }
      const secondApprovalId = approvalIds.at(-1);
      if (!secondApprovalId || secondApprovalId === firstApprovalId) {
        throw new Error("Expected a distinct second approval id.");
      }
      agent.rejectApprovalDirect(secondApprovalId, "Rejected second command.");

      const completed = await agent.resumeWithToolResult({
        block: {
          type: "tool_result",
          toolUseId: secondWaiting.invocation.toolUseId,
          content: "Rejected second command.",
          isError: true,
        },
        status: "cancelled",
        summary: "terminal:execute /session",
        errorCode: "approval_rejected",
      });

      expect(completed).toMatchObject({
        status: "completed",
        response: "adapter-1 completed",
      });
      expect(adapterCreations).toBe(1);
      expect(adapterChatCalls).toEqual([1, 1, 1]);
    } finally {
      agent.shutdown();
    }
  });

  test("completes every tool result in history when a pending approval turn is cleared", async () => {
    const config = createTestConfig({
      llm: {
        defaultProfileId: "approval-cancel-test",
        profiles: [
          {
            kind: "native",
            id: "approval-cancel-test",
            endpointId: "approval-cancel-test",
            model: "approval-cancel-model",
          },
        ],
        endpoints: {
          "approval-cancel-test": {
            protocol: "openai-chat",
            auth: { type: "none" },
            models: { "approval-cancel-model": {} },
          },
        },
      },
      plugins: {
        terminal: { enabled: true, cwd: process.cwd() },
        filesystem: { enabled: false },
      },
    });
    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new EmptyCredentialStore(),
      writeConfig: async () => undefined,
    });
    let modelCalls = 0;
    let nextRequestMessages: ConversationMessage[] = [];
    llmProfileManager.createAdapter = async () => ({
      async chat(options) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [
              {
                type: "tool_use",
                id: "completed-before-approval",
                name: "terminal__session__execute",
                input: { command: "pwd", background: false },
              },
              {
                type: "tool_use",
                id: "blocked-by-approval",
                name: "terminal__session__execute",
                input: {
                  command: "printf blocked > approval-history-cancel.txt",
                  background: false,
                },
              },
              {
                type: "tool_use",
                id: "not-run-after-approval",
                name: "terminal__session__execute",
                input: { command: "pwd", background: false },
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }

        nextRequestMessages = options.messages;
        return {
          content: [{ type: "text", text: "continued safely" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    let approvalId: string | undefined;
    const agent = new Agent({
      config,
      llmProfileManager,
      onToolEvent(event) {
        if (event.kind === "approval_requested") {
          approvalId = event.approvalId;
        }
      },
    });

    try {
      await agent.start();
      const waiting = await agent.chat("run a three-command batch");
      expect(waiting.status).toBe("waiting_approval");
      if (!approvalId) {
        throw new Error("Expected the middle command to request approval.");
      }

      agent.rejectApprovalDirect(approvalId, "Turn cancelled by user.");
      agent.clearPendingApproval();
      await agent.chat("continue after cancelling the batch");

      const toolResults = nextRequestMessages.flatMap((message) =>
        message.content.filter((block) => block.type === "tool_result"),
      );
      expect(toolResults.map((block) => block.toolUseId)).toEqual([
        "completed-before-approval",
        "blocked-by-approval",
        "not-run-after-approval",
      ]);
      expect(toolResults[0]?.isError).not.toBe(true);
      expect(toolResults[1]).toMatchObject({
        isError: true,
        content: "Tool execution cancelled before the suspended batch completed.",
      });
      expect(toolResults[2]).toMatchObject({
        isError: true,
        content: "Tool execution cancelled before the suspended batch completed.",
      });
    } finally {
      agent.shutdown();
    }
  });

  test("preserves resumed tool results and cancels unresolved calls in the next request", async () => {
    const config = createTestConfig({
      llm: {
        defaultProfileId: "resumed-batch-cancel-test",
        profiles: [
          {
            kind: "native",
            id: "resumed-batch-cancel-test",
            endpointId: "resumed-batch-cancel-test",
            model: "resumed-batch-cancel-model",
          },
        ],
        endpoints: {
          "resumed-batch-cancel-test": {
            protocol: "openai-chat",
            auth: { type: "none" },
            models: { "resumed-batch-cancel-model": {} },
          },
        },
      },
      plugins: {
        terminal: { enabled: true, cwd: process.cwd() },
        filesystem: { enabled: false },
      },
    });
    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new EmptyCredentialStore(),
      writeConfig: async () => undefined,
    });
    let modelCalls = 0;
    let nextRequestMessages: ConversationMessage[] = [];
    llmProfileManager.createAdapter = async () => ({
      async chat(options) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [
              {
                type: "tool_use",
                id: "blocked-by-approval",
                name: "terminal__session__execute",
                input: {
                  command: "printf blocked > approval-resume-cancel.txt",
                  background: false,
                },
              },
              {
                type: "tool_use",
                id: "completed-after-approval",
                name: "terminal__session__execute",
                input: { command: "pwd", background: false },
              },
              {
                type: "tool_use",
                id: "cancelled-local",
                name: "audit_long_tool",
                input: {},
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }

        nextRequestMessages = options.messages;
        return {
          content: [{ type: "text", text: "history remained valid" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    let approvalId: string | undefined;
    let markLocalToolStarted: (() => void) | undefined;
    const localToolStarted = new Promise<void>((resolve) => {
      markLocalToolStarted = resolve;
    });
    const agent = new Agent({
      config,
      llmProfileManager,
      localTools: () => [
        {
          tool: {
            type: "function",
            function: {
              name: "audit_long_tool",
              description: "Wait until the test cancels this local tool.",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          },
          execute(_params, context) {
            markLocalToolStarted?.();
            return new Promise<never>((_resolve, reject) => {
              if (context.signal?.aborted) {
                reject(new LlmAbortError());
                return;
              }
              context.signal?.addEventListener("abort", () => reject(new LlmAbortError()), {
                once: true,
              });
            });
          },
        },
      ],
      onToolEvent(event) {
        if (event.kind === "approval_requested") {
          approvalId = event.approvalId;
        }
      },
    });

    try {
      await agent.start();
      const waiting = await agent.chat("run a batch, then wait");
      expect(waiting.status).toBe("waiting_approval");
      if (waiting.status !== "waiting_approval" || !approvalId) {
        throw new Error("Expected the first command to request approval.");
      }

      agent.rejectApprovalDirect(approvalId, "Rejected before running the later tools.");
      const resumed = agent.resumeWithToolResult({
        block: {
          type: "tool_result",
          toolUseId: waiting.invocation.toolUseId,
          content: "Rejected before running the later tools.",
          isError: true,
        },
        status: "cancelled",
        summary: "terminal:execute /session",
        errorCode: "approval_rejected",
      });
      await localToolStarted;
      expect(agent.cancelActiveTurn()).toBe(true);
      await expect(resumed).rejects.toBeInstanceOf(LlmAbortError);

      await agent.chat("continue after cancelling the resumed batch");
      const toolResults = nextRequestMessages.flatMap((message) =>
        message.content.filter((block) => block.type === "tool_result"),
      );
      expect(toolResults.map((block) => block.toolUseId)).toEqual([
        "blocked-by-approval",
        "completed-after-approval",
        "cancelled-local",
      ]);
      expect(toolResults[0]).toMatchObject({
        isError: true,
        content: "Rejected before running the later tools.",
      });
      expect(toolResults[1]?.isError).not.toBe(true);
      expect(toolResults[2]).toMatchObject({
        isError: true,
        content: "Tool execution cancelled before the suspended batch completed.",
      });
    } finally {
      agent.shutdown();
    }
  });

  test("aborts an active native model request during shutdown", async () => {
    const config = createTestConfig({
      llm: {
        defaultProfileId: "shutdown-test",
        profiles: [
          {
            kind: "native",
            id: "shutdown-test",
            endpointId: "shutdown-test",
            model: "shutdown-model",
          },
        ],
        endpoints: {
          "shutdown-test": {
            protocol: "openai-chat",
            auth: { type: "none" },
            models: { "shutdown-model": {} },
          },
        },
      },
      plugins: {
        terminal: { enabled: true, cwd: process.cwd() },
        filesystem: { enabled: false },
      },
    });
    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new EmptyCredentialStore(),
      writeConfig: async () => undefined,
    });
    let modelSignal: AbortSignal | undefined;
    let agent: Agent;
    llmProfileManager.createAdapter = async () => {
      return {
        async chat(options) {
          modelSignal = options.signal;
          return new Promise<never>((_resolve, reject) => {
            if (options.signal?.aborted) {
              reject(new LlmAbortError());
              return;
            }
            options.signal?.addEventListener("abort", () => reject(new LlmAbortError()), {
              once: true,
            });
            queueMicrotask(() => agent.shutdown());
          });
        },
      } satisfies LlmAdapter;
    };
    agent = new Agent({ config, llmProfileManager });

    await agent.start();
    await expect(agent.chat("wait for cancellation")).rejects.toBeInstanceOf(LlmAbortError);
    expect(modelSignal?.aborted).toBe(true);
  });

  test("public composition supplies delegated child-session construction", async () => {
    const config = createTestConfig({
      llm: {
        defaultProfileId: "delegation-test",
        profiles: [
          {
            kind: "native",
            id: "delegation-test",
            endpointId: "delegation-test",
            model: "test-model",
          },
        ],
        endpoints: {
          "delegation-test": {
            protocol: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            auth: { type: "secure_store" },
            models: { "test-model": {} },
          },
        },
      },
      plugins: {
        delegation: { enabled: true },
        filesystem: { root: process.cwd() },
      },
    });
    const llmProfileManager = new LlmProfileManager({
      config,
      credentialStore: new EmptyCredentialStore(),
      writeConfig: async () => undefined,
    });
    const agent = new Agent({
      config,
      llmProfileManager,
    });

    try {
      await agent.start();
      const result = await agent.invokeProvider("delegation", "/session", "spawn_agent", {
        name: "public-agent-child",
        goal: "Confirm the child session can be constructed.",
      });

      expect(result.status).toBe("ok");
      expect(result.data).toMatchObject({ status: "pending" });
      const childId = (result.data as { id: string }).id;
      let childStatus: unknown;
      let childError: unknown;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const child = await agent.queryProvider("delegation", `/agents/${childId}`, { depth: 1 });
        childStatus = child.properties?.status;
        childError = child.properties?.error;
        if (childStatus === "failed") break;
        await Bun.sleep(10);
      }
      expect(childStatus).toBe("failed");
      expect(String(childError)).not.toContain("child session runtime factory");
    } finally {
      agent.shutdown();
    }
  });

  test("ignores the current session provider descriptor while tracking other external providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sloppy-agent-"));
    tempPaths.push(directory);

    await writeFile(
      join(directory, "self.json"),
      JSON.stringify({
        id: "sloppy-session-self",
        name: "Sloppy Agent Session",
        transport: {
          type: "unix",
          path: "/tmp/slop/sloppy-session-self.sock",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(directory, "native-demo.json"),
      JSON.stringify({
        id: "native-demo",
        name: "Native Demo",
        transport: {
          type: "unix",
          path: "/tmp/slop/native-demo.sock",
        },
      }),
      "utf8",
    );

    let lastStates: ExternalProviderState[] = [];
    const agent = new Agent({
      config: {
        ...TEST_CONFIG,
        providers: {
          ...TEST_CONFIG.providers,
          discovery: {
            enabled: true,
            paths: [directory],
          },
        },
      },
      ignoredProviderIds: ["sloppy-session-self"],
      onExternalProviderStates: (states) => {
        lastStates = states;
      },
    });

    try {
      await agent.start();

      expect(lastStates).toEqual([
        {
          id: "native-demo",
          name: "Native Demo",
          transport: "unix:/tmp/slop/native-demo.sock",
          status: "unloaded",
        },
      ]);
      const apps = await agent.queryProvider("apps", "/available", { depth: 2 });
      expect(apps.properties).toMatchObject({
        count: 1,
        unloaded_count: 1,
      });
      expect(apps.children?.[0]?.properties).toMatchObject({
        provider_id: "native-demo",
        status: "unloaded",
      });
    } finally {
      agent.shutdown();
    }
  });
});

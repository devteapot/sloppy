import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SloppyConfig } from "../src/config/schema";
import type { RoleProfile } from "../src/core/agent";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import type { ConversationMessage, LlmAdapter, LlmChatOptions } from "../src/llm/types";
import { ProfileSessionAgent } from "../src/session/profile-agent";
import { SessionRuntime } from "../src/session/runtime";
import { createDeferred } from "./helpers/agent-session-provider-harness";
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
    if (text.includes("approval")) {
      const toolCall = {
        toolCallId: "profile-tool-1",
        title: "Profile approval probe",
        kind: "edit",
        status: "pending",
        rawInput: { model: process.env.MODEL },
      };
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          ...toolCall,
        },
      });
      const permission = await connection.requestPermission({
        sessionId: params.sessionId,
        toolCall,
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Reject once", optionId: "reject" },
        ],
      });
      const approved =
        permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow";
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: toolCall.toolCallId,
          status: approved ? "completed" : "failed",
        },
      });
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "main " + process.env.MODEL + ": " + (approved ? "approved" : "rejected"),
          },
        },
      });
      return { stopReason: "end_turn" };
    }
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

function buildNativeSwitchConfig(): SloppyConfig {
  return createTestConfig({
    llm: {
      defaultProfileId: "native-a",
      profiles: [
        {
          kind: "native",
          id: "native-a",
          endpointId: "native-a-endpoint",
          model: "model-a",
        },
        {
          kind: "native",
          id: "native-b",
          endpointId: "native-b-endpoint",
          model: "model-b1",
        },
      ],
      endpoints: {
        "native-a-endpoint": {
          protocol: "openai-chat",
          auth: { type: "none" },
          models: { "model-a": {} },
        },
        "native-b-endpoint": {
          protocol: "openai-chat",
          auth: { type: "none" },
          models: { "model-b1": {}, "model-b2": {} },
        },
      },
    },
    plugins: {
      terminal: { enabled: false },
      filesystem: { enabled: false },
    },
  });
}

function buildMixedProfileConfig(workspaceRoot: string, scriptPath: string): SloppyConfig {
  const config = buildConfig(workspaceRoot, scriptPath);
  return {
    ...config,
    llm: {
      ...config.llm,
      defaultProfileId: "native",
      profiles: [
        {
          kind: "native",
          id: "native",
          endpointId: "native-endpoint",
          model: "native-model",
        },
        ...config.llm.profiles,
      ],
      endpoints: {
        ...config.llm.endpoints,
        "native-endpoint": {
          protocol: "openai-chat",
          auth: { type: "none" },
          models: { "native-model": {} },
        },
      },
    },
  };
}

function portableTranscript(messages: ConversationMessage[]): Array<{
  role: ConversationMessage["role"];
  text: string;
}> {
  return messages.flatMap((message) => {
    const text = message.content
      .filter((block) => block.type === "text" && !block.text.startsWith("<slop-state"))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return text ? [{ role: message.role, text }] : [];
  });
}

function latestPortableUserText(options: LlmChatOptions): string {
  return (
    portableTranscript(options.messages)
      .filter((message) => message.role === "user")
      .at(-1)?.text ?? ""
  );
}

function requireProfileInner(agent: ProfileSessionAgent): { shutdown(): void } {
  const inner = (agent as unknown as { inner: { shutdown(): void } | null }).inner;
  if (!inner) {
    throw new Error("Expected the profile session agent to have an active inner agent.");
  }
  return inner;
}

describe("ProfileSessionAgent", () => {
  test("retains its profile lease until an active model operation settles during shutdown", async () => {
    const config = buildNativeSwitchConfig();
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    const chatStarted = createDeferred<void>();
    const finishChat = createDeferred<void>();
    manager.createAdapter = async () =>
      ({
        async chat(options) {
          chatStarted.resolve();
          await finishChat.promise;
          const text = "finished after shutdown";
          options.onText?.(text);
          return {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }) satisfies LlmAdapter;

    const agent = new ProfileSessionAgent({
      config,
      llmProfileManager: manager,
      callbacks: {},
    });

    await agent.start();
    const activeChat = agent.chat("keep the lease while this is active");
    await chatStarted.promise;

    agent.shutdown();
    let shutdownCompleted = false;
    const shutdownCompletion = agent.waitForShutdown().then(() => {
      shutdownCompleted = true;
    });
    await Bun.sleep(0);
    expect(shutdownCompleted).toBe(false);
    await expect(manager.deleteProfile("native-a")).rejects.toThrow("live session is bound to it");

    finishChat.resolve();
    await expect(activeChat).resolves.toMatchObject({ status: "completed" });
    await shutdownCompletion;
    expect(shutdownCompleted).toBe(true);
    await expect(manager.deleteProfile("native-a")).resolves.toMatchObject({
      activeProfileId: "native-b",
    });
    await expect(agent.chat("must not restart")).rejects.toThrow("has been shut down");
  });

  test("rejects deferred shutdown completion with all finalization failures", async () => {
    const config = buildNativeSwitchConfig();
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    const chatStarted = createDeferred<void>();
    const finishChat = createDeferred<void>();
    manager.createAdapter = async () =>
      ({
        async chat(options) {
          chatStarted.resolve();
          await finishChat.promise;
          const text = "cleanup should fail after this result";
          options.onText?.(text);
          return {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }) satisfies LlmAdapter;

    const agent = new ProfileSessionAgent({
      config,
      llmProfileManager: manager,
      callbacks: {},
    });

    await agent.start();
    const activeChat = agent.chat("defer teardown until this settles");
    await chatStarted.promise;

    const innerShutdownError = new Error("deferred inner shutdown failed");
    const inner = requireProfileInner(agent);
    const originalInnerShutdown = inner.shutdown.bind(inner);
    inner.shutdown = () => {
      originalInnerShutdown();
      throw innerShutdownError;
    };
    const releaseError = new Error("deferred profile binding release failed");
    const originalReleaseProfileBinding = manager.releaseProfileBinding.bind(manager);
    manager.releaseProfileBinding = (lease) => {
      originalReleaseProfileBinding(lease);
      throw releaseError;
    };

    agent.shutdown();
    const shutdownCompletion = agent.waitForShutdown().then(
      () => undefined,
      (error: unknown) => error,
    );
    finishChat.resolve();

    const activeChatError = await activeChat.then(
      () => undefined,
      (error: unknown) => error,
    );
    const completionError = await shutdownCompletion;
    expect(completionError).toBe(activeChatError);
    expect(completionError).toBeInstanceOf(AggregateError);
    expect((completionError as AggregateError).errors).toEqual([innerShutdownError, releaseError]);
    await expect(manager.deleteProfile("native-a")).resolves.toMatchObject({
      activeProfileId: "native-b",
    });
  });

  test("preserves synchronous shutdown errors while rejecting completion", async () => {
    const config = buildNativeSwitchConfig();
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    manager.createAdapter = async () =>
      ({
        async chat() {
          return {
            content: [{ type: "text", text: "unused" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }) satisfies LlmAdapter;
    const agent = new ProfileSessionAgent({
      config,
      llmProfileManager: manager,
      callbacks: {},
    });

    await agent.start();
    const shutdownError = new Error("immediate inner shutdown failed");
    const inner = requireProfileInner(agent);
    const originalInnerShutdown = inner.shutdown.bind(inner);
    inner.shutdown = () => {
      originalInnerShutdown();
      throw shutdownError;
    };
    const shutdownCompletion = agent.waitForShutdown().then(
      () => undefined,
      (error: unknown) => error,
    );

    let synchronousError: unknown;
    try {
      agent.shutdown();
    } catch (error) {
      synchronousError = error;
    }

    expect(synchronousError).toBe(shutdownError);
    expect(await shutdownCompletion).toBe(shutdownError);
    await expect(manager.deleteProfile("native-a")).resolves.toMatchObject({
      activeProfileId: "native-b",
    });
  });

  test("preserves native history across profile and model recreation", async () => {
    const config = buildNativeSwitchConfig();
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    const requests: Array<{
      profileId: string;
      model: string;
      messages: ConversationMessage[];
    }> = [];
    let roleStarts = 0;
    let roleStops = 0;
    const role = {
      id: "history-switch-test",
      attachRuntime: () => {
        roleStarts += 1;
        return {
          stop() {
            roleStops += 1;
          },
        };
      },
    } satisfies RoleProfile;

    manager.createAdapter = async () => {
      const state = await manager.getState();
      const profile = state.profiles.find((candidate) => candidate.id === state.activeProfileId);
      if (!profile) {
        throw new Error("Expected an active native profile.");
      }
      const profileId = profile.id;
      const model = profile.model;
      return {
        async chat(options) {
          requests.push({ profileId, model, messages: options.messages });
          const text = `${profileId}/${model}: ${latestPortableUserText(options)}`;
          options.onText?.(text);
          return {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      } satisfies LlmAdapter;
    };

    const agent = new ProfileSessionAgent({
      config,
      llmProfileManager: manager,
      role,
      callbacks: {},
    });

    try {
      await agent.start();
      await agent.chat("first turn");

      await manager.setDefaultProfile("native-b");
      await agent.chat("second turn");

      await manager.saveProfile({
        profileId: "native-b",
        model: "model-b2",
      });
      await agent.chat("third turn");

      expect(requests.map(({ profileId, model }) => ({ profileId, model }))).toEqual([
        { profileId: "native-a", model: "model-a" },
        { profileId: "native-b", model: "model-b1" },
        { profileId: "native-b", model: "model-b2" },
      ]);
      expect(portableTranscript(requests.at(-1)?.messages ?? [])).toEqual([
        { role: "user", text: "first turn" },
        { role: "assistant", text: "native-a/model-a: first turn" },
        { role: "user", text: "second turn" },
        { role: "assistant", text: "native-b/model-b1: second turn" },
        { role: "user", text: "third turn" },
      ]);
      expect(roleStarts).toBe(3);
      expect(roleStops).toBe(2);
    } finally {
      agent.shutdown();
    }

    expect(roleStops).toBe(3);
  });

  test("pins a native approval continuation until the next new chat", async () => {
    const config = buildNativeSwitchConfig();
    config.plugins.terminal.enabled = true;
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore(),
      writeConfig: async () => undefined,
    });
    const adapterRequests: Array<{
      profileId: string | undefined;
      modelOverride: string | undefined;
      resumedApproval: boolean;
    }> = [];
    let approvalId: string | undefined;

    manager.createAdapter = async (profileId, modelOverride) =>
      ({
        async chat(options) {
          const resumedApproval =
            profileId === "native-a" &&
            adapterRequests.some((request) => request.profileId === "native-a");
          adapterRequests.push({ profileId, modelOverride, resumedApproval });

          if (profileId === "native-a" && !resumedApproval) {
            expect(
              options.tools?.some((tool) => tool.function.name === "terminal__session__execute"),
            ).toBe(true);
            return {
              content: [
                {
                  type: "tool_use",
                  id: "profile-pin-call",
                  name: "terminal__session__execute",
                  input: {
                    command: "printf blocked > profile-pin-probe.txt",
                    background: false,
                  },
                },
              ],
              stopReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }

          const text = `${profileId}/${modelOverride}: ${
            resumedApproval ? "resumed approval" : "fresh chat"
          }`;
          options.onText?.(text);
          return {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }) satisfies LlmAdapter;

    const agent = new ProfileSessionAgent({
      config,
      llmProfileManager: manager,
      callbacks: {
        onToolEvent(event) {
          if (event.kind === "approval_requested") {
            approvalId = event.approvalId;
          }
        },
      },
    });

    try {
      await agent.start();
      const waiting = await agent.chat("request an approval");
      expect(waiting.status).toBe("waiting_approval");
      if (waiting.status !== "waiting_approval" || !approvalId) {
        throw new Error("Expected the native turn to request approval.");
      }

      await manager.setDefaultProfile("native-b");
      agent.updateConfig(manager.getConfig());
      await expect(manager.deleteProfile("native-a")).rejects.toThrow(
        "live session is bound to it",
      );
      agent.rejectApprovalDirect(approvalId, "Rejected by the regression test.");
      const resumed = await agent.resumeWithToolResult({
        block: {
          type: "tool_result",
          toolUseId: waiting.invocation.toolUseId,
          content: "Approval rejected by the regression test.",
          isError: true,
        },
        status: "cancelled",
        summary: "terminal:execute /session",
        errorCode: "approval_rejected",
        errorMessage: "Rejected by the regression test.",
      });
      expect(resumed.status).toBe("completed");
      expect(resumed.status === "completed" ? resumed.response : undefined).toBe(
        "native-a/model-a: resumed approval",
      );
      await expect(manager.deleteProfile("native-a")).resolves.toMatchObject({
        status: "ready",
        activeProfileId: "native-b",
      });

      const next = await agent.chat("use the new default");
      expect(next.status).toBe("completed");
      expect(next.status === "completed" ? next.response : undefined).toBe(
        "native-b/model-b1: fresh chat",
      );
      expect(adapterRequests).toEqual([
        { profileId: "native-a", modelOverride: "model-a", resumedApproval: false },
        { profileId: "native-a", modelOverride: "model-a", resumedApproval: true },
        { profileId: "native-b", modelOverride: "model-b1", resumedApproval: false },
      ]);
    } finally {
      agent.shutdown();
    }
  });

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
        expect(snapshot.session.modelProvider).toBe("fake");
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

  test("pins an ACP approval continuation until the next new chat", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-profile-acp-pinning-"));
    try {
      const scriptPath = await createFakeAcpAgent(workspaceRoot);
      const config = buildMixedProfileConfig(workspaceRoot, scriptPath);
      config.llm.defaultProfileId = "fake-acp";
      const manager = new LlmProfileManager({
        config,
        credentialStore: new MemoryCredentialStore(),
        writeConfig: async () => undefined,
      });
      const nativeRequests: Array<{
        profileId: string | undefined;
        modelOverride: string | undefined;
      }> = [];
      let approvalId: string | undefined;
      manager.createAdapter = async (profileId, modelOverride) =>
        ({
          async chat(options) {
            nativeRequests.push({ profileId, modelOverride });
            const text = `native next: ${latestPortableUserText(options)}`;
            options.onText?.(text);
            return {
              content: [{ type: "text", text }],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        }) satisfies LlmAdapter;

      const agent = new ProfileSessionAgent({
        config,
        llmProfileManager: manager,
        callbacks: {
          onToolEvent(event) {
            if (event.kind === "approval_requested") {
              approvalId = event.approvalId;
            }
          },
        },
      });

      try {
        await agent.start();
        const waiting = await agent.chat("request approval from ACP");
        expect(waiting.status).toBe("waiting_approval");
        if (waiting.status !== "waiting_approval" || !approvalId) {
          throw new Error("Expected the ACP turn to request approval.");
        }

        await manager.setDefaultProfile("native");
        await agent.resolveApprovalDirect(approvalId);
        const resumed = await agent.resumeWithToolResult({
          block: {
            type: "tool_result",
            toolUseId: waiting.invocation.toolUseId,
            content: "approved",
          },
          status: "ok",
          summary: "ACP approval resolved",
        });
        expect(resumed).toEqual({
          status: "completed",
          response: "main sonnet: approved",
        });

        const next = await agent.chat("after ACP approval");
        expect(next.status).toBe("completed");
        expect(next.status === "completed" ? next.response : undefined).toBe(
          "native next: after ACP approval",
        );
        expect(nativeRequests).toEqual([{ profileId: "native", modelOverride: "native-model" }]);
      } finally {
        agent.shutdown();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("keeps native history across an ACP handoff without importing ACP turns", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-profile-history-boundary-"));
    try {
      const scriptPath = await createFakeAcpAgent(workspaceRoot);
      const config = buildMixedProfileConfig(workspaceRoot, scriptPath);
      const manager = new LlmProfileManager({
        config,
        credentialStore: new MemoryCredentialStore(),
        writeConfig: async () => undefined,
      });
      const nativeRequests: ConversationMessage[][] = [];
      manager.createAdapter = async () =>
        ({
          async chat(options) {
            nativeRequests.push(options.messages);
            const text = `native: ${latestPortableUserText(options)}`;
            options.onText?.(text);
            return {
              content: [{ type: "text", text }],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        }) satisfies LlmAdapter;

      const agent = new ProfileSessionAgent({
        config,
        llmProfileManager: manager,
        callbacks: {},
      });

      try {
        await agent.start();
        await agent.chat("before ACP");

        await manager.setDefaultProfile("fake-acp");
        const acpResult = await agent.chat("inside ACP");
        expect(acpResult.status).toBe("completed");
        expect(acpResult.status === "completed" ? acpResult.response : "").toBe(
          "main sonnet: inside ACP",
        );

        await manager.setDefaultProfile("native");
        await agent.chat("after ACP");

        expect(portableTranscript(nativeRequests.at(-1) ?? [])).toEqual([
          { role: "user", text: "before ACP" },
          { role: "assistant", text: "native: before ACP" },
          { role: "user", text: "after ACP" },
        ]);
      } finally {
        agent.shutdown();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

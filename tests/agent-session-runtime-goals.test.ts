import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../src/config/schema";
import type { LlmProfileManager } from "../src/llm/profile-manager";
import type { LlmAdapter, LlmChatOptions, LlmResponse } from "../src/llm/types";
import { InProcessTransport } from "../src/providers/in-process";
import { AgentSessionProvider } from "../src/session/provider";
import type { SessionAgentFactory } from "../src/session/runtime";
import { SessionRuntime } from "../src/session/runtime";
import { SessionStore } from "../src/session/store";
import {
  createNoToolGoalHarnessFactory,
  createQueuedGoalHarnessFactory,
  createStreamingAgentFactory,
  createTestProfileManager,
  GoalReportingLlm,
  persistentGoalStoreOptions,
  StaleGoalUpdateLlm,
  seedGoal,
  TEST_CONFIG,
} from "./helpers/agent-session-provider-harness";

describe("AgentSessionProvider — runtime and goals", () => {
  test("session starts without credentials and exposes LLM onboarding state", async () => {
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-onboarding",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager({ secrets: {} }),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-onboarding",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const llm = await consumer.query("/llm", 3);
      expect(llm.properties?.status).toBe("needs_credentials");
      expect(llm.properties?.active_profile_id).toBe("test-openai");
      expect(llm.children?.[0]?.properties?.ready).toBe(false);
      expect(llm.children?.[0]?.properties?.thinking_enabled).toBe(true);
      expect(llm.children?.[0]?.properties?.thinking_display).toBe("visible");
      expect(llm.children?.[0]?.properties?.thinking_effective_enabled).toBe(true);
      expect(llm.children?.[0]?.properties?.thinking_effort).toBe("medium");

      const usage = await consumer.query("/usage", 1);
      expect(usage.properties?.current_turn_model_calls).toBe(0);

      const composer = await consumer.query("/composer", 2);
      expect(
        composer.affordances?.some((affordance) => affordance.action === "send_message") ?? false,
      ).toBe(false);
      expect(composer.properties?.disabled_reason).toBeTruthy();
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("exposes native loop token usage only under usage state", async () => {
    const config = {
      ...TEST_CONFIG,
      llm: {
        ...TEST_CONFIG.llm,
        endpoints: {
          ...TEST_CONFIG.llm.endpoints,
          openai: {
            ...TEST_CONFIG.llm.endpoints.openai!,
            models: {
              ...TEST_CONFIG.llm.endpoints.openai!.models,
              "gpt-5.4": {
                ...TEST_CONFIG.llm.endpoints.openai!.models["gpt-5.4"],
                contextWindowTokens: 123_456,
              },
            },
          },
        },
      },
    };
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.updateConfig(config);
    llmProfileManager.createAdapter = async () =>
      ({
        chat: async (options: LlmChatOptions) => {
          options.onThinking?.({
            id: "thinking-usage",
            provider: "openai",
            model: "gpt-5.4",
            format: "raw",
            display: "hidden",
            delta: "checking state",
            startedAt: "2026-05-21T10:00:00.000Z",
            completedAt: "2026-05-21T10:00:01.500Z",
            elapsedMs: 1500,
            tokenCount: 5,
            tokenCountSource: "reported",
            done: true,
          });
          options.onText?.("usage tracked");
          return {
            content: [{ type: "text", text: "usage tracked" }],
            stopReason: "end_turn",
            usage: { inputTokens: 42, outputTokens: 9, thinkingTokens: 5 },
          } satisfies LlmResponse;
        },
        countTextTokens: async () => ({ tokens: 12, source: "provider" }),
      }) satisfies LlmAdapter;
    const runtime = new SessionRuntime({
      config,
      sessionId: "sess-usage",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-usage",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/composer", "send_message", {
        text: "track usage",
      });
      expect(result.status).toBe("ok");
      await runtime.waitForIdle();

      const usage = await consumer.query("/usage", 1);
      expect(usage.properties?.last_model_call_input_tokens).toBe(42);
      expect(usage.properties?.last_model_call_output_tokens).toBe(9);
      expect(usage.properties?.last_model_call_thinking_tokens).toBe(5);
      expect(usage.properties?.last_model_call_input_source).toBe("reported");
      expect(usage.properties?.last_model_call_output_source).toBe("reported");
      expect(usage.properties?.last_model_call_thinking_source).toBe("reported");
      expect(usage.properties?.current_turn_input_tokens).toBe(42);
      expect(usage.properties?.current_turn_output_tokens).toBe(9);
      expect(usage.properties?.current_turn_thinking_tokens).toBe(5);
      expect(usage.properties?.current_turn_model_calls).toBe(1);
      expect(usage.properties?.total_input_tokens).toBe(42);
      expect(usage.properties?.total_output_tokens).toBe(9);
      expect(usage.properties?.total_thinking_tokens).toBe(5);
      expect(usage.properties?.last_state_context_tokens).toBe(12);
      expect(usage.properties?.last_state_context_token_source).toBe("provider");
      expect(usage.properties?.model_context_window_tokens).toBe(123_456);
      expect(usage.properties?.available_context_tokens).toBe(123_414);

      const transcript = await consumer.query("/transcript", 5);
      const assistant = transcript.children?.find(
        (child) => child.properties?.role === "assistant",
      );
      const thinking = assistant?.children?.[0]?.children?.find(
        (child) => child.properties?.kind === "thinking_output",
      );
      expect(thinking?.properties).toMatchObject({
        kind: "thinking_output",
        text: "checking state",
        display: "hidden",
        format: "raw",
        provider: "openai",
        model: "gpt-5.4",
        elapsed_ms: 1500,
        token_count: 5,
        token_count_source: "reported",
      });

      const llm = await consumer.query("/llm", 1);
      expect(llm.properties?.last_input_tokens).toBeUndefined();
      expect(llm.properties?.context_budget_tokens).toBeUndefined();
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("preserves interleaved thinking and text block order in the public transcript", async () => {
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.createAdapter = async () =>
      ({
        chat: async (options: LlmChatOptions) => {
          options.onThinking?.({
            id: "thinking-stream",
            provider: "openai",
            model: "gpt-5.4",
            format: "raw",
            display: "hidden",
            delta: "thinking 1",
            startedAt: "2026-05-21T10:00:00.000Z",
          });
          options.onText?.("turn 1");
          options.onThinking?.({
            id: "thinking-stream",
            provider: "openai",
            model: "gpt-5.4",
            format: "raw",
            display: "hidden",
            delta: "thinking 2",
            startedAt: "2026-05-21T10:00:01.000Z",
          });
          options.onText?.("turn 2");
          options.onThinking?.({
            id: "thinking-stream",
            provider: "openai",
            model: "gpt-5.4",
            format: "raw",
            display: "hidden",
            delta: "",
            startedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:03.000Z",
            elapsedMs: 2000,
            done: true,
          });
          return {
            content: [{ type: "text", text: "turn 1turn 2" }],
            stopReason: "end_turn",
            usage: {},
          } satisfies LlmResponse;
        },
        countTextTokens: async () => ({ source: "unavailable" }),
      }) satisfies LlmAdapter;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-thinking-interleaved",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-thinking-interleaved",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/composer", "send_message", {
        text: "stream thinking between text",
      });
      expect(result.status).toBe("ok");
      await runtime.waitForIdle();

      const transcript = await consumer.query("/transcript", 5);
      const assistant = transcript.children?.find(
        (child) => child.properties?.role === "assistant",
      );
      const content = assistant?.children?.find((child) => child.id === "content")?.children ?? [];

      expect(
        content.map((child) =>
          child.properties?.kind === "thinking_output" ? "thinking" : "text",
        ),
      ).toEqual(["thinking", "text", "thinking", "text"]);
      expect(content.map((child) => child.properties?.text)).toEqual([
        "thinking 1",
        "turn 1",
        "thinking 2",
        "turn 2",
      ]);
      expect(content[0]?.id).toBe("thinking-stream");
      expect(content[2]?.id).not.toBe("thinking-stream");
      expect(content[2]?.properties?.elapsed_ms).toBe(2000);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("sequences repeated thinking blocks around tool activity", async () => {
    const agentFactory: SessionAgentFactory = (callbacks) => ({
      start: async () => undefined,
      chat: async () => {
        callbacks.onThinking?.({
          id: "thinking-stream",
          provider: "openai",
          model: "gpt-5.4",
          format: "summary",
          display: "hidden",
          delta: "thinking before tool",
          startedAt: "2026-05-21T10:00:00.000Z",
        });
        callbacks.onToolEvent?.({
          kind: "started",
          invocation: {
            toolUseId: "tool-1",
            toolName: "filesystem__read",
            kind: "affordance",
            providerId: "filesystem",
            path: "/workspace",
            action: "read",
            params: { path: "README.md" },
          },
          summary: "filesystem:read README.md",
        });
        callbacks.onToolEvent?.({
          kind: "completed",
          invocation: {
            toolUseId: "tool-1",
            toolName: "filesystem__read",
            kind: "affordance",
            providerId: "filesystem",
            path: "/workspace",
            action: "read",
            params: { path: "README.md" },
          },
          summary: "filesystem:read README.md",
          status: "ok",
          result: {
            data: { path: "README.md" },
            kind: "json",
          },
        });
        callbacks.onThinking?.({
          id: "thinking-stream",
          provider: "openai",
          model: "gpt-5.4",
          format: "summary",
          display: "hidden",
          delta: "thinking after tool",
          startedAt: "2026-05-21T10:00:01.000Z",
        });
        callbacks.onText?.("final answer");
        return {
          status: "completed",
          response: "final answer",
        };
      },
      resumeWithToolResult: async () => ({ status: "completed", response: "resumed" }),
      invokeProvider: async () => ({ type: "result", id: "inv-test", status: "ok" }),
      resolveApprovalDirect: async () => ({ type: "result", id: "inv-test", status: "ok" }),
      rejectApprovalDirect: () => undefined,
      cancelActiveTurn: () => false,
      clearPendingApproval: () => undefined,
      shutdown: () => undefined,
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-thinking-tool-seq",
      agentFactory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-thinking-tool-seq",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/composer", "send_message", {
        text: "stream thinking around tools",
      });
      expect(result.status).toBe("ok");
      await runtime.waitForIdle();

      const transcript = await consumer.query("/transcript", 5);
      const assistant = transcript.children?.find(
        (child) => child.properties?.role === "assistant",
      );
      const content = assistant?.children?.find((child) => child.id === "content")?.children ?? [];
      const activity = await consumer.query("/activity", 3);
      const toolCall = activity.children?.find((child) => child.properties?.kind === "tool_call");
      const toolResult = activity.children?.find(
        (child) => child.properties?.kind === "tool_result",
      );

      expect(
        content.map((child) =>
          child.properties?.kind === "thinking_output" ? "thinking" : "text",
        ),
      ).toEqual(["thinking", "thinking", "text"]);
      expect(content.map((child) => child.properties?.text)).toEqual([
        "thinking before tool",
        "thinking after tool",
        "final answer",
      ]);
      expect(content[0]?.id).toBe("thinking-stream");
      expect(content[1]?.id).not.toBe("thinking-stream");
      expect(content[0]?.properties?.seq).toBeLessThan(toolCall?.properties?.seq as number);
      expect(toolResult?.properties?.seq).toBeLessThan(content[1]?.properties?.seq as number);
      expect(content[1]?.properties?.seq).toBeLessThan(content[2]?.properties?.seq as number);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("marks model token usage unavailable when the adapter omits usage", async () => {
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.createAdapter = async () =>
      ({
        chat: async (options: LlmChatOptions) => {
          options.onText?.("usage unavailable");
          return {
            content: [{ type: "text", text: "usage unavailable" }],
            stopReason: "end_turn",
            usage: {},
          } satisfies LlmResponse;
        },
      }) satisfies LlmAdapter;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-usage-unavailable",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-usage-unavailable",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/composer", "send_message", {
        text: "track unavailable usage",
      });
      expect(result.status).toBe("ok");
      await runtime.waitForIdle();

      const usage = await consumer.query("/usage", 1);
      expect(usage.properties?.last_model_call_input_tokens).toBeUndefined();
      expect(usage.properties?.last_model_call_output_tokens).toBeUndefined();
      expect(usage.properties?.last_model_call_input_source).toBe("unavailable");
      expect(usage.properties?.last_model_call_output_source).toBe("unavailable");
      expect(usage.properties?.current_turn_input_tokens).toBeUndefined();
      expect(usage.properties?.current_turn_output_tokens).toBeUndefined();
      expect(usage.properties?.total_input_tokens).toBeUndefined();
      expect(usage.properties?.total_output_tokens).toBeUndefined();
      expect(usage.properties?.total_tokens).toBeUndefined();
      expect(usage.properties?.current_turn_model_calls).toBe(1);
      expect(usage.properties?.last_state_context_tokens).toBeUndefined();
      expect(usage.properties?.last_state_context_token_source).toBe("unavailable");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("exposes typed client plugin manifests and a compact SLOP plugin projection", async () => {
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-plugins",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-plugins",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const plugins = await consumer.query("/plugins", 2);
      expect(plugins.properties?.count).toBeGreaterThanOrEqual(1);

      const goalPlugin = plugins.children?.find((item) => item.id === "persistent-goal");
      expect(goalPlugin?.properties?.status).toBe("active");
      expect(goalPlugin?.properties?.session_paths).toContain("/goal");
      expect(goalPlugin?.properties?.ui).toBeUndefined();
      expect(goalPlugin?.affordances).toBeUndefined();

      const clientPlugin = runtime
        .getClientSnapshot()
        .plugins.find((plugin) => plugin.id === "persistent-goal");
      expect(clientPlugin?.contributions.actions).toContainEqual(
        expect.objectContaining({ command: "create", available: true }),
      );
      expect(clientPlugin?.contributions.indicators[0]?.source).toBe("session.goal");

      const goal = await consumer.query("/goal", 1);
      expect(goal.properties?.status).toBe("none");
      expect(goal.affordances?.some((affordance) => affordance.action === "create_goal")).toBe(
        true,
      );
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("exposes persistent goal controls and pauses continuation after no tool activity", async () => {
    const harness = createNoToolGoalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      let goal = await consumer.query("/goal", 1);
      expect(goal.properties?.exists).toBe(false);
      expect(goal.affordances?.some((affordance) => affordance.action === "create_goal")).toBe(
        true,
      );

      const result = await consumer.invoke("/goal", "create_goal", {
        objective: "verify the goal loop",
        token_budget: 1000,
      });
      expect(result.status).toBe("ok");

      await runtime.waitForIdle();
      goal = await consumer.query("/goal", 1);
      expect(goal.properties?.exists).toBe(true);
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.objective).toBe("verify the goal loop");
      expect(goal.properties?.total_tokens).toBe(30);
      expect(goal.properties?.continuation_count).toBe(1);
      expect(harness.messages).toHaveLength(2);
      expect(harness.messages[1]).toContain("Continue the active persistent session goal");

      const extensions = await consumer.query("/extensions", 2);
      expect(extensions.properties?.namespaces).toContain("goal");
      expect(extensions.children?.[0]?.properties?.instance_id).toBe(goal.properties?.goal_id);

      const clearExtension = await consumer.invoke("/extensions/goal", "clear_extension", {});
      expect(clearExtension.status).toBe("ok");
      goal = await consumer.query("/goal", 1);
      expect(goal.properties?.exists).toBe(false);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("queued goal creation does not account the already-running user turn", async () => {
    const harness = createQueuedGoalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal-queued-accounting",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal-queued-accounting",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const userTurn = await consumer.invoke("/composer", "send_message", {
        text: "unrelated user turn",
      });
      expect(userTurn.status).toBe("ok");

      const goalStart = await consumer.invoke("/goal", "create_goal", {
        objective: "queued goal should own its own accounting",
      });
      expect(goalStart.status).toBe("ok");
      expect((goalStart.data as { status?: string }).status).toBe("queued");

      let queue = await consumer.query("/queue", 2);
      expect(queue.children?.[0]?.properties?.author).toBe("goal");
      expect(queue.children?.[0]?.properties?.goal_id).toEqual(expect.any(String));

      harness.resolve(0, "unrelated done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.messages[0]).toBe("unrelated user turn");
      expect(harness.messages[1]).toContain("Start working toward this persistent session goal");

      harness.resolve(1, "goal start done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.messages[2]).toContain("Continue the active persistent session goal");

      harness.resolve(2, "goal continuation done");
      await runtime.waitForIdle();

      const goal = await consumer.query("/goal", 1);
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.total_tokens).toBe(30);
      expect(goal.properties?.continuation_count).toBe(1);

      queue = await consumer.query("/queue", 2);
      expect(queue.children ?? []).toHaveLength(0);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("native goal turns expose a model-owned goal update tool with evidence", async () => {
    const llm = new GoalReportingLlm();
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.createAdapter = async () => llm;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal-model-update",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal-model-update",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/goal", "create_goal", {
        objective: "verify model-owned completion",
      });
      expect(result.status).toBe("ok");

      await runtime.waitForIdle();

      const goal = await consumer.query("/goal", 1);
      expect([...llm.seenToolNames]).toContain("slop_goal_update");
      expect(llm.observedToolResult).toContain("Goal is verified complete.");
      expect(goal.properties?.status).toBe("complete");
      expect(goal.properties?.update_source).toBe("model");
      expect(goal.properties?.completion_source).toBe("model");
      expect(goal.properties?.evidence).toEqual(["tests passed", "audit log captured"]);
      expect(goal.properties?.total_tokens).toBe(23);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("stale slop_goal_update cannot mutate a replacement goal", async () => {
    const llm = new StaleGoalUpdateLlm();
    const llmProfileManager = createTestProfileManager();
    llmProfileManager.createAdapter = async () => llm;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-goal-stale-update",
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-goal-stale-update",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const first = await consumer.invoke("/goal", "create_goal", {
        objective: "goal A",
      });
      expect(first.status).toBe("ok");
      expect((first.data as { status?: string }).status).toBe("started");

      const replacement = await consumer.invoke("/goal", "create_goal", {
        objective: "goal B",
      });
      expect(replacement.status).toBe("ok");
      expect((replacement.data as { status?: string }).status).toBe("queued");

      llm.releaseFirstCall();
      await runtime.waitForIdle();

      const goal = await consumer.query("/goal", 1);
      expect(llm.observedToolResult).toContain("goal_mismatch");
      expect(goal.properties?.objective).toBe("goal B");
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.completion_source).toBeUndefined();
      expect(goal.properties?.message).not.toContain("stale turn");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session marks provider and agent config changes as restart-required", async () => {
    const changedConfig: SloppyConfig = {
      ...TEST_CONFIG,
      plugins: {
        ...TEST_CONFIG.plugins,
        terminal: {
          ...TEST_CONFIG.plugins.terminal,
          enabled: !TEST_CONFIG.plugins.terminal.enabled,
        },
      },
    };
    const readyState = {
      status: "ready" as const,
      message: "ready",
      activeProfileId: "test-openai",
      selectedEndpointId: "openai",
      selectedProtocol: "openai-chat",
      selectedModel: "gpt-5.4",
      secureStoreKind: "memory",
      secureStoreStatus: "available" as const,
      profiles: [
        {
          kind: "native",
          id: "test-openai",
          label: "Test OpenAI",
          endpointId: "openai",
          protocol: "openai-chat",
          model: "gpt-5.4",
          authEnv: "OPENAI_API_KEY",
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
    const llmProfileManager = {
      getState: async () => readyState,
      ensureReady: async () => readyState,
      getConfig: () => changedConfig,
      updateConfig: () => undefined,
      createAdapter: async () => {
        throw new Error("not used");
      },
    } as unknown as LlmProfileManager;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-restart-required",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager,
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-restart-required",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const session = await consumer.query("/session", 1);
      expect(session.properties?.config_requires_restart).toBe(true);
      expect(session.properties?.config_restart_reason).toContain("Runtime provider or agent");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session reload_config refreshes scoped config and marks restart-required changes", async () => {
    const changedConfig: SloppyConfig = {
      ...TEST_CONFIG,
      llm: {
        ...TEST_CONFIG.llm,
        profiles: [
          {
            ...TEST_CONFIG.llm.profiles[0]!,
            model: "gpt-5.5",
          },
        ],
      },
      plugins: {
        ...TEST_CONFIG.plugins,
        terminal: {
          ...TEST_CONFIG.plugins.terminal,
          enabled: !TEST_CONFIG.plugins.terminal.enabled,
        },
      },
    };
    const llmProfileManager = createTestProfileManager();
    let reloadCount = 0;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-reload-config",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager,
      configReloader: async () => {
        reloadCount += 1;
        return changedConfig;
      },
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-reload-config",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();

      const result = await consumer.invoke("/session", "reload_config");
      expect(result.status).toBe("ok");
      expect(result.data).toMatchObject({
        status: "ok",
        configRequiresRestart: true,
      });
      expect(reloadCount).toBe(1);

      const session = await consumer.query("/session", 1);
      const llm = await consumer.query("/llm", 1);
      expect(session.properties?.config_requires_restart).toBe(true);
      expect(session.properties?.config_restart_reason).toContain(
        "Runtime provider or agent configuration changed",
      );
      expect(llm.properties?.selected_model).toBe("gpt-5.5");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session recovers persisted stale turns at the public provider boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-runtime-recover-"));
    const persistencePath = join(root, "session.json");
    const seeded = new SessionStore({
      sessionId: "sess-runtime-recover",
      modelProvider: "openai",
      model: "gpt-5.4",
      workspaceRoot: root,
      persistencePath,
      ...persistentGoalStoreOptions(),
    });
    seedGoal(seeded, "recover runtime state", "Goal active before restart.");
    const queued = seeded.enqueueMessage("queued before restart");
    const turnId = seeded.beginTurn("blocked before restart");
    seeded.appendAssistantText(turnId, "partial answer");
    seeded.recordApprovalRequested(turnId, {
      toolUseId: "tool-recover",
      summary: "terminal:execute /session",
      provider: "terminal",
      path: "/session",
      action: "execute",
      reason: "Needs approval",
    });
    seeded.syncProviderApprovals("terminal", [
      {
        id: "approval-recover",
        status: "pending",
        provider: "terminal",
        path: "/session",
        action: "execute",
        reason: "Needs approval",
        createdAt: new Date().toISOString(),
        canApprove: true,
        canReject: true,
        turnId,
      },
    ]);
    seeded.syncProviderTasks("terminal", [
      {
        id: "task-recover",
        status: "running",
        provider: "terminal",
        providerTaskId: "provider-task-recover",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "Still running before restart",
        turnId,
        canCancel: true,
      },
    ]);

    const harness = createNoToolGoalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-runtime-recover",
      sessionPersistencePath: persistencePath,
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-runtime-recover",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const session = await consumer.query("/session", 1);
      expect(session.properties?.recovered_after_restart).toBe(true);
      expect(session.properties?.last_error).toContain("could not be resumed");

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("error");
      expect(turn.properties?.waiting_on).toBeNull();
      expect(
        turn.affordances?.some((affordance) => affordance.action === "cancel_turn") ?? false,
      ).toBe(false);

      const goal = await consumer.query("/goal", 1);
      expect(goal.properties?.status).toBe("paused");
      expect(goal.properties?.message).toContain("process restart");
      expect(goal.properties?.update_source).toBe("runtime");

      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.[0]?.properties?.status).toBe("expired");
      expect(approvals.children?.[0]?.affordances ?? []).toHaveLength(0);

      const tasks = await consumer.query("/tasks", 3);
      expect(tasks.children?.[0]?.properties?.status).toBe("superseded");
      expect(tasks.children?.[0]?.properties?.error).toContain("could not be resumed");
      expect(tasks.children?.[0]?.affordances ?? []).toHaveLength(0);

      const queue = await consumer.query("/queue", 2);
      expect(queue.children?.[0]?.id).toBe(queued.id);
      expect(queue.children?.[0]?.properties?.text).toBe("queued before restart");

      const cancelQueued = await consumer.invoke(`/queue/${queued.id}`, "cancel", {});
      expect(cancelQueued.status).toBe("ok");

      const send = await consumer.invoke("/composer", "send_message", {
        text: "fresh after restart",
      });
      expect(send.status).toBe("ok");
      await runtime.waitForIdle();

      const recoveredTurn = await consumer.query("/turn", 1);
      expect(recoveredTurn.properties?.state).toBe("idle");
      expect(harness.messages[0]).toBe("fresh after restart");
    } finally {
      provider.stop();
      runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

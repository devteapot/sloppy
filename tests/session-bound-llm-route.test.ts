import { afterEach, describe, expect, test } from "bun:test";

import type { AgentCallbacks } from "../src/core/agent";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { SessionRuntime } from "../src/session/runtime";
import type { SessionAgent } from "../src/session/runtime-contracts";
import {
  createStreamingAgentFactory,
  MemoryCredentialStore,
} from "./helpers/agent-session-provider-harness";
import { createTestConfig } from "./helpers/config";

const BOUND_DEFAULT_KEY_ENV = "SLOPPY_TEST_BOUND_DEFAULT_KEY";
const originalBoundDefaultKey = process.env[BOUND_DEFAULT_KEY_ENV];

afterEach(() => {
  if (originalBoundDefaultKey === undefined) {
    delete process.env[BOUND_DEFAULT_KEY_ENV];
  } else {
    process.env[BOUND_DEFAULT_KEY_ENV] = originalBoundDefaultKey;
  }
});

function createBoundRouteHarness() {
  delete process.env[BOUND_DEFAULT_KEY_ENV];
  const config = createTestConfig({
    llm: {
      endpoints: {
        blocked: {
          protocol: "openai-chat",
          baseUrl: "https://blocked.example.test/v1",
          auth: { type: "env", env: BOUND_DEFAULT_KEY_ENV },
          models: {
            "blocked-model": {},
          },
        },
        routed: {
          protocol: "openai-chat",
          baseUrl: "https://routed.example.test/v1",
          auth: { type: "none" },
          models: {
            "base-model": {
              contextWindowTokens: 111_000,
              maxOutputTokens: 1_111,
              capabilities: { tools: true, images: false },
            },
            "override-model": {
              contextWindowTokens: 222_000,
              maxOutputTokens: 3_333,
              capabilities: { tools: false, images: true },
            },
          },
        },
      },
      defaultProfileId: "blocked-default",
      profiles: [
        {
          kind: "native",
          id: "blocked-default",
          endpointId: "blocked",
          model: "blocked-model",
        },
        {
          kind: "native",
          id: "other-ready",
          endpointId: "routed",
          model: "base-model",
        },
        {
          kind: "native",
          id: "bound-ready",
          endpointId: "routed",
          model: "base-model",
        },
      ],
    },
  });
  const manager = new LlmProfileManager({
    config,
    credentialStore: new MemoryCredentialStore("available"),
    writeConfig: async () => undefined,
  });
  return { config, manager };
}

describe("bound Session LLM routes", () => {
  test("projects readiness and model metadata from an explicit route without changing the default", async () => {
    const { manager } = createBoundRouteHarness();

    const routed = await manager.ensureReady({
      profileId: "bound-ready",
      modelOverride: "override-model",
    });

    expect(routed).toMatchObject({
      status: "ready",
      activeProfileId: "bound-ready",
      selectedEndpointId: "routed",
      selectedModel: "override-model",
      selectedContextWindowTokens: 222_000,
      selectedMaxOutputTokens: 3_333,
      selectedCapabilities: { tools: false, images: true },
      selectedOwnsToolLoop: false,
    });
    expect(routed.profiles.find((profile) => profile.id === "bound-ready")).toMatchObject({
      model: "override-model",
      contextWindowTokens: 222_000,
      maxOutputTokens: 3_333,
      capabilities: { tools: false, images: true },
      isDefault: true,
    });
    expect(routed.profiles.find((profile) => profile.id === "blocked-default")?.isDefault).toBe(
      false,
    );

    const defaultState = await manager.getState();
    expect(defaultState).toMatchObject({
      status: "needs_credentials",
      activeProfileId: "blocked-default",
      selectedModel: "blocked-model",
    });
  });

  test("uses the bound route for Session startup state and send readiness", async () => {
    const { config, manager } = createBoundRouteHarness();
    const runtime = new SessionRuntime({
      config,
      sessionId: "bound-route-session",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      llmModelOverride: "override-model",
      agentFactory: createStreamingAgentFactory(),
    });

    try {
      await runtime.start();

      const started = runtime.store.getSnapshot();
      expect(started.llm).toMatchObject({
        status: "ready",
        activeProfileId: "bound-ready",
        selectedEndpointId: "routed",
        selectedModel: "override-model",
        selectedContextWindowTokens: 222_000,
        selectedMaxOutputTokens: 3_333,
        selectedCapabilities: { tools: false, images: true },
      });
      expect(started.session).toMatchObject({
        modelProvider: "routed",
        model: "override-model",
      });
      expect(started.usage.modelContextWindowTokens).toBe(222_000);

      await expect(runtime.sendMessage("use the bound route")).resolves.toMatchObject({
        status: "started",
      });
      await runtime.waitForIdle();
      expect(runtime.store.getSnapshot().turn.state).toBe("idle");

      const defaultState = await manager.getState();
      expect(defaultState.status).toBe("needs_credentials");
      expect(defaultState.activeProfileId).toBe("blocked-default");
    } finally {
      runtime.shutdown();
    }
  });

  test("keeps the bound route projected after profile, default, key, and deletion mutations", async () => {
    const { config, manager } = createBoundRouteHarness();
    const runtime = new SessionRuntime({
      config,
      sessionId: "bound-route-mutations",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      llmModelOverride: "override-model",
      agentFactory: createStreamingAgentFactory(),
    });
    const expectBoundRoute = () => {
      expect(runtime.store.getSnapshot().llm).toMatchObject({
        status: "ready",
        activeProfileId: "bound-ready",
        selectedEndpointId: "routed",
        selectedModel: "override-model",
        selectedCapabilities: { tools: false, images: true },
      });
      expect(runtime.getClientSnapshot().controls.canSendMessage).toBe(true);
    };

    try {
      await runtime.start();

      await runtime.saveLlmProfile({
        profile_id: "blocked-default",
        label: "Still blocked",
      });
      expectBoundRoute();

      await runtime.setDefaultLlmProfile("blocked-default");
      expectBoundRoute();

      await runtime.deleteLlmApiKey("blocked-default");
      expectBoundRoute();

      await runtime.deleteLlmProfile("blocked-default");
      expectBoundRoute();
      expect((await manager.getState()).activeProfileId).toBe("other-ready");
    } finally {
      runtime.shutdown();
    }
  });

  test("rejects deletion of the profile to which the Session is bound", async () => {
    const { config, manager } = createBoundRouteHarness();
    const runtime = new SessionRuntime({
      config,
      sessionId: "bound-route-delete",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      llmModelOverride: "override-model",
      agentFactory: createStreamingAgentFactory(),
    });

    try {
      await runtime.start();

      await expect(runtime.deleteLlmProfile("bound-ready")).rejects.toThrow(
        "live session is bound to it",
      );
      expect(
        (await manager.getState({ profileId: "bound-ready" })).profiles.some(
          (profile) => profile.id === "bound-ready",
        ),
      ).toBe(true);
      expect(runtime.store.getSnapshot().llm.activeProfileId).toBe("bound-ready");
    } finally {
      runtime.shutdown();
    }
  });

  test("shares profile leases across Sessions, moves unbound leases, and releases them on shutdown", async () => {
    const { config, manager } = createBoundRouteHarness();
    const bound = new SessionRuntime({
      config,
      sessionId: "lease-bound-session",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      llmModelOverride: "override-model",
      agentFactory: createStreamingAgentFactory(),
    });
    const sibling = new SessionRuntime({
      config,
      sessionId: "lease-sibling-session",
      llmProfileManager: manager,
      agentFactory: createStreamingAgentFactory(),
    });
    let boundStopped = false;

    try {
      await bound.start();
      await sibling.start();

      await expect(sibling.deleteLlmProfile("bound-ready")).rejects.toThrow(
        "live session is bound to it",
      );
      await expect(manager.deleteProfile("blocked-default")).rejects.toThrow(
        "live session is bound to it",
      );

      await sibling.setDefaultLlmProfile("other-ready");
      await expect(sibling.deleteLlmProfile("blocked-default")).resolves.toMatchObject({
        status: "ok",
      });

      bound.shutdown();
      boundStopped = true;
      await expect(sibling.deleteLlmProfile("bound-ready")).resolves.toMatchObject({
        status: "ok",
      });
    } finally {
      if (!boundStopped) {
        bound.shutdown();
      }
      sibling.shutdown();
    }
  });

  test("finishes runtime cleanup when agent shutdown throws", async () => {
    const { config, manager } = createBoundRouteHarness();
    const baseFactory = createStreamingAgentFactory();
    const runtime = new SessionRuntime({
      config,
      sessionId: "shutdown-cleanup",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      agentFactory: (callbacks, agentConfig, profileManager) => {
        const agent = baseFactory(callbacks, agentConfig, profileManager);
        return {
          ...agent,
          shutdown() {
            throw new Error("agent shutdown failed");
          },
        };
      },
    });

    await runtime.start();

    expect(() => runtime.shutdown()).toThrow("agent shutdown failed");
    expect(runtime.store.getSnapshot().session.status).toBe("closed");
    await expect(manager.deleteProfile("bound-ready")).resolves.toMatchObject({
      activeProfileId: "blocked-default",
    });
  });

  test("ignores late usage and provider callbacks after shutdown", async () => {
    const { config, manager } = createBoundRouteHarness();
    let callbacks: AgentCallbacks | undefined;
    const runtime = new SessionRuntime({
      config,
      sessionId: "late-callback-shutdown",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      agentFactory: (capturedCallbacks): SessionAgent => {
        callbacks = capturedCallbacks;
        return {
          start: async () => undefined,
          chat: async () => ({ status: "completed", response: "unused" }),
          resumeWithToolResult: async () => ({ status: "completed", response: "unused" }),
          invokeProvider: async () => ({ type: "result", id: "unused", status: "ok" }),
          resolveApprovalDirect: async () => ({ type: "result", id: "unused", status: "ok" }),
          rejectApprovalDirect: () => undefined,
          cancelActiveTurn: () => false,
          clearPendingApproval: () => undefined,
          shutdown: () => undefined,
        };
      },
    });

    await runtime.start();
    if (!callbacks) throw new Error("Expected Session callbacks to be captured.");
    callbacks.onTurnUsage?.({
      inputTokens: 2,
      outputTokens: 3,
      inputTokenSource: "reported",
      outputTokenSource: "reported",
      stateContextTokenSource: "unavailable",
    });
    callbacks.onExternalProviderStates?.([
      { id: "remote", name: "Remote", transport: "test", status: "connected" },
    ]);
    callbacks.onProviderSnapshot?.({
      providerId: "terminal",
      path: "/tasks",
      tree: {
        id: "tasks",
        type: "collection",
        children: [
          {
            id: "task-1",
            type: "item",
            properties: {
              status: "running",
              provider_task_id: "task-1",
              message: "Running",
            },
          },
        ],
      },
    });
    const beforeShutdown = runtime.store.getSnapshot();

    runtime.shutdown();
    callbacks.onTurnUsage?.({
      inputTokens: 100,
      outputTokens: 200,
      inputTokenSource: "reported",
      outputTokenSource: "reported",
      stateContextTokenSource: "unavailable",
    });
    callbacks.onExternalProviderStates?.([
      { id: "late", name: "Late", transport: "test", status: "connected" },
    ]);
    callbacks.onProviderSnapshot?.({
      providerId: "terminal",
      path: "/tasks",
      tree: { id: "tasks", type: "collection", children: [] },
    });

    const stopped = runtime.store.getSnapshot();
    expect(stopped.session.status).toBe("closed");
    expect(stopped.usage).toEqual(beforeShutdown.usage);
    expect(stopped.apps).toEqual(beforeShutdown.apps);
    expect(stopped.tasks).toEqual(beforeShutdown.tasks);
  });

  test("projects a removed bound route as unavailable after config reload", async () => {
    const { config, manager } = createBoundRouteHarness();
    const reloadedConfig = {
      ...config,
      llm: {
        ...config.llm,
        profiles: config.llm.profiles.filter((profile) => profile.id !== "bound-ready"),
      },
    };
    const runtime = new SessionRuntime({
      config,
      sessionId: "bound-route-removed",
      llmProfileManager: manager,
      llmProfileId: "bound-ready",
      llmModelOverride: "override-model",
      agentFactory: createStreamingAgentFactory(),
      configReloader: async () => reloadedConfig,
    });

    try {
      await runtime.start();
      expect(runtime.getClientSnapshot().controls.canSendMessage).toBe(true);

      await expect(runtime.reloadConfig()).resolves.toMatchObject({ status: "ok" });

      const snapshot = runtime.store.getSnapshot();
      expect(snapshot.llm).toMatchObject({
        status: "needs_credentials",
        activeProfileId: "bound-ready",
        selectedModel: "override-model",
      });
      expect(snapshot.llm.message).toContain("is not available");
      expect(snapshot.llm.profiles.find((profile) => profile.id === "bound-ready")).toMatchObject({
        ready: false,
        isDefault: true,
        canDeleteProfile: false,
      });
      expect(snapshot.session.modelProvider).toBe("unavailable");
      expect(runtime.getClientSnapshot().controls.canSendMessage).toBe(false);
      await expect(runtime.sendMessage("must remain blocked")).rejects.toThrow("is not available");
      expect(runtime.getClientSnapshot().controls.canSendMessage).toBe(false);
    } finally {
      runtime.shutdown();
    }
  });
});

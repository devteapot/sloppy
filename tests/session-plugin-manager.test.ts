import { describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../src/config/load";
import type { LocalRuntimeTool } from "../src/core/agent";
import { goalSnapshotToExtension } from "../src/plugins/first-party/persistent-goal/goal-schema";
import { createPersistentGoalPlugin } from "../src/plugins/first-party/persistent-goal/session";
import { SessionPluginManager } from "../src/session/plugins";
import type { PluginRuntimeContext, SessionRuntimePlugin } from "../src/session/plugins/types";
import { SessionStore } from "../src/session/store";

function createStore(): SessionStore {
  const plugin = createPersistentGoalPlugin();
  return new SessionStore({
    sessionId: "plugin-manager-test",
    modelProvider: "openai",
    model: "gpt-5.4",
    snapshotMigrators: plugin.migrateSnapshot ? [plugin.migrateSnapshot] : [],
    snapshotRecoverers: plugin.recoverSnapshot ? [plugin.recoverSnapshot] : [],
    snapshotProjections: plugin.snapshotProjections ?? [],
    extensionEventTypes: plugin.extensionEvents ?? {},
  });
}

function seedGoal(store: SessionStore, objective: string): string {
  const timestamp = new Date().toISOString();
  const goalId = "goal-plugin-manager";
  store.upsertExtension(
    goalSnapshotToExtension({
      goalId,
      objective,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      elapsedMs: 0,
      continuationCount: 0,
      message: "Goal active.",
    }),
  );
  return goalId;
}

function createContext(store = createStore()): PluginRuntimeContext {
  return {
    config: () => createDefaultConfig(),
    store,
    snapshot: () => store.getSnapshot(),
    ensureReady: async () => undefined,
    invokeProvider: async () => {
      throw new Error("not used");
    },
    queryProvider: async () => {
      throw new Error("not used");
    },
    startTurn: (request) => ({ status: "started", turnId: request.runId }),
    queueTurn: (request) => ({
      status: "queued",
      queuedMessageId: request.runId,
      position: 1,
    }),
    drainQueue: () => undefined,
    audit: () => undefined,
  };
}

function localTool(name: string): LocalRuntimeTool {
  return {
    tool: {
      type: "function",
      function: {
        name,
        description: "test local tool",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    execute: () => ({ status: "ok", summary: "ok", content: { ok: true } }),
  };
}

function toolPlugin(id: string, toolName: string): SessionRuntimePlugin {
  return {
    id,
    version: "1.0.0",
    localTools: () => [localTool(toolName)],
  };
}

describe("SessionPluginManager", () => {
  test("requires pluginId on plugin-owned queued turns", () => {
    const store = createStore();
    const goalId = seedGoal(store, "continue plugin-owned work");
    const manager = new SessionPluginManager([createPersistentGoalPlugin()], createContext(store));

    expect(
      manager.acceptQueuedTurn({
        id: "queued-without-plugin",
        status: "queued",
        text: "continue",
        createdAt: "2026-05-01T00:00:00.000Z",
        author: "goal",
        goalId,
        continuation: true,
      }),
    ).toBeNull();

    expect(
      manager.acceptQueuedTurn({
        id: "queued-plugin",
        status: "queued",
        text: "continue",
        createdAt: "2026-05-01T00:00:00.000Z",
        author: "goal",
        source: "plugin",
        pluginId: "persistent-goal",
        pluginRunId: goalId,
        continuation: true,
      })?.pluginId,
    ).toBe("persistent-goal");
  });

  test("stamps local runtime tools with plugin ownership", () => {
    const manager = new SessionPluginManager([toolPlugin("alpha", "alpha_tool")], createContext());

    expect(manager.localTools(null)[0]?.pluginId).toBe("alpha");
  });

  test("rejects session plugin ids that cannot be raw slash namespaces", () => {
    expect(
      () => new SessionPluginManager([toolPlugin("bad plugin", "bad_tool")], createContext()),
    ).toThrow(
      "Invalid session plugin id 'bad plugin'. Plugin ids must be non-empty and cannot contain whitespace or ':'.",
    );
    expect(
      () => new SessionPluginManager([toolPlugin("bad:plugin", "bad_tool")], createContext()),
    ).toThrow(
      "Invalid session plugin id 'bad:plugin'. Plugin ids must be non-empty and cannot contain whitespace or ':'.",
    );
  });

  test("rejects duplicate session plugin ids", () => {
    expect(
      () =>
        new SessionPluginManager(
          [toolPlugin("alpha", "alpha_tool"), toolPlugin("alpha", "second_tool")],
          createContext(),
        ),
    ).toThrow("Duplicate session plugin id 'alpha'. Plugin ids must be unique.");
  });

  test("rejects duplicate local runtime tool names across plugins", () => {
    const manager = new SessionPluginManager(
      [toolPlugin("alpha", "shared_tool"), toolPlugin("beta", "shared_tool")],
      createContext(),
    );

    expect(() => manager.localTools(null)).toThrow(
      "Duplicate local runtime tool shared_tool registered by alpha and beta.",
    );
  });
});

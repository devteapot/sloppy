import { describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../src/config/load";
import type { LocalRuntimeTool } from "../src/core/agent";
import { goalSnapshotToExtension } from "../src/plugins/first-party/persistent-goal/goal-schema";
import { createPersistentGoalPlugin } from "../src/plugins/first-party/persistent-goal/session";
import { SessionPluginManager } from "../src/session/plugins";
import type { PluginRuntimeContext, SessionRuntimePlugin } from "../src/session/plugins/types";
import { SessionStore } from "../src/session/store";
import type { JsonObject } from "../src/session/types";

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
  let transientState: JsonObject | undefined;
  return {
    config: () => createDefaultConfig(),
    store,
    snapshot: () => store.getSnapshot(),
    ensureReady: async () => undefined,
    getRuntimeService: () => undefined,
    invokeProvider: async () => {
      throw new Error("not used");
    },
    queryProvider: async () => {
      throw new Error("not used");
    },
    transientState: {
      read: <T extends JsonObject>() => transientState as T | undefined,
      replace: (state) => {
        transientState = state;
      },
      update: <T extends JsonObject>(
        updater: (current: Readonly<T> | undefined) => T | undefined,
      ) => {
        transientState = updater(transientState as T | undefined);
      },
      clear: () => {
        transientState = undefined;
      },
    },
    approvals: {
      request: () => ({ status: "approval_required", approvalId: "approval-test" }),
      cancel: () => true,
    },
    turns: {
      submit: (request) => ({ status: "started", turnId: request.runId }),
      drainQueue: () => undefined,
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
    const manager = new SessionPluginManager([createPersistentGoalPlugin()], () =>
      createContext(store),
    );

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
    const manager = new SessionPluginManager([toolPlugin("alpha", "alpha_tool")], () =>
      createContext(),
    );

    expect(manager.localTools(null)[0]?.pluginId).toBe("alpha");
  });

  test("rejects session plugin ids that cannot be raw slash namespaces", () => {
    expect(
      () => new SessionPluginManager([toolPlugin("bad plugin", "bad_tool")], () => createContext()),
    ).toThrow(
      "Invalid session plugin id 'bad plugin'. Plugin ids must be non-empty and cannot contain whitespace or ':'.",
    );
    expect(
      () => new SessionPluginManager([toolPlugin("bad:plugin", "bad_tool")], () => createContext()),
    ).toThrow(
      "Invalid session plugin id 'bad:plugin'. Plugin ids must be non-empty and cannot contain whitespace or ':'.",
    );
  });

  test("rejects duplicate session plugin ids", () => {
    expect(
      () =>
        new SessionPluginManager(
          [toolPlugin("alpha", "alpha_tool"), toolPlugin("alpha", "second_tool")],
          () => createContext(),
        ),
    ).toThrow("Duplicate session plugin id 'alpha'. Plugin ids must be unique.");
  });

  test("rejects duplicate local runtime tool names across plugins", () => {
    const manager = new SessionPluginManager(
      [toolPlugin("alpha", "shared_tool"), toolPlugin("beta", "shared_tool")],
      () => createContext(),
    );

    expect(() => manager.localTools(null)).toThrow(
      "Duplicate local runtime tool shared_tool registered by alpha and beta.",
    );
  });

  test("rejects duplicate and dangling typed client contributions", () => {
    const duplicateCommands: SessionRuntimePlugin = {
      id: "client-plugin",
      version: "1.0.0",
      clientCommands: () => [
        { id: "run", execute: () => undefined },
        { id: "run", execute: () => undefined },
      ],
    };
    expect(() => new SessionPluginManager([duplicateCommands], () => createContext())).toThrow(
      "Duplicate client command client-plugin:run.",
    );

    const danglingAction: SessionRuntimePlugin = {
      id: "client-plugin",
      version: "1.0.0",
      client: {
        actions: [
          {
            id: "client:run",
            label: "Run",
            description: "Run the client command",
            command: "missing",
          },
        ],
      },
    };
    expect(() => new SessionPluginManager([danglingAction], () => createContext())).toThrow(
      "Client action client-plugin:client:run references unknown command missing.",
    );
  });

  test("computes typed client command availability on the server", () => {
    const store = createStore();
    const manager = new SessionPluginManager([createPersistentGoalPlugin()], () =>
      createContext(store),
    );
    const before = manager.clientPlugins()[0]?.contributions.actions;
    expect(before?.find((action) => action.command === "create")?.available).toBe(true);
    expect(before?.find((action) => action.command === "pause")?.available).toBe(false);

    seedGoal(store, "exercise typed plugin actions");
    const after = manager.clientPlugins()[0]?.contributions.actions;
    expect(after?.find((action) => action.command === "pause")?.available).toBe(true);
    expect(after?.find((action) => action.command === "create")?.available).toBe(false);
  });

  test("projects cloned transient Plugin state for typed clients", () => {
    const ctx = createContext();
    ctx.transientState.replace({ phase: "listening", partial: "hello" });
    const manager = new SessionPluginManager(
      [
        {
          id: "voice",
          version: "1.0.0",
          clientState: (pluginCtx) => pluginCtx.transientState.read(),
        },
      ],
      () => ctx,
    );

    expect(manager.clientState()).toEqual({
      voice: { phase: "listening", partial: "hello" },
    });
  });

  test("awaits shutdown hooks sequentially in reverse Plugin order", async () => {
    const order: string[] = [];
    const plugin = (id: string): SessionRuntimePlugin => ({
      id,
      version: "1.0.0",
      onShutdown: async () => {
        await Promise.resolve();
        order.push(id);
      },
    });
    const manager = new SessionPluginManager([plugin("alpha"), plugin("beta")], () =>
      createContext(),
    );

    await manager.onShutdown();

    expect(order).toEqual(["beta", "alpha"]);
  });
});

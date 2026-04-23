import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { createSlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../src/config/schema";
import { ConsumerHub } from "../src/core/consumer";
import {
  DelegationProvider,
  type DelegationRunnerFactory,
} from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import type { RegisteredProvider } from "../src/providers/registry";

const TEST_CONFIG: SloppyConfig = {
  llm: { provider: "openai", model: "gpt-5.4", profiles: [], maxTokens: 4096 },
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
    maxToolResultSize: 4096,
  },
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
      vision: false,
    },
    discovery: { enabled: false, paths: [] },
    terminal: { cwd: ".", historyLimit: 10, syncTimeoutMs: 30000 },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
    },
    memory: { maxMemories: 500, defaultWeight: 0.5, compactThreshold: 0.2 },
    skills: { skillsDir: "~/.hermes/skills" },
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: { maxAgents: 10 },
    vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
  },
};

function createMockChildServer(id: string, name: string, statusProp: { value: string }) {
  const server = createSlopServer({ id, name });
  server.register("session", () => ({
    type: "context",
    props: {
      session_id: id,
      status: statusProp.value,
    },
  }));
  return server;
}

describe("Agent orchestration (sub-agent federation)", () => {
  test("runner factory can register a child session provider into the parent hub", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    await hub.connect();

    const childStatus = { value: "running" };
    let sessionProviderId = "";

    const factory: DelegationRunnerFactory = (spawn, callbacks) => {
      sessionProviderId = `sub-agent-${spawn.id}`;
      const server = createMockChildServer(
        sessionProviderId,
        `Sub-agent: ${spawn.name}`,
        childStatus,
      );
      const registered: RegisteredProvider = {
        id: sessionProviderId,
        name: `Sub-agent: ${spawn.name}`,
        kind: "builtin",
        transport: new InProcessTransport(server),
        transportLabel: "in-process",
        stop: () => server.stop(),
      };

      return {
        async start() {
          await hub.addProvider(registered);
          callbacks.onUpdate({
            status: "running",
            session_provider_id: sessionProviderId,
          });
          // Simulate completion on next tick.
          queueMicrotask(() => {
            childStatus.value = "completed";
            server.refresh();
            callbacks.onUpdate({
              status: "completed",
              result: `ran ${spawn.goal}`,
              completed_at: new Date().toISOString(),
            });
          });
        },
        async cancel() {
          hub.removeProvider(sessionProviderId);
        },
      };
    };

    const provider = new DelegationProvider({ maxAgents: 5, runnerFactory: factory });
    const delegationRegistered: RegisteredProvider = {
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(provider.server),
      transportLabel: "in-process",
      stop: () => provider.stop(),
    };
    await hub.addProvider(delegationRegistered);

    const parentConsumer = new SlopConsumer(new InProcessTransport(provider.server));
    await parentConsumer.connect();
    await parentConsumer.subscribe("/", 3);

    try {
      const spawnResult = await parentConsumer.invoke("/session", "spawn_agent", {
        name: "child-1",
        goal: "investigate foo",
      });
      expect(spawnResult.status).toBe("ok");
      const { id: agentId } = spawnResult.data as { id: string };

      // Wait for queueMicrotask completion + refresh propagation
      for (let i = 0; i < 50; i++) {
        const agents = await parentConsumer.query("/agents", 2);
        const child = agents.children?.[0];
        if (child?.properties?.status === "completed") {
          expect(child.properties).toMatchObject({
            id: agentId,
            name: "child-1",
            status: "completed",
            session_provider_id: sessionProviderId,
          });
          expect(hub.getProviderViews().map((view) => view.providerId)).toContain(
            sessionProviderId,
          );
          return;
        }
        await Bun.sleep(20);
      }

      throw new Error("Timed out waiting for child agent to complete");
    } finally {
      parentConsumer.disconnect();
      hub.shutdown();
    }
  });

  test("SubAgentRunner creates + fails a task when orchestration provider is present", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SubAgentRunner } = await import("../src/core/sub-agent");
    const { OrchestrationProvider } = await import("../src/providers/builtin/orchestration");

    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-orch-fed-"));
    try {
      const orchestration = new OrchestrationProvider({
        workspaceRoot,
        sessionId: "sess-fed",
      });
      const hub = new ConsumerHub([], TEST_CONFIG);
      await hub.connect();
      await hub.addProvider({
        id: "orchestration",
        name: "Orchestration",
        kind: "builtin",
        transport: new InProcessTransport(orchestration.server),
        transportLabel: "in-process",
        stop: () => orchestration.stop(),
      });

      const runner = new SubAgentRunner({
        id: "abc123",
        name: "analyze",
        goal: "analyze the spec",
        parentHub: hub,
        parentConfig: TEST_CONFIG,
        orchestrationProviderId: "orchestration",
      });

      // Without a valid LLM profile, the runtime will fail on sendMessage.
      // SubAgentRunner catches that and records a task failure.
      await runner.start();

      const consumer = new SlopConsumer(new InProcessTransport(orchestration.server));
      await consumer.connect();
      await consumer.subscribe("/", 3);

      try {
        // Poll briefly for task to appear + settle into failed state
        let failed = false;
        for (let i = 0; i < 50; i++) {
          const tasks = await consumer.query("/tasks", 2);
          const task = tasks.children?.[0];
          if (task?.properties?.status === "failed") {
            expect(task.properties).toMatchObject({
              name: "analyze",
              goal: "analyze the spec",
              status: "failed",
            });
            expect(task.properties?.error).toBeString();
            failed = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(failed).toBe(true);
      } finally {
        consumer.disconnect();
        runner.shutdown();
        hub.shutdown();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("cancel tears down the child session provider", async () => {
    const hub = new ConsumerHub([], TEST_CONFIG);
    await hub.connect();

    const factory: DelegationRunnerFactory = (spawn, callbacks) => {
      const childId = `sub-agent-${spawn.id}`;
      const server = createSlopServer({ id: childId, name: "child" });
      server.register("session", () => ({ type: "context", props: { session_id: childId } }));
      const registered: RegisteredProvider = {
        id: childId,
        name: "child",
        kind: "builtin",
        transport: new InProcessTransport(server),
        transportLabel: "in-process",
        stop: () => server.stop(),
      };
      let cancelled = false;
      return {
        async start() {
          await hub.addProvider(registered);
          callbacks.onUpdate({ status: "running", session_provider_id: childId });
          // Keep running until cancelled
          await new Promise<void>((resolve) => {
            const check = () => {
              if (cancelled) return resolve();
              setTimeout(check, 10);
            };
            check();
          });
        },
        async cancel() {
          cancelled = true;
          hub.removeProvider(childId);
        },
      };
    };

    const provider = new DelegationProvider({ maxAgents: 5, runnerFactory: factory });
    await hub.addProvider({
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(provider.server),
      transportLabel: "in-process",
      stop: () => provider.stop(),
    });

    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    try {
      const spawnResult = await consumer.invoke("/session", "spawn_agent", {
        name: "kill-me",
        goal: "loop forever",
      });
      const { id: agentId } = spawnResult.data as { id: string };

      // Wait for registration
      await Bun.sleep(30);
      const childId = `sub-agent-${agentId}`;
      expect(hub.getProviderViews().map((view) => view.providerId)).toContain(childId);

      await consumer.invoke(`/agents/${agentId}`, "cancel", {});
      await Bun.sleep(30);
      expect(hub.getProviderViews().map((view) => view.providerId)).not.toContain(childId);
    } finally {
      consumer.disconnect();
      hub.shutdown();
    }
  });
});

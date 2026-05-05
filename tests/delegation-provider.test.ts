import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { DelegationProvider } from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";

function createDelegationHarness(
  options: ConstructorParameters<typeof DelegationProvider>[0] = {},
) {
  const provider = new DelegationProvider({
    maxAgents: 10,
    ...options,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  // Disconnect and reconnect to ensure clean subscription state
  // Each test gets a fresh consumer, but re-connecting guarantees
  // no stale subscriptions from prior test runs in the same process.
  await consumer.disconnect();
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

async function waitFor<T>(
  check: () => Promise<T | null>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

async function spawnAgent(
  consumer: SlopConsumer,
  name = "research-agent",
  goal = "Investigate a protocol detail",
  profileId = "gpt-5.4",
): Promise<string> {
  const result = await consumer.invoke("/session", "spawn_agent", {
    name,
    goal,
    executor: { kind: "llm", profileId },
  });
  expect(result.status).toBe("ok");

  const data = result.data as { id: string; status: string; created_at: string };
  expect(data.id).toStartWith("agent-");
  expect(data.status).toBe("pending");
  expect(new Date(data.created_at).toString()).not.toBe("Invalid Date");

  return data.id;
}

describe("DelegationProvider", () => {
  test("exposes session and agents state shape", async () => {
    const { provider, consumer } = createDelegationHarness({ maxAgents: 3 });

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties).toEqual({
        total_agents: 0,
        active_agents: 0,
        completed_agents: 0,
        failed_agents: 0,
        max_agents: 3,
      });
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual(["spawn_agent"]);
      expect(session.meta).toMatchObject({ focus: true, salience: 1 });

      const agents = await consumer.query("/agents", 2);
      expect(agents.type).toBe("collection");
      expect(agents.properties?.count).toBe(0);
      expect(agents.children ?? []).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("spawns an agent and exposes pending state", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "planner", "Plan the next milestone", "claude");

      const agents = await consumer.query("/agents", 2);
      expect(agents.properties?.count).toBe(1);
      expect(agents.children).toHaveLength(1);
      expect(agents.children?.[0]?.properties).toMatchObject({
        id: agentId,
        name: "planner",
        goal: "Plan the next milestone",
        status: "pending",
        model: "claude",
        completed_at: undefined,
        result_preview: undefined,
        error: undefined,
      });
      expect(agents.children?.[0]?.affordances?.map((affordance) => affordance.action)).toEqual([
        "cancel",
      ]);

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        total_agents: 1,
        active_agents: 1,
        completed_agents: 0,
        failed_agents: 0,
      });

      await consumer.invoke(`/agents/${agentId}`, "cancel", {});
    } finally {
      provider.stop();
    }
  });

  test("passes ACP executor binding through spawn state and runner factory", async () => {
    let capturedExecutor: unknown;
    const { provider, consumer } = createDelegationHarness({
      runnerFactory: (spawn, callbacks) => {
        capturedExecutor = spawn.executor;
        return {
          async start() {
            callbacks.onUpdate({ status: "running" });
          },
          async cancel() {
            callbacks.onUpdate({ status: "cancelled", completed_at: new Date().toISOString() });
          },
        };
      },
    });

    try {
      await connect(consumer);
      const result = await consumer.invoke("/session", "spawn_agent", {
        name: "acp-worker",
        goal: "Run through an external adapter",
        executor: { kind: "acp", adapterId: "fake" },
      });
      expect(result.status).toBe("ok");
      const data = result.data as { id: string; execution_mode: string };
      expect(data.execution_mode).toBe("acp:fake");
      expect(capturedExecutor).toEqual({ kind: "acp", adapterId: "fake" });

      const agent = await consumer.query(`/agents/${data.id}`, 2);
      expect(agent.properties).toMatchObject({
        id: data.id,
        execution_mode: "acp:fake",
        executor: { kind: "acp", adapterId: "fake" },
      });

      await consumer.invoke(`/agents/${data.id}`, "cancel", {});
    } finally {
      provider.stop();
    }
  });

  test("rejects malformed executor bindings", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const result = await consumer.invoke("/session", "spawn_agent", {
        name: "broken",
        goal: "Should not start",
        executor: { kind: "llm" },
      });
      expect(result.status).toBe("error");
    } finally {
      provider.stop();
    }
  });

  test("observes lifecycle changes through pushed state", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "runner", "Reach running state");

      const pendingResult = await consumer.query(`/agents/${agentId}`, 2);
      expect(pendingResult.properties).toMatchObject({
        id: agentId,
        name: "runner",
        status: "pending",
      });

      const running = await waitFor(async () => {
        const result = await consumer.query(`/agents/${agentId}`, 2);
        return result.properties?.status === "running" ? result.properties : null;
      }, 1500);
      expect(running).toMatchObject({
        id: agentId,
        goal: "Reach running state",
        status: "running",
      });

      await consumer.invoke(`/agents/${agentId}`, "cancel", {});
    } finally {
      provider.stop();
    }
  });

  test("cancels an active agent and updates session counts", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "cancel-me", "Stop before completion");

      const cancelResult = await consumer.invoke(`/agents/${agentId}`, "cancel", {});
      expect(cancelResult.status).toBe("ok");
      expect(cancelResult.data).toEqual({ cancelled: true });

      const cancelled = await consumer.query(`/agents/${agentId}`, 2);
      expect(cancelled.properties).toMatchObject({
        id: agentId,
        status: "cancelled",
      });
      expect(cancelled.properties?.completed_at).toBeString();
      expect(cancelled.affordances?.map((affordance) => affordance.action) ?? []).toEqual([]);

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        total_agents: 1,
        active_agents: 0,
        completed_agents: 0,
        failed_agents: 1,
      });
    } finally {
      provider.stop();
    }
  });

  test("does not expose result retrieval before completion", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "too-early", "Finish later");

      const result = await consumer.invoke(`/agents/${agentId}`, "get_result", {});
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain(`No handler for get_result at /agents/${agentId}`);

      await consumer.invoke(`/agents/${agentId}`, "cancel", {});
    } finally {
      provider.stop();
    }
  });

  test("retrieves the result after completion and exposes completed state", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "finisher", "Produce a final answer");

      const completed = await waitFor(async () => {
        const current = await consumer.query(`/agents/${agentId}`, 2);
        return current.properties?.status === "completed" ? current : null;
      }, 4500);
      expect(completed.properties).toMatchObject({
        id: agentId,
        name: "finisher",
        status: "completed",
        result_preview: 'Agent "finisher" completed goal: Produce a final answer',
      });
      expect(completed.properties?.completed_at).toBeString();
      expect(completed.affordances?.map((affordance) => affordance.action)).toEqual(["get_result"]);

      const result = await consumer.invoke(`/agents/${agentId}`, "get_result", {});
      expect(result.status).toBe("ok");
      expect(result.data).toEqual({
        id: agentId,
        result: 'Agent "finisher" completed goal: Produce a final answer',
      });

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        total_agents: 1,
        active_agents: 0,
        completed_agents: 1,
        failed_agents: 0,
      });
    } finally {
      provider.stop();
    }
  });

  test("deprecated task_id does not change completed agent result retrieval", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const result = await consumer.invoke("/session", "spawn_agent", {
        name: "task-worker",
        goal: "Produce a final answer",
        task_id: "task-1234abcd",
      });
      expect(result.status).toBe("ok");
      const agentId = (result.data as { id: string }).id;

      const completed = await waitFor(async () => {
        const current = await consumer.query(`/agents/${agentId}`, 2);
        return current.properties?.status === "completed" ? current : null;
      }, 4500);
      expect(completed.properties).toMatchObject({
        id: agentId,
        status: "completed",
        result_preview: 'Agent "task-worker" completed goal: Produce a final answer',
      });
      expect((completed.affordances ?? []).map((affordance) => affordance.action)).toContain(
        "get_result",
      );

      const retrieval = await consumer.invoke(`/agents/${agentId}`, "get_result", {});
      expect(retrieval.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("truncates long completed result previews without truncating retrieved results", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const longGoal = "Summarize ".concat("protocol details ".repeat(20));
      const agentId = await spawnAgent(consumer, "long-result", longGoal);

      const completed = await waitFor(async () => {
        const current = await consumer.query(`/agents/${agentId}`, 2);
        return current.properties?.status === "completed" ? current : null;
      }, 4500);
      const preview = completed.properties?.result_preview as string;
      expect(preview.length).toBeLessThan(`Agent "long-result" completed goal: ${longGoal}`.length);
      expect(preview).toEndWith("\n...[truncated]");

      const result = await consumer.invoke(`/agents/${agentId}`, "get_result", {});
      expect(result.status).toBe("ok");
      expect((result.data as { result: string }).result).toBe(
        `Agent "long-result" completed goal: ${longGoal}`,
      );
    } finally {
      provider.stop();
    }
  });

  test("enforces the configured maximum active agent count", async () => {
    const { provider, consumer } = createDelegationHarness({ maxAgents: 1 });

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "first", "Occupy the only slot");

      const secondResult = await consumer.invoke("/session", "spawn_agent", {
        name: "second",
        goal: "Should not start",
      });
      expect(secondResult.status).toBe("error");
      expect(secondResult.error?.message).toContain(
        "Agent limit reached (max 1 concurrent agents)",
      );

      const agents = await consumer.query("/agents", 2);
      expect(agents.children).toHaveLength(1);
      expect(agents.children?.[0]?.properties?.name).toBe("first");

      await consumer.invoke(`/agents/${agentId}`, "cancel", {});
    } finally {
      provider.stop();
    }
  });

  test("does not expose monitor as a polling affordance", async () => {
    const { provider, consumer } = createDelegationHarness();

    try {
      await connect(consumer);
      const agentId = await spawnAgent(consumer, "no-monitor", "Expose state only");

      const agent = await consumer.query(`/agents/${agentId}`, 2);
      expect(agent.affordances?.map((affordance) => affordance.action)).not.toContain("monitor");

      const result = await consumer.invoke(`/agents/${agentId}`, "monitor", {});
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain(`No handler for monitor at /agents/${agentId}`);

      await consumer.invoke(`/agents/${agentId}`, "cancel", {});
    } finally {
      provider.stop();
    }
  });
});

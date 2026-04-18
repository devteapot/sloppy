import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { MemoryProvider } from "../src/providers/builtin/memory";

function createMemoryHarness(options: ConstructorParameters<typeof MemoryProvider>[0] = {}) {
  const provider = new MemoryProvider({
    maxMemories: 20,
    defaultWeight: 0.5,
    compactThreshold: 0.3,
    ...options,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 4);
}

describe("MemoryProvider", () => {
  test("exposes session, memories, tags, and approvals state shape", async () => {
    const { provider, consumer } = createMemoryHarness();

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties?.total_count).toBe(0);
      expect(session.properties?.tag_count).toBe(0);
      expect(session.properties?.total_weight).toBe(0);
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "add_memory",
        "search",
        "forget_weak",
        "clear_all",
        "compact",
      ]);

      const memories = await consumer.query("/memories", 2);
      expect(memories.type).toBe("collection");
      expect(memories.properties?.count).toBe(0);
      expect(memories.children ?? []).toEqual([]);

      const tags = await consumer.query("/tags", 2);
      expect(tags.type).toBe("collection");
      expect(tags.properties?.count).toBe(0);

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.type).toBe("collection");
      expect(approvals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("adds memories, updates aggregate state, and searches by content and tag", async () => {
    const { provider, consumer } = createMemoryHarness();

    try {
      await connect(consumer);

      const addResult = await consumer.invoke("/session", "add_memory", {
        content: "Lucerne is the current city.",
        tags: ["profile", "location"],
        weight: 0.4,
      });
      expect(addResult.status).toBe("ok");
      expect((addResult.data as { id: string }).id).toStartWith("mem-");

      await consumer.invoke("/session", "add_memory", {
        content: "Use Bun for package scripts.",
        tags: ["workflow"],
        weight: 0.2,
      });

      const session = await consumer.query("/session", 2);
      expect(session.properties?.total_count).toBe(2);
      expect(session.properties?.tag_count).toBe(3);
      expect(session.properties?.total_weight).toBe(0.6);

      const searchResult = await consumer.invoke("/session", "search", {
        query: "Lucerne city",
        tags: ["profile"],
        limit: 5,
      });
      expect(searchResult.status).toBe("ok");
      const matches = searchResult.data as Array<{ content: string; tags: string[]; score: number }>;
      expect(matches).toHaveLength(1);
      expect(matches[0]?.content).toContain("Lucerne");
      expect(matches[0]?.tags).toContain("location");
      expect(matches[0]?.score).toBe(1);

      const tags = await consumer.query("/tags", 2);
      expect(tags.children?.map((child) => child.id).sort()).toEqual([
        "location",
        "profile",
        "workflow",
      ]);
    } finally {
      provider.stop();
    }
  });

  test("exposes low-weight memories with update and delete actions", async () => {
    const { provider, consumer } = createMemoryHarness({ compactThreshold: 0.5 });

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "Draft memory",
        tags: ["draft"],
        weight: 0.1,
      });

      const memories = await consumer.query("/memories", 2);
      expect(memories.children).toHaveLength(1);
      const memory = memories.children?.[0];
      expect(memory?.properties?.content_preview).toBe("Draft memory");
      expect(memory?.properties?.tags).toEqual(["draft"]);
      expect(memory?.affordances?.map((affordance) => affordance.action)).toEqual([
        "update_memory",
        "delete_memory",
      ]);
      expect(memory?.affordances?.find((affordance) => affordance.action === "delete_memory")?.dangerous).toBe(
        true,
      );
    } finally {
      provider.stop();
    }
  });

  test("updates memory content, tags, and weight", async () => {
    const { provider, consumer } = createMemoryHarness({ compactThreshold: 0.5 });

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "Old memory",
        tags: ["old"],
        weight: 0.1,
      });
      const initialMemories = await consumer.query("/memories", 2);
      const memoryId = initialMemories.children?.[0]?.id;
      expect(typeof memoryId).toBe("string");

      const updateResult = await consumer.invoke(`/memories/${memoryId}`, "update_memory", {
        content: "New memory",
        tags: ["new", "edited"],
        weight: 0.2,
      });
      expect(updateResult.status).toBe("ok");

      const updated = await consumer.query(`/memories/${memoryId}`, 2);
      expect(updated.properties?.content_preview).toBe("New memory");
      expect(updated.properties?.tags).toEqual(["new", "edited"]);
      expect(updated.properties?.weight).toBe(0.2);

      const searchResult = await consumer.invoke("/session", "search", {
        query: "New",
        tags: ["edited"],
        limit: 5,
      });
      expect(searchResult.status).toBe("ok");
      expect((searchResult.data as Array<{ id: string }>)[0]?.id).toBe(memoryId);
    } finally {
      provider.stop();
    }
  });

  test("deletes a memory item and refreshes session counts", async () => {
    const { provider, consumer } = createMemoryHarness({ compactThreshold: 0.5 });

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "Temporary memory",
        tags: ["tmp"],
        weight: 0.1,
      });
      const memories = await consumer.query("/memories", 2);
      const memoryId = memories.children?.[0]?.id;
      expect(typeof memoryId).toBe("string");

      const deleteResult = await consumer.invoke(`/memories/${memoryId}`, "delete_memory", {});
      expect(deleteResult.status).toBe("ok");
      expect(deleteResult.data).toEqual({ deleted: true });

      const updatedMemories = await consumer.query("/memories", 2);
      expect(updatedMemories.children ?? []).toEqual([]);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.total_count).toBe(0);
      expect(session.properties?.tag_count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("compacts similar low-weight memories", async () => {
    const { provider, consumer } = createMemoryHarness({ compactThreshold: 0.5 });

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "First project note",
        tags: ["project", "alpha"],
        weight: 0.2,
      });
      await consumer.invoke("/session", "add_memory", {
        content: "Second project note",
        tags: ["project", "beta"],
        weight: 0.2,
      });
      await consumer.invoke("/session", "add_memory", {
        content: "Unrelated strong note",
        tags: ["stable"],
        weight: 0.9,
      });

      const compactResult = await consumer.invoke("/session", "compact", {});
      expect(compactResult.status).toBe("ok");
      expect(compactResult.data).toEqual({ merged_count: 1 });

      const searchResult = await consumer.invoke("/session", "search", {
        query: "project",
        tags: ["project"],
        limit: 10,
      });
      expect(searchResult.status).toBe("ok");
      const matches = searchResult.data as Array<{ content: string; tags: string[] }>;
      expect(matches).toHaveLength(1);
      expect(matches[0]?.content).toContain("First project note");
      expect(matches[0]?.content).toContain("Second project note");
      expect(matches[0]?.tags.sort()).toEqual(["alpha", "beta", "project"]);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.total_count).toBe(2);
    } finally {
      provider.stop();
    }
  });

  test("forgets memories below the requested threshold", async () => {
    const { provider, consumer } = createMemoryHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "Weak note",
        tags: ["cleanup"],
        weight: 0.1,
      });
      await consumer.invoke("/session", "add_memory", {
        content: "Strong note",
        tags: ["keep"],
        weight: 0.8,
      });

      const forgetResult = await consumer.invoke("/session", "forget_weak", {
        threshold: 0.5,
      });
      expect(forgetResult.status).toBe("ok");
      expect(forgetResult.data).toEqual({ removed_count: 1 });

      const searchResult = await consumer.invoke("/session", "search", {
        query: "",
        tags: [],
        limit: 10,
      });
      expect(searchResult.status).toBe("ok");
      expect((searchResult.data as Array<{ content: string }>).map((memory) => memory.content)).toEqual([
        "Strong note",
      ]);
    } finally {
      provider.stop();
    }
  });

  test("approval-gates clear_all and executes only after approval", async () => {
    const { provider, consumer } = createMemoryHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "Keep until approval",
        tags: ["approval"],
        weight: 0.4,
      });

      const clearResult = await consumer.invoke("/session", "clear_all", {
        confirmed: false,
      });
      expect(clearResult.status).toBe("error");
      expect(clearResult.error?.code).toBe("approval_required");

      const unchangedSession = await consumer.query("/session", 2);
      expect(unchangedSession.properties?.total_count).toBe(1);

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.children).toHaveLength(1);
      expect(approvals.children?.[0]?.properties?.status).toBe("pending");
      expect(approvals.children?.[0]?.properties?.action).toBe("clear_all");
      expect(approvals.children?.[0]?.properties?.dangerous).toBe(true);

      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");
      expect(approveResult.data).toEqual({ cleared_count: 1 });

      const updatedSession = await consumer.query("/session", 2);
      expect(updatedSession.properties?.total_count).toBe(0);

      const updatedApprovals = await consumer.query("/approvals", 2);
      expect(updatedApprovals.children?.[0]?.properties?.status).toBe("approved");
    } finally {
      provider.stop();
    }
  });

  test("rejecting clear_all leaves memories intact", async () => {
    const { provider, consumer } = createMemoryHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "add_memory", {
        content: "Do not clear",
        tags: ["approval"],
        weight: 0.4,
      });
      await consumer.invoke("/session", "clear_all", {
        confirmed: false,
      });

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const rejectResult = await consumer.invoke(`/approvals/${approvalId}`, "reject", {
        reason: "preserve memory",
      });
      expect(rejectResult.status).toBe("ok");

      const updatedSession = await consumer.query("/session", 2);
      expect(updatedSession.properties?.total_count).toBe(1);

      const updatedApprovals = await consumer.query("/approvals", 2);
      expect(updatedApprovals.children?.[0]?.properties?.status).toBe("rejected");
      expect(updatedApprovals.children?.[0]?.properties?.resolution_reason).toBe("preserve memory");
    } finally {
      provider.stop();
    }
  });
});

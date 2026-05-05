import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { MessagingProvider } from "../src/providers/builtin/messaging";

function createMessagingHarness(options: ConstructorParameters<typeof MessagingProvider>[0] = {}) {
  const provider = new MessagingProvider({
    maxMessages: 20,
    ...options,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

async function addChannel(
  consumer: SlopConsumer,
  name = "General",
  transport_type = "local",
): Promise<string> {
  const result = await consumer.invoke("/session", "add_channel", { name, transport_type });
  expect(result.status).toBe("ok");

  const data = result.data as { id: string; name: string; transport: string };
  expect(typeof data.id).toBe("string");
  expect(data.name).toBe(name);
  expect(data.transport).toBe(transport_type);

  return data.id;
}

describe("MessagingProvider", () => {
  test("exposes session, channels, and approvals state shape", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties).toEqual({
        channels_count: 0,
        total_messages: 0,
        unread_count: 0,
      });
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "list_channels",
        "add_channel",
        "remove_channel",
      ]);
      expect(session.meta?.focus).toBe(false);
      expect(session.meta?.salience).toBe(0.5);

      const channels = await consumer.query("/channels", 2);
      expect(channels.type).toBe("collection");
      expect(channels.properties?.count).toBe(0);
      expect(channels.children ?? []).toEqual([]);

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.type).toBe("collection");
      expect(approvals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("creates a channel and lists it from session", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);

      const channelId = await addChannel(consumer, "Ops", "slack");

      const channels = await consumer.query("/channels", 2);
      expect(channels.properties?.count).toBe(1);
      expect(channels.children).toHaveLength(1);
      expect(channels.children?.[0]?.properties).toMatchObject({
        id: channelId,
        name: "Ops",
        transport: "slack",
        message_count: 0,
        unread_count: 0,
        last_message_preview: null,
      });
      expect(channels.children?.[0]?.affordances?.map((affordance) => affordance.action)).toEqual([
        "send",
        "view_history",
      ]);

      const listResult = await consumer.invoke("/session", "list_channels", {});
      expect(listResult.status).toBe("ok");
      expect(listResult.data).toEqual([
        {
          id: channelId,
          name: "Ops",
          transport: "slack",
          messages: [],
          unread_count: 0,
        },
      ]);
    } finally {
      provider.stop();
    }
  });

  test("sends a message and exposes the latest channel state", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);
      const channelId = await addChannel(consumer);

      const sendResult = await consumer.invoke(`/channels/${channelId}`, "send", {
        message: "hello world",
      });
      expect(sendResult.status).toBe("ok");
      const sent = sendResult.data as { id: string; channel_id: string; sent_at: string };
      expect(typeof sent.id).toBe("string");
      expect(sent.channel_id).toBe(channelId);
      expect(new Date(sent.sent_at).toString()).not.toBe("Invalid Date");

      const channel = await consumer.query(`/channels/${channelId}`, 2);
      expect(channel.properties).toMatchObject({
        id: channelId,
        message_count: 1,
        unread_count: 0,
        last_message_preview: "You: hello world",
      });

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        channels_count: 1,
        total_messages: 1,
        unread_count: 0,
      });
    } finally {
      provider.stop();
    }
  });

  test("returns message history with outbound message details", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);
      const channelId = await addChannel(consumer);

      await consumer.invoke(`/channels/${channelId}`, "send", { message: "first" });
      await consumer.invoke(`/channels/${channelId}`, "send", { message: "second" });

      const historyResult = await consumer.invoke(`/channels/${channelId}`, "view_history", {});
      expect(historyResult.status).toBe("ok");
      const history = historyResult.data as Array<{
        channel_id: string;
        content: string;
        direction: string;
        sender: string;
      }>;
      expect(history.map((message) => message.content)).toEqual(["first", "second"]);
      expect(history.every((message) => message.channel_id === channelId)).toBe(true);
      expect(history.every((message) => message.direction === "outbound")).toBe(true);
      expect(history.every((message) => message.sender === "agent")).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("stores typed route envelopes with outbound messages", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);
      const channelId = await addChannel(consumer);

      const sendResult = await consumer.invoke(`/channels/${channelId}`, "send", {
        message: "fallback body",
        envelope: {
          id: "msg-typed",
          source: "root",
          body: "typed envelope body",
          topic: "audit",
          metadata: { severity: "high" },
        },
      });
      expect(sendResult.status).toBe("ok");
      expect((sendResult.data as { envelope_id?: string }).envelope_id).toBe("msg-typed");

      const historyResult = await consumer.invoke(`/channels/${channelId}`, "view_history", {});
      expect(historyResult.status).toBe("ok");
      const history = historyResult.data as Array<{
        content: string;
        envelope?: {
          id: string;
          source: string;
          body: string;
          topic?: string;
          metadata?: Record<string, unknown>;
        };
      }>;
      expect(history[0]?.content).toBe("typed envelope body");
      expect(history[0]?.envelope).toEqual({
        id: "msg-typed",
        source: "root",
        body: "typed envelope body",
        topic: "audit",
        metadata: { severity: "high" },
      });
    } finally {
      provider.stop();
    }
  });

  test("limits history results to the requested recent messages", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);
      const channelId = await addChannel(consumer);

      await consumer.invoke(`/channels/${channelId}`, "send", { message: "one" });
      await consumer.invoke(`/channels/${channelId}`, "send", { message: "two" });
      await consumer.invoke(`/channels/${channelId}`, "send", { message: "three" });

      const historyResult = await consumer.invoke(`/channels/${channelId}`, "view_history", {
        limit: 2,
      });
      expect(historyResult.status).toBe("ok");
      const history = historyResult.data as Array<{ content: string }>;
      expect(history.map((message) => message.content)).toEqual(["two", "three"]);
    } finally {
      provider.stop();
    }
  });

  test("trims stored messages to the configured maximum", async () => {
    const { provider, consumer } = createMessagingHarness({ maxMessages: 2 });

    try {
      await connect(consumer);
      const channelId = await addChannel(consumer);

      await consumer.invoke(`/channels/${channelId}`, "send", { message: "oldest" });
      await consumer.invoke(`/channels/${channelId}`, "send", { message: "middle" });
      await consumer.invoke(`/channels/${channelId}`, "send", { message: "newest" });

      const channel = await consumer.query(`/channels/${channelId}`, 2);
      expect(channel.properties?.message_count).toBe(2);
      expect(channel.properties?.last_message_preview).toBe("You: newest");

      const historyResult = await consumer.invoke(`/channels/${channelId}`, "view_history", {});
      expect(historyResult.status).toBe("ok");
      const history = historyResult.data as Array<{ content: string }>;
      expect(history.map((message) => message.content)).toEqual(["middle", "newest"]);
    } finally {
      provider.stop();
    }
  });

  test("removes a channel and clears its state", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);
      const channelId = await addChannel(consumer, "Delete Me");
      await consumer.invoke(`/channels/${channelId}`, "send", { message: "temporary" });

      const removeResult = await consumer.invoke("/session", "remove_channel", {
        channel_id: channelId,
      });
      expect(removeResult.status).toBe("ok");
      expect(removeResult.data).toEqual({ removed: true });

      const channels = await consumer.query("/channels", 2);
      expect(channels.properties?.count).toBe(0);
      expect(channels.children ?? []).toEqual([]);

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        channels_count: 0,
        total_messages: 0,
      });
    } finally {
      provider.stop();
    }
  });

  test("returns clear errors for unknown channels", async () => {
    const { provider, consumer } = createMessagingHarness();

    try {
      await connect(consumer);

      const sendResult = await consumer.invoke("/channels/missing", "send", {
        message: "lost",
      });
      expect(sendResult.status).toBe("error");

      const removeResult = await consumer.invoke("/session", "remove_channel", {
        channel_id: "missing",
      });
      expect(removeResult.status).toBe("error");
      expect(removeResult.error?.message).toContain("Unknown channel: missing");
    } finally {
      provider.stop();
    }
  });
});

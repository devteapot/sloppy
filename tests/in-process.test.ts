import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { createSlopServer } from "@slop-ai/server";

import { InProcessTransport } from "../src/providers/builtin/in-process";

describe("InProcessTransport", () => {
  test("buffers the hello message until the consumer attaches handlers", async () => {
    const server = createSlopServer({ id: "demo", name: "Demo" });
    server.register("status", {
      type: "status",
      props: { ready: true },
    });

    const consumer = new SlopConsumer(new InProcessTransport(server));
    const hello = await consumer.connect();

    expect(hello.provider.id).toBe("demo");

    const subscription = await consumer.subscribe("/", 1);
    expect(subscription.snapshot.children?.[0]?.id).toBe("status");
  });
});

import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { ImagesProvider } from "../src/plugins/first-party/images/provider";
import { InProcessTransport } from "../src/providers/in-process";

const OPTIONS = { maxLoaded: 2, defaultTtlTurns: 3, maxStored: 4 };

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x42),
]);

function createHarness() {
  const provider = new ImagesProvider(OPTIONS);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  return { provider, consumer };
}

function registerFrame(provider: ImagesProvider) {
  return provider.registry.register({
    bytes: JPEG_BYTES,
    mediaType: "image/jpeg",
    summary: "camera frame",
    source: "tool:reachy:/camera",
    width: 800,
    height: 450,
  });
}

describe("ImagesProvider", () => {
  test("exposes registry metadata without any image bytes", async () => {
    const { provider, consumer } = createHarness();
    const image = registerFrame(provider);

    try {
      await consumer.connect();
      await consumer.subscribe("/", 2);

      const collection = await consumer.query("/gallery", 2);
      expect(collection.type).toBe("collection");
      expect(collection.properties).toEqual({
        count: 1,
        loaded_count: 1,
        max_loaded: 2,
        default_ttl_turns: 3,
        estimated_loaded_tokens: 480,
      });

      const node = await consumer.query(`/gallery/${image.id}`, 2);
      expect(node.properties).toEqual({
        loaded: true,
        pinned: false,
        media_type: "image/jpeg",
        bytes: JPEG_BYTES.length,
        dims: "800x450",
        source: "tool:reachy:/camera",
        ttl_turns_remaining: 3,
      });
      expect(node.affordances?.map((affordance) => affordance.action).sort()).toEqual([
        "describe",
        "pin",
        "remove",
        "unload",
      ]);

      // No descriptor value may smuggle base64 image data into the text trail.
      const serialized = JSON.stringify(node);
      expect(serialized).not.toContain(JPEG_BYTES.toString("base64").slice(0, 24));
      expect(serialized.length).toBeLessThan(2000);
    } finally {
      consumer.disconnect();
      provider.stop();
    }
  });

  test("lifecycle affordances round-trip and refresh the tree", async () => {
    const { provider, consumer } = createHarness();
    const image = registerFrame(provider);

    try {
      await consumer.connect();
      await consumer.subscribe("/", 2);

      const unload = await consumer.invoke(`/gallery/${image.id}`, "unload", {});
      expect(unload.status).toBe("ok");
      expect(unload.data).toMatchObject({ path: image.path, loaded: false });

      let node = await consumer.query(`/gallery/${image.id}`, 2);
      expect(node.properties?.loaded).toBe(false);
      expect(node.affordances?.map((affordance) => affordance.action)).toContain("load");

      const load = await consumer.invoke(`/gallery/${image.id}`, "load", { ttl_turns: 5 });
      expect(load.status).toBe("ok");
      expect(load.data).toMatchObject({ loaded: true, ttl_turns_remaining: 5 });

      const pin = await consumer.invoke(`/gallery/${image.id}`, "pin", {});
      expect(pin.status).toBe("ok");
      expect(pin.data).toMatchObject({ pinned: true });
      node = await consumer.query(`/gallery/${image.id}`, 2);
      expect(node.properties?.ttl_turns_remaining).toBeUndefined();

      const unpin = await consumer.invoke(`/gallery/${image.id}`, "unpin", {});
      expect(unpin.status).toBe("ok");
      expect(unpin.data).toMatchObject({ pinned: false, ttl_turns_remaining: 3 });

      const describe = await consumer.invoke(`/gallery/${image.id}`, "describe", {
        description: "desk with a red mug, seen from above",
      });
      expect(describe.status).toBe("ok");
      expect(describe.data).toMatchObject({
        description: "desk with a red mug, seen from above",
      });
      node = await consumer.query(`/gallery/${image.id}`, 2);
      expect(node.properties?.description).toBe("desk with a red mug, seen from above");

      const badDescribe = await consumer.invoke(`/gallery/${image.id}`, "describe", {
        description: "x".repeat(201),
      });
      expect(badDescribe.status).toBe("error");
      expect(badDescribe.error?.message).toContain("too long");

      const remove = await consumer.invoke(`/gallery/${image.id}`, "remove", {});
      expect(remove.status).toBe("ok");
      expect(remove.data).toEqual({ id: image.id, removed: true });

      const collection = await consumer.query("/gallery", 2);
      expect(collection.properties?.count).toBe(0);
    } finally {
      consumer.disconnect();
      provider.stop();
    }
  });

  test("load conflicts surface as action errors", async () => {
    const { provider, consumer } = createHarness();
    const first = registerFrame(provider);
    const second = registerFrame(provider);
    const third = registerFrame(provider); // maxLoaded 2 → first unloaded
    provider.registry.pin(second.id);
    provider.registry.pin(third.id);

    try {
      await consumer.connect();
      const result = await consumer.invoke(`/gallery/${first.id}`, "load", {});
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("pinned");
    } finally {
      consumer.disconnect();
      provider.stop();
    }
  });
});

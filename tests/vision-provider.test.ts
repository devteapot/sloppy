import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { VisionProvider } from "../src/providers/builtin/vision";

function createHarness(options: ConstructorParameters<typeof VisionProvider>[0] = {}) {
  const provider = new VisionProvider(options);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
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

describe("VisionProvider", () => {
  test("exposes session, images, analyses, and approvals state shape", async () => {
    const { provider, consumer } = createHarness({ defaultWidth: 640, defaultHeight: 480 });

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties).toEqual({
        images_generated: 0,
        analyses_done: 0,
        cache_size: 0,
        default_dimensions: "640x480",
      });
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "generate_image",
        "analyze_image",
      ]);
      expect(session.meta?.focus).toBe(true);
      expect(session.meta?.salience).toBe(1);

      const images = await consumer.query("/images", 2);
      expect(images.type).toBe("collection");
      expect(images.properties?.count).toBe(0);
      expect(images.children ?? []).toEqual([]);

      const analyses = await consumer.query("/analyses", 2);
      expect(analyses.type).toBe("collection");
      expect(analyses.properties?.count).toBe(0);
      expect(analyses.children ?? []).toEqual([]);

      const approvals = await consumer.query("/approvals", 2);
      expect(approvals.type).toBe("collection");
      expect(approvals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("starts image generation and exposes pending image state", async () => {
    const { provider, consumer } = createHarness({ defaultWidth: 320, defaultHeight: 240 });

    try {
      await connect(consumer);

      const result = await consumer.invoke("/session", "generate_image", {
        prompt: "A diagram of SLOP provider state",
      });
      expect(result.status).toBe("ok");

      const data = result.data as { id: string; status: string; created_at: string };
      expect(typeof data.id).toBe("string");
      expect(data.status).toBe("generating");
      expect(typeof data.created_at).toBe("string");

      const images = await consumer.query("/images", 2);
      expect(images.properties?.count).toBe(1);
      expect(images.children?.[0]?.id).toBe(data.id);
      expect(images.children?.[0]?.properties).toMatchObject({
        id: data.id,
        prompt: "A diagram of SLOP provider state",
        width: 320,
        height: 240,
        status: "generating",
      });

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        images_generated: 0,
        cache_size: 1,
      });
    } finally {
      provider.stop();
    }
  });

  test("uses explicit image generation dimensions", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const result = await consumer.invoke("/session", "generate_image", {
        prompt: "Wide protocol storyboard",
        width: 1024,
        height: 512,
      });
      expect(result.status).toBe("ok");

      const images = await consumer.query("/images", 2);
      expect(images.children?.[0]?.properties).toMatchObject({
        prompt: "Wide protocol storyboard",
        width: 1024,
        height: 512,
        status: "generating",
      });
    } finally {
      provider.stop();
    }
  });

  test("exposes ready generated images with download affordances", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const result = await consumer.invoke("/session", "generate_image", {
        prompt: "Generated runtime screenshot",
      });
      expect(result.status).toBe("ok");
      const imageId = (result.data as { id: string }).id;

      const readyImage = await waitFor(async () => {
        const images = await consumer.query("/images", 2);
        const image = images.children?.find((child) => child.id === imageId);
        return image?.properties?.status === "ready" ? image : null;
      });

      expect(readyImage.properties).toMatchObject({
        id: imageId,
        prompt: "Generated runtime screenshot",
        status: "ready",
      });
      expect(typeof readyImage.properties?.preview).toBe("string");
      expect((readyImage.properties?.url as string | undefined) ?? "").toContain(
        "placeholder.invalid/generated/",
      );
      expect(readyImage.affordances?.map((affordance) => affordance.action)).toEqual([
        "download",
        "delete",
      ]);

      const downloadResult = await consumer.invoke(`/images/${imageId}`, "download", {});
      expect(downloadResult.status).toBe("ok");
      expect(downloadResult.data).toMatchObject({
        id: imageId,
        url: `https://placeholder.invalid/generated/${imageId}.png`,
        prompt: "Generated runtime screenshot",
        width: 512,
        height: 512,
      });

      const session = await consumer.query("/session", 2);
      expect(session.properties?.images_generated).toBe(1);
    } finally {
      provider.stop();
    }
  });

  test("starts image analysis and exposes pending analysis state", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const result = await consumer.invoke("/session", "analyze_image", {
        source: "data:image/png;base64,ZmFrZQ==",
      });
      expect(result.status).toBe("ok");

      const data = result.data as { id: string; status: string; created_at: string };
      expect(typeof data.id).toBe("string");
      expect(data.status).toBe("analyzing");
      expect(typeof data.created_at).toBe("string");

      const analyses = await consumer.query("/analyses", 2);
      expect(analyses.properties?.count).toBe(1);
      expect(analyses.children?.[0]?.id).toBe(data.id);
      expect(analyses.children?.[0]?.properties).toMatchObject({
        id: data.id,
        source: "data:image/png;base64,ZmFrZQ==",
        status: "analyzing",
        result_preview: undefined,
      });
    } finally {
      provider.stop();
    }
  });

  test("exposes ready image analyses and cached results", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const result = await consumer.invoke("/session", "analyze_image", {
        source: "/tmp/fake-image.png",
      });
      expect(result.status).toBe("ok");
      const analysisId = (result.data as { id: string }).id;

      const readyAnalysis = await waitFor(async () => {
        const analyses = await consumer.query("/analyses", 2);
        const analysis = analyses.children?.find((child) => child.id === analysisId);
        return analysis?.properties?.status === "ready" ? analysis : null;
      });

      expect(readyAnalysis.properties).toMatchObject({
        id: analysisId,
        source: "/tmp/fake-image.png",
        status: "ready",
      });
      expect((readyAnalysis.properties?.result_preview as string | undefined) ?? "").toContain(
        "Simulated analysis",
      );
      expect(readyAnalysis.affordances?.map((affordance) => affordance.action)).toEqual([
        "view_result",
      ]);

      const viewResult = await consumer.invoke(`/analyses/${analysisId}`, "view_result", {});
      expect(viewResult.status).toBe("ok");
      expect(viewResult.data).toMatchObject({
        id: analysisId,
        source: "/tmp/fake-image.png",
      });
      expect((viewResult.data as { result: string }).result).toContain("Objects detected");

      const session = await consumer.query("/session", 2);
      expect(session.properties?.analyses_done).toBe(1);
    } finally {
      provider.stop();
    }
  });

  test("deletes generated images from the cache", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const result = await consumer.invoke("/session", "generate_image", {
        prompt: "Temporary cached image",
      });
      expect(result.status).toBe("ok");
      const imageId = (result.data as { id: string }).id;

      const deleteResult = await consumer.invoke(`/images/${imageId}`, "delete", {});
      expect(deleteResult.status).toBe("ok");
      expect(deleteResult.data).toEqual({ id: imageId, deleted: true });

      const images = await consumer.query("/images", 2);
      expect(images.properties?.count).toBe(0);
      expect(images.children ?? []).toEqual([]);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.cache_size).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("evicts oldest cached images when maxImages is exceeded", async () => {
    const { provider, consumer } = createHarness({ maxImages: 2 });

    try {
      await connect(consumer);

      const first = await consumer.invoke("/session", "generate_image", { prompt: "first" });
      const second = await consumer.invoke("/session", "generate_image", { prompt: "second" });
      const third = await consumer.invoke("/session", "generate_image", { prompt: "third" });
      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      expect(third.status).toBe("ok");

      const firstId = (first.data as { id: string }).id;
      const secondId = (second.data as { id: string }).id;
      const thirdId = (third.data as { id: string }).id;

      const images = await consumer.query("/images", 2);
      expect(images.properties?.count).toBe(2);
      expect(images.children?.map((child) => child.id)).toEqual([secondId, thirdId]);
      expect(images.children?.some((child) => child.id === firstId)).toBe(false);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.cache_size).toBe(2);
    } finally {
      provider.stop();
    }
  });
});

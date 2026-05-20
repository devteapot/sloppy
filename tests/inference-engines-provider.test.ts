import { afterEach, describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { InferenceEnginesProvider } from "../src/plugins/first-party/inference-engines/provider";
import { InProcessTransport } from "../src/providers/in-process";

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0).reverse()) {
    stop();
  }
});

describe("InferenceEnginesProvider", () => {
  test("projects configured engine profiles as state", async () => {
    const provider = new InferenceEnginesProvider({
      profiles: [
        {
          id: "ds4-local",
          kind: "engine",
          engine: "ds4",
          model: "deepseek-v4-flash",
          dialect: "dsml",
          transport: {
            type: "unix",
            path: "/tmp/ds4-engine.sock",
          },
        },
      ],
    });
    stops.push(() => provider.stop());
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    stops.push(() => consumer.disconnect());

    await consumer.connect();
    const engines = await consumer.query("/engines", 2);

    expect(engines.properties?.count).toBe(1);
    expect(engines.children?.[0]?.id).toBe("ds4-local");
    expect(engines.children?.[0]?.properties).toMatchObject({
      engine: "ds4",
      model: "deepseek-v4-flash",
      dialect: "dsml",
      transport: "unix:/tmp/ds4-engine.sock",
      status: "configured",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { BrowserProvider } from "../src/providers/builtin/browser";
import { InProcessTransport } from "../src/providers/builtin/in-process";

function createHarness(options: ConstructorParameters<typeof BrowserProvider>[0] = {}) {
  const provider = new BrowserProvider(options);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

async function navigate(
  consumer: SlopConsumer,
  url: string,
  new_tab = false,
): Promise<{ url: string; title: string; status: number }> {
  const result = await consumer.invoke("/session", "navigate", { url, new_tab });
  expect(result.status).toBe("ok");

  return result.data as { url: string; title: string; status: number };
}

describe("BrowserProvider", () => {
  test("exposes session, tabs, and history state shape", async () => {
    const { provider, consumer } = createHarness({ viewportWidth: 1024, viewportHeight: 768 });

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties).toEqual({
        open_tabs: 0,
        active_tab: null,
        navigation_count: 0,
        screenshot_count: 0,
        viewport: { width: 1024, height: 768 },
      });
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "navigate",
        "close_tab",
      ]);
      expect(session.meta?.focus).toBe(true);
      expect(session.meta?.salience).toBe(1);

      const tabs = await consumer.query("/tabs", 2);
      expect(tabs.type).toBe("collection");
      expect(tabs.properties?.count).toBe(0);
      expect(tabs.children ?? []).toEqual([]);

      const history = await consumer.query("/history", 2);
      expect(history.type).toBe("collection");
      expect(history.properties).toMatchObject({ count: 0, current_step: -1 });
      expect(history.affordances?.map((affordance) => affordance.action)).toEqual([
        "go_back",
        "go_forward",
        "go_to",
      ]);
    } finally {
      provider.stop();
    }
  });

  test("navigates the active tab and records history", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const result = await navigate(consumer, "https://example.com/docs");
      expect(result).toEqual({
        url: "https://example.com/docs",
        title: "example.com",
        status: 200,
      });

      const tabs = await consumer.query("/tabs", 2);
      expect(tabs.properties?.count).toBe(1);
      expect(tabs.children?.[0]?.properties).toMatchObject({
        index: 0,
        url: "https://example.com/docs",
        title: "example.com",
        active: true,
      });

      const history = await consumer.query("/history", 2);
      expect(history.properties).toMatchObject({ count: 1, current_step: 0 });
      expect(history.children?.[0]?.properties).toMatchObject({
        step: 0,
        url: "https://example.com/docs",
        action_type: "navigate",
        method: "GET",
      });
    } finally {
      provider.stop();
    }
  });

  test("opens new tabs and marks the latest tab active", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);
      await navigate(consumer, "https://example.com");
      await navigate(consumer, "https://slop.ai", true);

      const tabs = await consumer.query("/tabs", 2);
      expect(tabs.children?.map((child) => child.properties)).toMatchObject([
        {
          index: 0,
          url: "https://example.com",
          title: "example.com",
          active: false,
        },
        {
          index: 1,
          url: "https://slop.ai",
          title: "slop.ai",
          active: true,
        },
      ]);

      const session = await consumer.query("/session", 2);
      expect(session.properties).toMatchObject({
        open_tabs: 2,
        active_tab: 1,
        navigation_count: 2,
      });
    } finally {
      provider.stop();
    }
  });

  test("switches tabs through tab item affordances", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);
      await navigate(consumer, "https://example.com");
      await navigate(consumer, "https://slop.ai", true);

      const tabs = await consumer.query("/tabs", 2);
      const firstTabId = tabs.children?.find((child) => child.properties?.index === 0)?.id;
      expect(typeof firstTabId).toBe("string");

      const switchResult = await consumer.invoke(`/tabs/${firstTabId}`, "switch_tab", {});
      expect(switchResult.status).toBe("ok");
      expect(switchResult.data).toEqual({
        tab_index: 0,
        url: "https://example.com",
        title: "example.com",
      });

      const updatedTabs = await consumer.query("/tabs", 2);
      expect(updatedTabs.children?.map((child) => child.properties?.active)).toEqual([true, false]);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.active_tab).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("takes screenshots for a tab and updates session count", async () => {
    const { provider, consumer } = createHarness({ viewportWidth: 1440, viewportHeight: 900 });

    try {
      await connect(consumer);
      await navigate(consumer, "https://example.com");

      const tabs = await consumer.query("/tabs", 2);
      const tabId = tabs.children?.[0]?.id;
      expect(typeof tabId).toBe("string");

      const screenshotResult = await consumer.invoke(`/tabs/${tabId}`, "take_screenshot", {});
      expect(screenshotResult.status).toBe("ok");
      expect(screenshotResult.data).toMatchObject({
        tab_index: 0,
        url: "https://example.com",
        width: 1440,
        height: 900,
        format: "png",
        data: "<simulated-screenshot:https://example.com>",
      });
      expect(typeof (screenshotResult.data as { captured_at: string }).captured_at).toBe("string");

      const session = await consumer.query("/session", 2);
      expect(session.properties?.screenshot_count).toBe(1);
    } finally {
      provider.stop();
    }
  });

  test("closes the active tab and reindexes remaining tabs", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);
      await navigate(consumer, "https://example.com");
      await navigate(consumer, "https://slop.ai", true);

      const closeResult = await consumer.invoke("/session", "close_tab", {});
      expect(closeResult.status).toBe("ok");
      expect(closeResult.data).toEqual({ closed: true });

      const tabs = await consumer.query("/tabs", 2);
      expect(tabs.properties?.count).toBe(1);
      expect(tabs.children?.[0]?.properties).toMatchObject({
        index: 0,
        url: "https://example.com",
        active: true,
      });
    } finally {
      provider.stop();
    }
  });

  test("traverses history backward and forward", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);
      await navigate(consumer, "https://example.com/one");
      await navigate(consumer, "https://example.com/two");

      const backResult = await consumer.invoke("/history", "go_back", {});
      expect(backResult.status).toBe("ok");
      expect(backResult.data).toEqual({ url: "https://example.com/one", step: 0 });

      let tabs = await consumer.query("/tabs", 2);
      expect(tabs.children?.[0]?.properties?.url).toBe("https://example.com/one");

      const forwardResult = await consumer.invoke("/history", "go_forward", {});
      expect(forwardResult.status).toBe("ok");
      expect(forwardResult.data).toEqual({ url: "https://example.com/two", step: 1 });

      tabs = await consumer.query("/tabs", 2);
      expect(tabs.children?.[0]?.properties?.url).toBe("https://example.com/two");

      const history = await consumer.query("/history", 2);
      expect(history.properties?.current_step).toBe(1);
    } finally {
      provider.stop();
    }
  });

  test("jumps to a specific history step", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);
      await navigate(consumer, "https://example.com/one");
      await navigate(consumer, "https://example.com/two");
      await navigate(consumer, "https://example.com/three");

      const jumpResult = await consumer.invoke("/history", "go_to", { step: 1 });
      expect(jumpResult.status).toBe("ok");
      expect(jumpResult.data).toEqual({ url: "https://example.com/two", step: 1 });

      const tabs = await consumer.query("/tabs", 2);
      expect(tabs.children?.[0]?.properties).toMatchObject({
        url: "https://example.com/two",
        title: "example.com",
      });

      const history = await consumer.query("/history", 2);
      expect(history.properties?.current_step).toBe(1);
      expect(history.children?.map((child) => child.properties?.step)).toEqual([0, 1, 2]);
    } finally {
      provider.stop();
    }
  });
});

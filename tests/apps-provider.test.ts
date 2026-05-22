import { describe, expect, test } from "bun:test";
import { createSlopServer } from "@slop-ai/server";

import { ConsumerHub } from "../src/core/consumer";
import { AppsProvider } from "../src/plugins/first-party/apps/provider";
import { InProcessTransport } from "../src/providers/in-process";
import type { RegisteredProvider } from "../src/providers/registry";
import { createTestConfig } from "./helpers/config";

const TEST_CONFIG = createTestConfig({
  plugins: {
    apps: { enabled: true },
    terminal: { enabled: false },
    filesystem: { enabled: false },
  },
});

function createExternalProvider(id: string, name: string): RegisteredProvider {
  const server = createSlopServer({ id, name });
  server.register("workspace", {
    type: "collection",
    props: { ready: true },
  });

  return {
    id,
    name,
    kind: "external",
    transport: new InProcessTransport(server),
    transportLabel: "in-process:test",
    stop: () => server.stop(),
  };
}

function createAppsRegisteredProvider(apps: AppsProvider): RegisteredProvider {
  return {
    id: "apps",
    name: "Apps",
    kind: "first-party",
    transport: new InProcessTransport(apps.server),
    transportLabel: "in-process",
    stop: () => apps.stop(),
    attachRuntime: (hub) => {
      apps.setHub(hub);
      return {
        stop() {
          apps.setHub(null);
        },
      };
    },
  };
}

describe("AppsProvider", () => {
  test("lists unloaded external apps and lets the agent load and unload them", async () => {
    const apps = new AppsProvider();
    const registeredApps = createAppsRegisteredProvider(apps);
    const hub = new ConsumerHub([registeredApps], TEST_CONFIG);
    const runtimeStop = registeredApps.attachRuntime?.(hub, TEST_CONFIG);

    try {
      await hub.connect();
      hub.registerProvider(createExternalProvider("native-demo", "Native Demo"));

      const available = await hub.queryState({
        providerId: "apps",
        path: "/available",
        depth: 2,
      });
      expect(available.properties).toMatchObject({
        count: 1,
        unloaded_count: 1,
      });
      expect(available.children?.[0]?.properties).toMatchObject({
        provider_id: "native-demo",
        status: "unloaded",
      });
      expect(
        available.affordances
          ?.filter((affordance) =>
            ["load_provider", "unload_provider", "reload_provider"].includes(affordance.action),
          )
          .map((affordance) => [affordance.action, affordance.idempotent]),
      ).toEqual([
        ["load_provider", undefined],
        ["unload_provider", undefined],
        ["reload_provider", undefined],
      ]);
      expect(hub.getProviderViews().map((view) => view.providerId)).toEqual(["apps"]);

      const load = await hub.invoke("apps", "/available", "load_provider", {
        provider_id: "native-demo",
      });
      expect(load.status).toBe("ok");
      expect(load.data).toEqual({
        provider_id: "native-demo",
        status: "connected",
        was_connected: false,
      });
      expect(hub.getProviderViews().map((view) => view.providerId)).toEqual([
        "apps",
        "native-demo",
      ]);

      const reload = await hub.invoke("apps", "/available", "reload_provider", {
        provider_id: "native-demo",
      });
      expect(reload.status).toBe("ok");
      expect(reload.data).toEqual({
        provider_id: "native-demo",
        status: "connected",
      });

      const unload = await hub.invoke("apps", "/available", "unload_provider", {
        provider_id: "native-demo",
      });
      expect(unload.status).toBe("ok");
      expect(unload.data).toEqual({
        provider_id: "native-demo",
        status: "unloaded",
        was_connected: true,
      });
      expect(hub.getProviderViews().map((view) => view.providerId)).toEqual(["apps"]);
    } finally {
      runtimeStop?.stop();
      hub.shutdown();
    }
  });
});

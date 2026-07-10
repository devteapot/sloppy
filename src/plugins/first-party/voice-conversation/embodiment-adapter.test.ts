import { describe, expect, test } from "bun:test";
import type { ResultMessage } from "@slop-ai/consumer/browser";

import {
  type InvokeProvider,
  NullEmbodimentAdapter,
  ReachyEmbodimentAdapter,
} from "./embodiment-adapter";

type Invocation = {
  providerId: string;
  path: string;
  action: string;
  params?: Record<string, unknown>;
};

function result(status: "ok" | "error", error?: { code: string; message: string }): ResultMessage {
  return { type: "result", id: "embodiment-test", status, data: {}, error };
}

describe("embodiment adapters", () => {
  test("NullEmbodimentAdapter is a complete no-op adapter", async () => {
    const adapter = new NullEmbodimentAdapter();
    expect(await adapter.emoteNames()).toEqual([]);
    const speaking = await adapter.beginSpeaking();
    expect(await speaking.emote("cheerful1")).toBe("unsupported");
    await speaking.finish();
    await adapter.interrupt();
    await adapter.dispose();
  });

  test("Reachy adapter owns vocabulary, emotes, and head animation protocol", async () => {
    const calls: Invocation[] = [];
    const invoke: InvokeProvider = async (providerId, path, action, params) => {
      calls.push({ providerId, path, action, params });
      return result("ok");
    };
    const adapter = new ReachyEmbodimentAdapter({
      providerId: "reachy",
      invoke,
      query: async () => ({ properties: { emotions: ["cheerful1", 3, "fear1"] } }) as never,
      delayFn: (_ms, signal) => untilAbort(signal),
      nowMs: () => 1000,
    });

    expect(await adapter.emoteNames()).toEqual(["cheerful1", "fear1"]);
    const speaking = await adapter.beginSpeaking();
    await waitUntil(() => calls.some((call) => call.action === "set_antennas"));
    expect(await speaking.emote("cheerful1")).toBe("played");
    await speaking.finish();

    expect(calls).toContainEqual({
      providerId: "reachy",
      path: "/behavior",
      action: "play_emotion",
      params: { name: "cheerful1", sound: false },
    });
    expect(calls.some((call) => call.path === "/head" && call.action === "set_pose")).toBe(true);
    expect(calls.some((call) => call.path === "/head" && call.action === "set_antennas")).toBe(
      true,
    );
    expect(calls.some((call) => call.action === "stop")).toBe(false);
    await adapter.dispose();
  });

  test("maps provider conflicts to busy and interrupt stops behavior", async () => {
    const calls: Invocation[] = [];
    const adapter = new ReachyEmbodimentAdapter({
      providerId: "reachy",
      invoke: async (providerId, path, action, params) => {
        calls.push({ providerId, path, action, params });
        if (action === "play_emotion") {
          return result("error", { code: "conflict", message: "busy" });
        }
        return result("ok");
      },
      query: async () => ({ properties: {} }) as never,
      delayFn: (_ms, signal) => untilAbort(signal),
    });

    const speaking = await adapter.beginSpeaking();
    expect(await speaking.emote("fear1")).toBe("busy");
    await adapter.interrupt();
    await speaking.finish();

    expect(calls.some((call) => call.path === "/behavior" && call.action === "stop")).toBe(true);
  });

  test("provider failures degrade vocabulary and animation without throwing", async () => {
    const errors: string[] = [];
    const adapter = new ReachyEmbodimentAdapter({
      providerId: "offline",
      invoke: async () => {
        throw new Error("offline");
      },
      query: async () => {
        throw new Error("offline");
      },
      onError: (where) => errors.push(where),
    });

    expect(await adapter.emoteNames()).toBeNull();
    const speaking = await adapter.beginSpeaking();
    await waitUntil(() => errors.includes("animation"));
    expect(await speaking.emote("unknown")).toBe("unsupported");
    await speaking.finish();
    expect(errors).toEqual(expect.arrayContaining(["emotes", "animation", "emote"]));
  });
});

function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for embodiment adapter activity.");
}

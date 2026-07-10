import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/in-process";
import { AgentSessionProvider } from "../src/session/provider";
import { SessionRuntime } from "../src/session/runtime";
import { SessionStore } from "../src/session/store";
import { speechRegistry } from "../src/speech/registry";
import type { SttSessionOptions } from "../src/speech/types";
import {
  createStreamingAgentFactory,
  createTestProfileManager,
  TEST_CONFIG,
} from "./helpers/agent-session-provider-harness";
import { createTestConfig } from "./helpers/config";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function createRuntime(sessionId: string): SessionRuntime {
  return new SessionRuntime({
    config: TEST_CONFIG,
    sessionId,
    agentFactory: createStreamingAgentFactory(),
    llmProfileManager: createTestProfileManager(),
  });
}

describe("Session Plugin runtime seams", () => {
  test("transient State is isolated, cloned, and refreshes the Session provider", async () => {
    const runtime = createRuntime("plugin-transient-state");
    const provider = new AgentSessionProvider(runtime);
    const refresh = spyOn(provider.server, "refresh");

    try {
      await runtime.start();
      refresh.mockClear();
      const alpha = runtime.getPluginRuntimeContext("alpha").transientState;
      const beta = runtime.getPluginRuntimeContext("beta").transientState;
      const input = { phase: "listening", nested: { count: 1 } };

      alpha.replace(input);
      input.nested.count = 9;

      expect(alpha.read()).toEqual({ phase: "listening", nested: { count: 1 } });
      expect(beta.read()).toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(runtime.store.getSnapshot())).not.toContain("listening");

      alpha.update((current) => ({ ...current, phase: "speaking" }));
      expect(alpha.read()).toMatchObject({ phase: "speaking" });
      alpha.clear();
      expect(alpha.read()).toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      provider.stop();
      await runtime.shutdown();
    }
  });

  test("public Session approvals resolve Session-native Plugin callbacks", async () => {
    const runtime = createRuntime("plugin-direct-approval");
    const provider = new AgentSessionProvider(runtime);
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    let executions = 0;

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 3);
      const requested = runtime.getPluginRuntimeContext("voice").approvals.request({
        path: "/conversation",
        action: "start_listening",
        reason: "Streams microphone audio remotely.",
        dangerous: true,
        execute: () => {
          executions += 1;
          return { status: "started" };
        },
      });

      let approvals = await consumer.query("/approvals", 2);
      expect(approvals.children?.[0]).toMatchObject({
        id: requested.approvalId,
        properties: {
          status: "pending",
          provider: "session-plugin:voice",
          path: "/conversation",
          action: "start_listening",
        },
      });

      const approved = await consumer.invoke(`/approvals/${requested.approvalId}`, "approve", {});
      expect(approved.status).toBe("ok");
      expect(executions).toBe(1);
      approvals = await consumer.query("/approvals", 2);
      expect(approvals.children?.[0]?.properties?.status).toBe("approved");
    } finally {
      provider.stop();
      await runtime.shutdown();
    }
  });

  test("public voice contract freezes consent before opening transport", async () => {
    const protocol = `test-public-voice-${crypto.randomUUID()}`;
    let transportOpens = 0;
    speechRegistry.registerStt(protocol, () => ({
      inputFormat: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
      startSession: async (_options: SttSessionOptions) => {
        transportOpens += 1;
        return {
          appendAudio: async () => undefined,
          end: async () => undefined,
          close: () => undefined,
        };
      },
    }));
    const config = createTestConfig({
      plugins: {
        apps: { enabled: false },
        terminal: { enabled: false },
        filesystem: { enabled: false },
        images: { enabled: false },
        voice: {
          enabled: false,
          stt: {
            endpoints: {
              remote: {
                protocol,
                dialect: "openai",
                baseUrl: "wss://speech.example.test/v1/realtime?secret=hidden",
                auth: { type: "none" },
                sampleRate: 16000,
                models: { "test-transcribe": {} },
              },
            },
            profiles: [{ id: "remote-stt", endpointId: "remote", model: "test-transcribe" }],
            defaultProfileId: "remote-stt",
          },
          conversation: {
            enabled: true,
            audio: {
              backend: "host",
              streamCommand: ["sh", "-c", "sleep 30"],
              playStreamCommand: ["sh", "-c", "cat >/dev/null"],
              streamChunkMs: 40,
              providerId: "reachy",
            },
            embodiment: { enabled: false, providerId: "reachy", emotes: false },
            realtime: { autoStartMode: "off", defaultStartMode: "single_turn" },
          },
        },
      },
    });
    const runtime = new SessionRuntime({
      config,
      sessionId: "public-voice-contract",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager(),
      sessionPersistencePath: false,
    });
    const provider = new AgentSessionProvider(runtime);
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      const plugins = await consumer.query("/plugins", 2);
      expect(plugins.children?.map((child) => child.id)).toEqual(["voice"]);
      expect(plugins.children?.[0]?.properties?.session_paths).toEqual(["/conversation"]);

      const requested = await consumer.invoke("/conversation", "start_listening", {
        mode: "single_turn",
      });
      expect(requested).toMatchObject({
        status: "ok",
        data: { status: "approval_required" },
      });
      expect(transportOpens).toBe(0);
      const approvals = await consumer.query("/approvals", 2);
      const approval = approvals.children?.[0];
      expect(approval?.properties).toMatchObject({
        status: "pending",
        auto_approvable: false,
      });
      expect(String(approval?.properties?.params_preview)).toContain("wss://speech.example.test");
      expect(String(approval?.properties?.params_preview)).not.toContain("secret=hidden");

      await consumer.invoke(`/approvals/${approval?.id}`, "approve", {});
      for (let attempt = 0; attempt < 50 && transportOpens === 0; attempt += 1) {
        await Bun.sleep(2);
      }
      expect(transportOpens).toBe(1);
      const conversation = await consumer.query("/conversation", 1);
      expect(conversation.affordances?.map((entry) => entry.action)).toEqual(["stop_listening"]);
      expect(conversation.properties).toMatchObject({
        run_fingerprint: expect.any(String),
        stt_endpoint: "remote",
      });
    } finally {
      await consumer.disconnect();
      provider.stop();
      await runtime.shutdown();
    }
  });

  test("persisted Session-native pending approvals expire on restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-plugin-approval-"));
    temporaryRoots.push(root);
    const persistencePath = join(root, "session.json");
    const first = new SessionStore({
      sessionId: "plugin-approval-restore",
      modelProvider: "openai",
      model: "gpt-test",
      persistencePath,
    });
    const approval = first.requestSessionApproval({
      pluginId: "voice",
      path: "/conversation",
      action: "start_listening",
      reason: "Consent cannot survive process restart.",
    });

    const restored = new SessionStore({
      sessionId: "plugin-approval-restore",
      modelProvider: "openai",
      model: "gpt-test",
      persistencePath,
    });

    expect(restored.getApproval(approval.id)).toMatchObject({
      status: "expired",
      canApprove: false,
      canReject: false,
    });
  });
});

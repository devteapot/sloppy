import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { type SloppyConfig, sloppyConfigSchema } from "../src/config/schema";
import type { InvokeContext, PolicyDecision } from "../src/core/policy";
import { maybeSynthesizeAutospeak } from "../src/plugins/first-party/voice/autospeak";
import { voiceNetworkRule } from "../src/plugins/first-party/voice/policy";
import { VoiceProvider } from "../src/plugins/first-party/voice/provider";
import {
  createVoicePlugin,
  VOICE_EXTENSION_NAMESPACE,
} from "../src/plugins/first-party/voice/session";
import { InProcessTransport } from "../src/providers/in-process";
import type { PluginRuntimeContext, PluginTurnCompleteEvent } from "../src/session/plugins/types";
import { SessionStore } from "../src/session/store";
import { createExtensionRecord } from "../src/session/store/extensions";
import type { VoiceModalityStateSnapshot, VoiceProfileManager } from "../src/voice/profile-manager";

function readyState(
  overrides: Partial<VoiceModalityStateSnapshot> = {},
): VoiceModalityStateSnapshot {
  return {
    status: "ready",
    activeProfileId: "p",
    selectedEndpointId: "e",
    selectedProtocol: "openai-speech",
    selectedModel: "m",
    selectedVoice: "alloy",
    autospeak: false,
    secureStoreKind: "none",
    secureStoreStatus: "unsupported",
    profiles: [
      {
        id: "p",
        endpointId: "e",
        protocol: "openai-speech",
        model: "m",
        ready: true,
        keySource: "not_required",
        isDefault: true,
      },
    ],
    ...overrides,
  };
}

function fakeManager(
  opts: { autospeak?: boolean; sttText?: string; ttsBytes?: number[] } = {},
): VoiceProfileManager {
  return {
    async getSttState() {
      return readyState();
    },
    async getTtsState() {
      return readyState({ autospeak: Boolean(opts.autospeak) });
    },
    async createSttAdapter() {
      return {
        transcribe: async () => ({
          text: opts.sttText ?? "hello world",
          confidence: 0.9,
          language: "en",
        }),
      };
    },
    async createTtsAdapter() {
      return {
        synthesize: async () => ({
          audio: new Uint8Array(opts.ttsBytes ?? [1, 2, 3]),
          mimeType: "audio/mpeg",
        }),
      };
    },
    setSttProfile() {},
    setTtsProfile() {},
    async activeTtsAutospeak() {
      return Boolean(opts.autospeak);
    },
  } as unknown as VoiceProfileManager;
}

describe("VoiceProvider affordances", () => {
  test("transcribe returns text from the active STT adapter", async () => {
    const provider = new VoiceProvider(fakeManager({ sttText: "the quick brown fox" }));
    const consumer = new SlopConsumer(providerTransport(provider));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    const result = await consumer.invoke("/stt", "transcribe", {
      audio: "AAAA",
      mime_type: "audio/wav",
    });

    expect(result.status).toBe("ok");
    expect((result.data as { text: string }).text).toBe("the quick brown fox");
    provider.stop();
  });

  test("synthesize returns base64 audio from the active TTS adapter", async () => {
    const provider = new VoiceProvider(fakeManager({ ttsBytes: [1, 2, 3] }));
    const consumer = new SlopConsumer(providerTransport(provider));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    const result = await consumer.invoke("/tts", "synthesize", { text: "hello" });

    expect(result.status).toBe("ok");
    const data = result.data as { audio_base64: string; mime_type: string };
    expect(data.audio_base64).toBe(Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"));
    expect(data.mime_type).toBe("audio/mpeg");
    provider.stop();
  });

  test("set_profile on /tts is accepted", async () => {
    const provider = new VoiceProvider(fakeManager());
    const consumer = new SlopConsumer(providerTransport(provider));
    await consumer.connect();
    await consumer.subscribe("/", 3);

    const result = await consumer.invoke("/tts", "set_profile", { profile_id: "tts-cloud" });
    expect(result.status).toBe("ok");
    expect((result.data as { active_profile: string }).active_profile).toBe("tts-cloud");
    provider.stop();
  });
});

function providerTransport(provider: VoiceProvider) {
  return new InProcessTransport(provider.server);
}

describe("voiceNetworkRule", () => {
  function configWithTts(endpointId: string): SloppyConfig {
    return sloppyConfigSchema.parse({
      plugins: {
        voice: {
          enabled: true,
          tts: {
            profiles: [{ id: "t", endpointId, voice: "alloy" }],
            defaultProfileId: "t",
          },
        },
      },
    }) as unknown as SloppyConfig;
  }

  function ctx(action: string, configEndpoint: string): InvokeContext {
    return {
      providerId: "voice",
      action,
      path: action === "transcribe" ? "/stt" : "/tts",
      params: { text: "hello" },
      config: configWithTts(configEndpoint),
    };
  }

  function decide(context: InvokeContext): PolicyDecision {
    return voiceNetworkRule.evaluate(context) as PolicyDecision;
  }

  test("allows synthesis to a local endpoint without approval", () => {
    expect(decide(ctx("synthesize", "piper")).kind).toBe("allow");
  });

  test("requires approval for a remote endpoint", () => {
    const decision = decide(ctx("synthesize", "openai-tts"));
    expect(decision.kind).toBe("require_approval");
    if (decision.kind === "require_approval") {
      expect(decision.dangerous).toBe(true);
    }
  });

  test("allows when pre-approved", () => {
    expect(decide({ ...ctx("synthesize", "openai-tts"), preApproved: true }).kind).toBe("allow");
  });

  test("ignores non-voice providers", () => {
    expect(decide({ ...ctx("synthesize", "openai-tts"), providerId: "terminal" }).kind).toBe(
      "allow",
    );
  });
});

describe("autospeak", () => {
  test("synthesizes when the active TTS profile has autospeak enabled", async () => {
    const audio = await maybeSynthesizeAutospeak(fakeManager({ autospeak: true }), "hello there");
    expect(audio).toEqual({
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
    });
  });

  test("returns null when autospeak is disabled or text is empty", async () => {
    expect(await maybeSynthesizeAutospeak(fakeManager({ autospeak: false }), "hello")).toBeNull();
    expect(await maybeSynthesizeAutospeak(fakeManager({ autospeak: true }), "   ")).toBeNull();
  });

  test("/voice node renders the published autospeak audio", () => {
    const store = createStore();
    store.upsertExtension(
      createExtensionRecord({
        namespace: VOICE_EXTENSION_NAMESPACE,
        instanceId: "autospeak",
        schemaVersion: 1,
        owner: { kind: "runtime", id: "voice" },
        state: {
          autospeak: {
            turnId: "t9",
            mimeType: "audio/mpeg",
            audio_base64: "AQID",
            created_at: "now",
          },
        },
      }),
    );
    const plugin = createVoicePlugin(fakeManager());
    const ctx = { snapshot: () => store.getSnapshot() } as unknown as PluginRuntimeContext;
    const node = plugin.sessionNodes?.(ctx)[0]?.build(ctx);

    expect(node?.props?.autospeak_pending).toBe(true);
    expect(node?.props?.audio_base64).toBe("AQID");
    expect(node?.props?.last_turn_id).toBe("t9");
  });

  test("onTurnComplete publishes a voice extension when autospeak is on", async () => {
    const store = createStore();
    const ctx = { store, snapshot: () => store.getSnapshot() } as unknown as PluginRuntimeContext;
    const plugin = createVoicePlugin(fakeManager({ autospeak: true }));

    plugin.onTurnComplete?.(turnEvent("turn-42", "spoken reply"), ctx);

    const record = await waitFor(() => store.getSnapshot().extensions[VOICE_EXTENSION_NAMESPACE]);
    const autospeak = record?.state.autospeak as { turnId: string; audio_base64: string };
    expect(autospeak.turnId).toBe("turn-42");
    expect(autospeak.audio_base64).toBe(Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"));
  });

  test("onTurnComplete writes nothing when autospeak is off", async () => {
    const store = createStore();
    const ctx = { store, snapshot: () => store.getSnapshot() } as unknown as PluginRuntimeContext;
    const plugin = createVoicePlugin(fakeManager({ autospeak: false }));

    plugin.onTurnComplete?.(turnEvent("turn-7", "no speech"), ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(store.getSnapshot().extensions[VOICE_EXTENSION_NAMESPACE]).toBeUndefined();
  });
});

function createStore(): SessionStore {
  return new SessionStore({
    sessionId: "voice-test",
    modelProvider: "openai",
    model: "gpt-5.4",
  });
}

function turnEvent(turnId: string, response: string): PluginTurnCompleteEvent {
  return {
    turnId,
    pluginTurn: { pluginId: "voice", runId: "r", author: "test", continuation: false },
    result: { status: "completed", response },
    elapsedMs: 1,
    usedTools: false,
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

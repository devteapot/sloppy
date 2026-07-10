import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  DEFAULT_STT_ENDPOINTS,
  DEFAULT_TTS_ENDPOINTS,
} from "../src/plugins/first-party/voice/endpoints";
import { registerSpeechProtocols } from "../src/plugins/first-party/voice/protocols";
import { type SpeechPluginConfig, SpeechProfileManager } from "../src/speech/profile-manager";
import { SpeechProtocolRegistry } from "../src/speech/registry";
import type { SttAdapterConfig, TtsAdapterConfig } from "../src/speech/types";
import { FakeCredentialStore } from "./helpers/fake-credential-store";

const ENV_VAR = "SPEECH_PROFILE_MANAGER_TEST_KEY";

afterEach(() => {
  delete Bun.env[ENV_VAR];
});

function speechConfig(overrides: Partial<SpeechPluginConfig> = {}): SpeechPluginConfig {
  return {
    enabled: true,
    stt: { endpoints: {}, profiles: [], defaultProfileId: undefined },
    tts: { endpoints: {}, profiles: [], defaultProfileId: undefined },
    ...overrides,
  };
}

const LOCAL_STT_ENDPOINT = {
  protocol: "realtime-stt",
  dialect: "openai" as string | undefined,
  baseUrl: "ws://localhost:8000/v1/realtime",
  auth: { type: "none" } as const,
  sampleRate: 16000,
};

// Mirrors what catalog.ts's speechManagerFor wires at runtime: a registry with
// the first-party protocols plus the voice plugin's endpoint defaults (the
// core singleton starts empty).
function makeManager(
  config: SpeechPluginConfig,
  store: FakeCredentialStore = new FakeCredentialStore(),
): SpeechProfileManager {
  const registry = new SpeechProtocolRegistry();
  registerSpeechProtocols(registry);
  return new SpeechProfileManager(config, {
    credentialStore: store,
    registry,
    defaults: { stt: DEFAULT_STT_ENDPOINTS, tts: DEFAULT_TTS_ENDPOINTS },
  });
}

describe("SpeechProfileManager — STT", () => {
  test("profile selection is validated and notifies active-run listeners", () => {
    const manager = makeManager(
      speechConfig({
        stt: {
          endpoints: { local: LOCAL_STT_ENDPOINT },
          profiles: [{ id: "stt-local", endpointId: "local", model: "test-model" }],
          defaultProfileId: "stt-local",
        },
      }),
    );
    let changes = 0;
    const stop = manager.onSelectionChange(() => {
      changes += 1;
    });

    manager.setSttProfile("stt-local");
    manager.setSttProfile("stt-local");
    expect(changes).toBe(1);
    expect(() => manager.setSttProfile("missing")).toThrow("is not configured");

    stop();
    manager.updateConfig(speechConfig());
    expect(changes).toBe(1);
  });

  test("local endpoint resolves ready with not_required key source", async () => {
    const manager = makeManager(
      speechConfig({
        stt: {
          endpoints: { local: LOCAL_STT_ENDPOINT },
          profiles: [{ id: "stt-local", endpointId: "local", model: "test-model" }],
          defaultProfileId: "stt-local",
        },
      }),
    );

    const state = await manager.getSttState();
    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe("stt-local");
    expect(state.selectedDialect).toBe("openai");
    expect(state.selectedSampleRate).toBe(16000);

    const adapter = await manager.createSttAdapter();
    expect(adapter.inputFormat).toEqual({ encoding: "pcm16", sampleRate: 16000, channels: 1 });
  });

  test("credential resolution prefers env, falls back to secure store", async () => {
    const store = new FakeCredentialStore({ "voice:cloud": "stored-key" });
    const manager = makeManager(
      speechConfig({
        stt: {
          endpoints: {
            cloud: { ...LOCAL_STT_ENDPOINT, auth: { type: "env", env: ENV_VAR } },
          },
          profiles: [{ id: "stt-cloud", endpointId: "cloud", model: "m" }],
          defaultProfileId: "stt-cloud",
        },
      }),
      store,
    );

    let state = await manager.getSttState();
    expect(state.profiles[0]?.keySource).toBe("secure_store");

    Bun.env[ENV_VAR] = "env-key";
    state = await manager.getSttState();
    expect(state.profiles[0]?.keySource).toBe("env");
  });

  test("unknown protocol surfaces invalidReason listing registered protocols", async () => {
    const manager = makeManager(
      speechConfig({
        stt: {
          endpoints: { legacy: { ...LOCAL_STT_ENDPOINT, protocol: "deepgram" } },
          profiles: [{ id: "stt-legacy", endpointId: "legacy", model: "nova-3" }],
          defaultProfileId: "stt-legacy",
        },
      }),
    );

    const state = await manager.getSttState();
    expect(state.status).toBe("needs_credentials");
    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.profiles[0]?.invalidReason).toMatch(
      /Unknown STT protocol 'deepgram'. Registered: realtime-stt/,
    );
    await expect(manager.createSttAdapter()).rejects.toThrow(/Unknown STT protocol 'deepgram'/);
  });

  test("built-in default endpoints are available without user config", async () => {
    const manager = makeManager(
      speechConfig({
        stt: {
          endpoints: {},
          profiles: [
            { id: "voxtral", endpointId: "vllm-realtime", model: "mistralai/Voxtral-Mini-4B" },
          ],
          defaultProfileId: "voxtral",
        },
      }),
    );

    const state = await manager.getSttState();
    expect(state.status).toBe("ready");
    expect(state.selectedProtocol).toBe("realtime-stt");
    expect(state.selectedDialect).toBe("vllm");
  });

  test("activeSttEndpoint matches selection incl. set_profile override", async () => {
    const manager = makeManager(
      speechConfig({
        stt: {
          endpoints: {
            local: LOCAL_STT_ENDPOINT,
            remote: { ...LOCAL_STT_ENDPOINT, baseUrl: "wss://stt.example.com/v1/realtime" },
          },
          profiles: [
            { id: "stt-local", endpointId: "local", model: "m" },
            { id: "stt-remote", endpointId: "remote", model: "m" },
          ],
          defaultProfileId: "stt-local",
        },
      }),
    );

    expect((await manager.activeSttEndpoint())?.id).toBe("local");
    manager.setSttProfile("stt-remote");
    expect((await manager.activeSttEndpoint())?.id).toBe("remote");
    expect((await manager.activeSttEndpoint())?.config.baseUrl).toBe(
      "wss://stt.example.com/v1/realtime",
    );
  });

  test("adapter cache reuses instances until config fingerprint changes", async () => {
    const config = speechConfig({
      stt: {
        endpoints: { local: { ...LOCAL_STT_ENDPOINT } },
        profiles: [{ id: "stt-local", endpointId: "local", model: "m" }],
        defaultProfileId: "stt-local",
      },
    });
    const manager = makeManager(config);

    const first = await manager.createSttAdapter();
    const second = await manager.createSttAdapter();
    expect(second).toBe(first);

    manager.updateConfig(
      speechConfig({
        stt: {
          endpoints: { local: { ...LOCAL_STT_ENDPOINT, sampleRate: 24000 } },
          profiles: [{ id: "stt-local", endpointId: "local", model: "m" }],
          defaultProfileId: "stt-local",
        },
      }),
    );
    const third = await manager.createSttAdapter();
    expect(third).not.toBe(first);
    expect(third.inputFormat.sampleRate).toBe(24000);
  });
});

describe("SpeechProfileManager — TTS", () => {
  test("kokoro catalog endpoint resolves a streaming adapter with endpoint model", async () => {
    const manager = makeManager(
      speechConfig({
        tts: {
          endpoints: {},
          profiles: [{ id: "tts-local", endpointId: "kokoro", voice: "af_bella" }],
          defaultProfileId: "tts-local",
        },
      }),
    );

    const state = await manager.getTtsState();
    expect(state.status).toBe("ready");
    expect(state.selectedVoice).toBe("af_bella");
    expect(state.selectedModel).toBe("kokoro");
    expect(state.selectedSampleRate).toBe(24000);

    const adapter = await manager.createTtsAdapter();
    expect(adapter.outputFormat).toEqual({ encoding: "pcm16", sampleRate: 24000, channels: 1 });
  });

  test("missing credential yields needs_credentials with actionable reason", async () => {
    const manager = makeManager(
      speechConfig({
        tts: {
          endpoints: {},
          profiles: [{ id: "tts-cloud", endpointId: "openai-tts", voice: "marin" }],
          defaultProfileId: "tts-cloud",
        },
      }),
    );
    const previous = Bun.env.OPENAI_API_KEY;
    delete Bun.env.OPENAI_API_KEY;
    try {
      const state = await manager.getTtsState();
      expect(state.status).toBe("needs_credentials");
      expect(state.profiles[0]?.invalidReason).toMatch(/Set OPENAI_API_KEY or store a key/);
      await expect(manager.createTtsAdapter()).rejects.toThrow(/Set OPENAI_API_KEY/);
    } finally {
      if (previous !== undefined) {
        Bun.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

describe("SpeechProfileManager — frozen adapter preparation", () => {
  test("bound factories keep captured routing after manager config changes", async () => {
    const registry = new SpeechProtocolRegistry();
    const sttConfigs: SttAdapterConfig[] = [];
    const ttsConfigs: TtsAdapterConfig[] = [];
    registry.registerStt("capture-stt", (config) => {
      sttConfigs.push(config);
      return {
        inputFormat: { encoding: "pcm16", sampleRate: config.sampleRate, channels: 1 },
        async startSession() {
          throw new Error("not used");
        },
      };
    });
    registry.registerTts("capture-tts", (config) => {
      ttsConfigs.push(config);
      return {
        outputFormat: { encoding: "pcm16", sampleRate: config.pcmSampleRate, channels: 1 },
        openStream() {
          throw new Error("not used");
        },
      };
    });
    const initial = speechConfig({
      stt: {
        endpoints: {
          stt: {
            protocol: "capture-stt",
            dialect: "first",
            baseUrl: "wss://old.example/realtime?token=hidden",
            headers: { Authorization: "secret", "X-Route": "one" },
            auth: { type: "none" },
            sampleRate: 16000,
          },
        },
        profiles: [{ id: "stt", endpointId: "stt", model: "old-model", language: "en" }],
        defaultProfileId: "stt",
      },
      tts: {
        endpoints: {
          tts: {
            protocol: "capture-tts",
            baseUrl: "https://old.example/v1?token=hidden",
            auth: { type: "none" },
            model: "old-tts",
            pcmSampleRate: 24000,
          },
        },
        profiles: [{ id: "tts", endpointId: "tts", voice: "old-voice", speed: 1 }],
        defaultProfileId: "tts",
      },
    });
    const manager = new SpeechProfileManager(initial, {
      credentialStore: new FakeCredentialStore(),
      registry,
    });
    const prepared = await manager.prepareActiveAdapters();

    manager.updateConfig(
      speechConfig({
        stt: {
          ...initial.stt,
          endpoints: {
            stt: {
              ...initial.stt.endpoints.stt!,
              baseUrl: "wss://old.example/realtime?token=different-hidden",
              headers: { Authorization: "different-secret", "X-Route": "two" },
            },
          },
        },
        tts: initial.tts,
      }),
    );
    const rerouted = await manager.prepareActiveAdapters();
    expect(rerouted.stt.destination.routingFingerprint).not.toBe(
      prepared.stt.destination.routingFingerprint,
    );

    manager.updateConfig(
      speechConfig({
        stt: {
          endpoints: {
            stt: {
              ...initial.stt.endpoints.stt!,
              baseUrl: "wss://new.example/realtime",
              sampleRate: 24000,
            },
          },
          profiles: [{ id: "stt", endpointId: "stt", model: "new-model" }],
          defaultProfileId: "stt",
        },
        tts: initial.tts,
      }),
    );

    prepared.stt.createAdapter();
    prepared.tts?.createAdapter();
    expect(sttConfigs[0]).toMatchObject({
      baseUrl: "wss://old.example/realtime?token=hidden",
      model: "old-model",
      sampleRate: 16000,
      headers: { Authorization: "secret", "X-Route": "one" },
    });
    expect(ttsConfigs[0]).toMatchObject({
      baseUrl: "https://old.example/v1?token=hidden",
      model: "old-tts",
      voice: "old-voice",
    });
    expect(prepared.stt.destination.origin).toBe("wss://old.example");
    expect(JSON.stringify(prepared.stt.destination)).not.toContain("hidden");
    expect(JSON.stringify(prepared.stt.destination)).not.toContain("secret");
    const guessableUnkeyedFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "stt",
          "stt",
          "stt",
          "wss://old.example/realtime?token=hidden",
          "none",
          {
            protocol: "capture-stt",
            dialect: "first",
            model: "old-model",
            language: "en",
            sampleRate: 16000,
            headers: { Authorization: "secret", "X-Route": "one" },
          },
        ]),
      )
      .digest("hex");
    expect(prepared.stt.destination.routingFingerprint).not.toBe(guessableUnkeyedFingerprint);

    const next = await manager.prepareActiveAdapters();
    expect(next.stt.destination.origin).toBe("wss://new.example");
    expect(next.stt.destination.routingFingerprint).not.toBe(
      prepared.stt.destination.routingFingerprint,
    );
  });

  test("retries when config changes during credential resolution", async () => {
    let releaseFirst!: () => void;
    let firstRead = true;
    const firstReadStarted = Promise.withResolvers<void>();
    const credentialStore = {
      kind: "keychain" as const,
      async getStatus() {
        return "available" as const;
      },
      async get() {
        if (firstRead) {
          firstRead = false;
          firstReadStarted.resolve();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return "key";
      },
      async set() {},
      async delete() {},
    };
    const registry = new SpeechProtocolRegistry();
    registry.registerStt("capture-stt", (config) => ({
      inputFormat: { encoding: "pcm16", sampleRate: config.sampleRate, channels: 1 },
      async startSession() {
        throw new Error("not used");
      },
    }));
    const configFor = (baseUrl: string) =>
      speechConfig({
        stt: {
          endpoints: {
            stt: {
              protocol: "capture-stt",
              baseUrl,
              auth: { type: "secure_store" },
            },
          },
          profiles: [{ id: "stt", endpointId: "stt", model: "model" }],
          defaultProfileId: "stt",
        },
      });
    const manager = new SpeechProfileManager(configFor("wss://old.example/realtime"), {
      credentialStore,
      registry,
    });

    const preparing = manager.prepareActiveAdapters();
    await firstReadStarted.promise;
    manager.updateConfig(configFor("wss://new.example/realtime"));
    releaseFirst();

    const prepared = await preparing;
    expect(prepared.generation).toBe(1);
    expect(prepared.stt.destination.origin).toBe("wss://new.example");
  });

  test("cancels the underlying credential read during preparation", async () => {
    const readStarted = Promise.withResolvers<void>();
    let readCancelled = false;
    const credentialStore = {
      kind: "keychain" as const,
      async getStatus() {
        return "available" as const;
      },
      async get(_id: string, options?: { signal?: AbortSignal }) {
        readStarted.resolve();
        return new Promise<string | null>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              readCancelled = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
      async set() {},
      async delete() {},
    };
    const registry = new SpeechProtocolRegistry();
    registry.registerStt("capture-stt", () => ({
      inputFormat: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
      async startSession() {
        throw new Error("not used");
      },
    }));
    const manager = new SpeechProfileManager(
      speechConfig({
        stt: {
          endpoints: {
            stt: {
              protocol: "capture-stt",
              baseUrl: "wss://speech.example/realtime",
              auth: { type: "secure_store" },
            },
          },
          profiles: [{ id: "stt", endpointId: "stt", model: "model" }],
          defaultProfileId: "stt",
        },
      }),
      { credentialStore, registry },
    );
    const controller = new AbortController();
    const preparing = manager.prepareActiveAdapters({ signal: controller.signal });
    await readStarted.promise;
    const reason = new Error("voice start stopped");
    controller.abort(reason);

    await expect(preparing).rejects.toBe(reason);
    expect(readCancelled).toBe(true);
  });
});

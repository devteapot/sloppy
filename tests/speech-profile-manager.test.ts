import { afterEach, describe, expect, test } from "bun:test";

import { type SpeechPluginConfig, SpeechProfileManager } from "../src/speech/profile-manager";
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

describe("SpeechProfileManager — STT", () => {
  test("local endpoint resolves ready with not_required key source", async () => {
    const manager = new SpeechProfileManager(
      speechConfig({
        stt: {
          endpoints: { local: LOCAL_STT_ENDPOINT },
          profiles: [{ id: "stt-local", endpointId: "local", model: "test-model" }],
          defaultProfileId: "stt-local",
        },
      }),
      { credentialStore: new FakeCredentialStore() },
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
    const manager = new SpeechProfileManager(
      speechConfig({
        stt: {
          endpoints: {
            cloud: { ...LOCAL_STT_ENDPOINT, auth: { type: "env", env: ENV_VAR } },
          },
          profiles: [{ id: "stt-cloud", endpointId: "cloud", model: "m" }],
          defaultProfileId: "stt-cloud",
        },
      }),
      { credentialStore: store },
    );

    let state = await manager.getSttState();
    expect(state.profiles[0]?.keySource).toBe("secure_store");

    Bun.env[ENV_VAR] = "env-key";
    state = await manager.getSttState();
    expect(state.profiles[0]?.keySource).toBe("env");
  });

  test("unknown protocol surfaces invalidReason listing registered protocols", async () => {
    const manager = new SpeechProfileManager(
      speechConfig({
        stt: {
          endpoints: { legacy: { ...LOCAL_STT_ENDPOINT, protocol: "deepgram" } },
          profiles: [{ id: "stt-legacy", endpointId: "legacy", model: "nova-3" }],
          defaultProfileId: "stt-legacy",
        },
      }),
      { credentialStore: new FakeCredentialStore() },
    );

    const state = await manager.getSttState();
    expect(state.status).toBe("needs_credentials");
    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.profiles[0]?.invalidReason).toMatch(
      /Unknown STT protocol 'deepgram'. Registered: realtime-stt/,
    );
    await expect(manager.createSttAdapter()).rejects.toThrow(/Unknown STT protocol 'deepgram'/);
  });

  test("built-in catalog endpoints are available without user config", async () => {
    const manager = new SpeechProfileManager(
      speechConfig({
        stt: {
          endpoints: {},
          profiles: [{ id: "dgx", endpointId: "dgx-nemotron", model: "/models/nemotron" }],
          defaultProfileId: "dgx",
        },
      }),
      { credentialStore: new FakeCredentialStore() },
    );

    const state = await manager.getSttState();
    expect(state.status).toBe("ready");
    expect(state.selectedProtocol).toBe("realtime-stt");
    expect(state.selectedDialect).toBe("openai");
  });

  test("activeSttEndpoint matches selection incl. set_profile override", async () => {
    const manager = new SpeechProfileManager(
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
      { credentialStore: new FakeCredentialStore() },
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
    const manager = new SpeechProfileManager(config, {
      credentialStore: new FakeCredentialStore(),
    });

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
    const manager = new SpeechProfileManager(
      speechConfig({
        tts: {
          endpoints: {},
          profiles: [{ id: "tts-local", endpointId: "kokoro", voice: "af_bella" }],
          defaultProfileId: "tts-local",
        },
      }),
      { credentialStore: new FakeCredentialStore() },
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
    const manager = new SpeechProfileManager(
      speechConfig({
        tts: {
          endpoints: {},
          profiles: [{ id: "tts-cloud", endpointId: "openai-tts", voice: "marin" }],
          defaultProfileId: "tts-cloud",
        },
      }),
      { credentialStore: new FakeCredentialStore() },
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

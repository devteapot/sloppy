import { afterEach, describe, expect, test } from "bun:test";

import { sloppyConfigSchema, type VoicePluginConfig } from "../src/config/schema";
import type {
  CredentialStore,
  CredentialStoreKind,
  CredentialStoreStatus,
} from "../src/llm/credential-store";
import { VoiceProfileManager } from "../src/voice/profile-manager";

class FakeCredentialStore implements CredentialStore {
  readonly kind: CredentialStoreKind = "keychain";
  private readonly map = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.map.set(key, value);
    }
  }

  async getStatus(): Promise<CredentialStoreStatus> {
    return "available";
  }
  async get(id: string): Promise<string | null> {
    return this.map.get(id) ?? null;
  }
  async set(id: string, secret: string): Promise<void> {
    this.map.set(id, secret);
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

function voiceConfig(overrides: Record<string, unknown>): VoicePluginConfig {
  return sloppyConfigSchema.parse({ plugins: { voice: { enabled: true, ...overrides } } }).plugins
    .voice;
}

const ENV_VAR = "VOICE_PROFILE_MANAGER_TEST_KEY";

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("VoiceProfileManager", () => {
  test("local STT endpoint (auth none) is ready without credentials", async () => {
    const config = voiceConfig({
      stt: {
        profiles: [
          { id: "stt-local", endpointId: "faster-whisper", model: "Systran/faster-whisper-base" },
        ],
        defaultProfileId: "stt-local",
      },
    });
    const manager = new VoiceProfileManager(config, { credentialStore: new FakeCredentialStore() });

    const state = await manager.getSttState();
    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe("stt-local");
    expect(state.profiles[0]?.keySource).toBe("not_required");

    const adapter = await manager.createSttAdapter();
    expect(typeof adapter.transcribe).toBe("function");
  });

  test("env-authenticated TTS endpoint is ready when the env var is present", async () => {
    process.env[ENV_VAR] = "sk-live";
    const config = voiceConfig({
      tts: {
        endpoints: {
          custom: {
            protocol: "openai-speech",
            auth: { type: "env", env: ENV_VAR },
            model: "gpt-4o-mini-tts",
          },
        },
        profiles: [{ id: "tts-cloud", endpointId: "custom", voice: "alloy", autospeak: true }],
        defaultProfileId: "tts-cloud",
      },
    });
    const manager = new VoiceProfileManager(config, { credentialStore: new FakeCredentialStore() });

    const state = await manager.getTtsState();
    expect(state.status).toBe("ready");
    expect(state.autospeak).toBe(true);
    expect(state.profiles[0]?.keySource).toBe("env");
    expect(await manager.activeTtsAutospeak()).toBe(true);
  });

  test("env-authenticated endpoint needs credentials when nothing is set", async () => {
    const config = voiceConfig({
      tts: {
        endpoints: {
          custom: {
            protocol: "openai-speech",
            auth: { type: "env", env: ENV_VAR },
            model: "gpt-4o-mini-tts",
          },
        },
        profiles: [{ id: "tts-cloud", endpointId: "custom", voice: "alloy", autospeak: true }],
        defaultProfileId: "tts-cloud",
      },
    });
    const manager = new VoiceProfileManager(config, { credentialStore: new FakeCredentialStore() });

    const state = await manager.getTtsState();
    expect(state.status).toBe("needs_credentials");
    expect(state.profiles[0]?.keySource).toBe("missing");
    expect(await manager.activeTtsAutospeak()).toBe(false);
    await expect(manager.createTtsAdapter()).rejects.toThrow();
  });

  test("secure-store credential keyed by voice:<endpointId> satisfies readiness", async () => {
    const config = voiceConfig({
      tts: {
        endpoints: {
          custom: {
            protocol: "openai-speech",
            auth: { type: "secure_store" },
            model: "gpt-4o-mini-tts",
          },
        },
        profiles: [{ id: "tts-cloud", endpointId: "custom", voice: "alloy" }],
        defaultProfileId: "tts-cloud",
      },
    });
    const manager = new VoiceProfileManager(config, {
      credentialStore: new FakeCredentialStore({ "voice:custom": "sk-stored" }),
    });

    const state = await manager.getTtsState();
    expect(state.status).toBe("ready");
    expect(state.profiles[0]?.keySource).toBe("secure_store");

    const adapter = await manager.createTtsAdapter();
    expect(typeof adapter.synthesize).toBe("function");
  });

  test("no profiles reports not_configured (partial pipeline)", async () => {
    const config = voiceConfig({
      stt: {
        profiles: [
          { id: "stt-local", endpointId: "faster-whisper", model: "Systran/faster-whisper-base" },
        ],
        defaultProfileId: "stt-local",
      },
    });
    const manager = new VoiceProfileManager(config, { credentialStore: new FakeCredentialStore() });

    expect((await manager.getSttState()).status).toBe("ready");
    expect((await manager.getTtsState()).status).toBe("not_configured");
    expect(await manager.activeTtsAutospeak()).toBe(false);
  });

  test("unknown endpoint reference is flagged on the profile", async () => {
    const config = voiceConfig({
      stt: {
        profiles: [{ id: "stt-x", endpointId: "does-not-exist", model: "whatever" }],
        defaultProfileId: "stt-x",
      },
    });
    const manager = new VoiceProfileManager(config, { credentialStore: new FakeCredentialStore() });

    const state = await manager.getSttState();
    expect(state.status).toBe("needs_credentials");
    expect(state.profiles[0]?.invalidReason).toContain("does-not-exist");
  });
});

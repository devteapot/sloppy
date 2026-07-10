import { describe, expect, test } from "bun:test";

import { prepareVoiceRun } from "../src/plugins/first-party/voice/run-plan";
import type {
  SpeechModalityStateSnapshot,
  SpeechProfileManager,
  SpeechSttEndpointConfig,
  SpeechTtsEndpointConfig,
} from "../src/speech/profile-manager";

function state(
  modality: "stt" | "tts",
  endpointId: string,
  profileId: string,
): SpeechModalityStateSnapshot {
  return {
    status: "ready",
    activeProfileId: profileId,
    selectedEndpointId: endpointId,
    selectedProtocol: modality === "stt" ? "realtime-stt" : "openai-speech",
    selectedModel: "model",
    selectedVoice: modality === "tts" ? "voice" : undefined,
    selectedSampleRate: modality === "stt" ? 16000 : 24000,
    secureStoreKind: "none",
    secureStoreStatus: "unsupported",
    profiles: [],
  };
}

function manager(options?: {
  stt?: SpeechSttEndpointConfig;
  tts?: SpeechTtsEndpointConfig;
  ttsReady?: boolean;
}): SpeechProfileManager & { created: string[] } {
  const stt =
    options?.stt ??
    ({
      protocol: "realtime-stt",
      baseUrl: "ws://localhost:8000/v1/realtime",
      auth: { type: "none" },
    } satisfies SpeechSttEndpointConfig);
  const tts =
    options?.tts ??
    ({
      protocol: "openai-speech",
      baseUrl: "http://localhost:8880/v1",
      auth: { type: "none" },
    } satisfies SpeechTtsEndpointConfig);
  const created: string[] = [];
  return {
    created,
    async prepareActiveAdapters() {
      const sttOrigin = new URL(stt.baseUrl ?? "ws://localhost").origin;
      const ttsOrigin = new URL(tts.baseUrl ?? "http://localhost").origin;
      const destination = (
        profileId: string,
        endpointId: string,
        label: string,
        origin: string,
        protocol: string,
      ) => ({
        profileId,
        endpointId,
        label,
        origin,
        remote: !origin.includes("localhost") && !origin.includes("127.0.0.1"),
        routingFingerprint: `${protocol}:${origin}`,
      });
      return {
        generation: 1,
        stt: {
          destination: destination(
            "stt-profile",
            "stt-endpoint",
            stt.label ?? "stt-endpoint",
            sttOrigin,
            stt.protocol,
          ),
          createAdapter: () => {
            created.push("stt:stt-profile");
            return {} as never;
          },
        },
        ...(options?.ttsReady === false
          ? {}
          : {
              tts: {
                destination: destination(
                  "tts-profile",
                  "tts-endpoint",
                  tts.label ?? "tts-endpoint",
                  ttsOrigin,
                  tts.protocol,
                ),
                createAdapter: () => {
                  created.push("tts:tts-profile");
                  return {} as never;
                },
              },
            }),
      };
    },
    async getSttState() {
      return state("stt", "stt-endpoint", "stt-profile");
    },
    async getTtsState() {
      return options?.ttsReady === false
        ? { ...state("tts", "tts-endpoint", "tts-profile"), status: "needs_credentials" }
        : state("tts", "tts-endpoint", "tts-profile");
    },
    async activeSttEndpoint() {
      return { id: "stt-endpoint", config: stt };
    },
    async activeTtsEndpoint() {
      return { id: "tts-endpoint", config: tts };
    },
    async createSttAdapter(profileId?: string) {
      created.push(`stt:${profileId}`);
      return {} as never;
    },
    async createTtsAdapter(profileId?: string) {
      created.push(`tts:${profileId}`);
      return {} as never;
    },
  } as unknown as SpeechProfileManager & { created: string[] };
}

describe("prepared voice run", () => {
  test("freezes profile selection and creates adapters from the frozen ids", async () => {
    const profiles = manager();
    const prepared = await prepareVoiceRun(profiles, "continuous");

    expect(prepared.plan.stt.profileId).toBe("stt-profile");
    expect(prepared.plan.tts?.profileId).toBe("tts-profile");
    expect(prepared.plan.stt.origin).toBe("ws://localhost:8000");
    expect(prepared.privacy.kind).toBe("local");

    const execution = prepared.begin();
    await execution.createSttAdapter();
    await execution.createTtsAdapter();
    expect(profiles.created).toEqual(["stt:stt-profile", "tts:tts-profile"]);
    expect(() => prepared.begin()).toThrow("already begun");
  });

  test("describes every remote egress without exposing endpoint secrets", async () => {
    const profiles = manager({
      stt: {
        label: "Remote ASR",
        protocol: "realtime-stt",
        baseUrl: "wss://speech.example/realtime?token=secret-url-token",
        auth: { type: "env", env: "SECRET_STT_KEY" },
        headers: { Authorization: "secret" },
      },
      tts: {
        label: "Remote TTS",
        protocol: "openai-speech",
        baseUrl: "https://speech.example/v1",
        auth: { type: "secure_store" },
      },
    });
    const prepared = await prepareVoiceRun(profiles, "single_turn");

    expect(prepared.privacy.kind).toBe("approval_required");
    if (prepared.privacy.kind === "approval_required") {
      expect(prepared.privacy.reason).toContain("microphone audio to Remote ASR");
      expect(prepared.privacy.reason).toContain("conversation text to Remote TTS");
      expect(prepared.privacy.reason).toContain("wss://speech.example");
      expect(prepared.privacy.reason).toContain("https://speech.example");
      expect(prepared.privacy.paramsPreview).not.toContain("SECRET_STT_KEY");
      expect(prepared.privacy.paramsPreview).not.toContain("Authorization");
      expect(prepared.privacy.paramsPreview).not.toContain("secret");
      expect(prepared.privacy.paramsPreview).not.toContain("token=");
    }
  });

  test("supports an STT-only run", async () => {
    const profiles = manager({ ttsReady: false });
    const prepared = await prepareVoiceRun(profiles, "single_turn");
    const execution = prepared.begin();

    expect(prepared.plan.tts).toBeUndefined();
    expect(await execution.createTtsAdapter()).toBeNull();
  });
});

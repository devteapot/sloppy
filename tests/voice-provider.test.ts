import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { VoiceProvider } from "../src/plugins/first-party/voice/provider";
import { InProcessTransport } from "../src/providers/in-process";
import type {
  SpeechModalityStateSnapshot,
  SpeechProfileManager,
} from "../src/speech/profile-manager";

function readyState(
  overrides: Partial<SpeechModalityStateSnapshot> = {},
): SpeechModalityStateSnapshot {
  return {
    status: "ready",
    activeProfileId: "p",
    selectedEndpointId: "e",
    selectedProtocol: "realtime-stt",
    selectedDialect: "openai",
    selectedModel: "m",
    selectedSampleRate: 16000,
    secureStoreKind: "none",
    secureStoreStatus: "unsupported",
    profiles: [
      {
        id: "p",
        endpointId: "e",
        protocol: "realtime-stt",
        dialect: "openai",
        model: "m",
        ready: true,
        keySource: "not_required",
        isDefault: true,
      },
    ],
    ...overrides,
  };
}

function fakeManager(): SpeechProfileManager & { selected: string[] } {
  const selected: string[] = [];
  return {
    selected,
    async getSttState() {
      return readyState();
    },
    async getTtsState() {
      return readyState({
        selectedProtocol: "openai-speech",
        selectedVoice: "af_bella",
        selectedSampleRate: 24000,
      });
    },
    setSttProfile(id: string) {
      selected.push(`stt:${id}`);
    },
    setTtsProfile(id: string) {
      selected.push(`tts:${id}`);
    },
  } as unknown as SpeechProfileManager & { selected: string[] };
}

function connect(provider: VoiceProvider) {
  return new SlopConsumer(new InProcessTransport(provider.server));
}

describe("VoiceProvider", () => {
  test("set_profile switches the STT profile through the manager", async () => {
    const manager = fakeManager();
    const provider = new VoiceProvider(manager);
    const consumer = connect(provider);
    await consumer.connect();
    await consumer.subscribe("/", 3);

    const result = await consumer.invoke("/stt", "set_profile", { profile_id: "stt-dgx" });
    expect(result.status).toBe("ok");
    expect((result.data as { active_profile: string }).active_profile).toBe("stt-dgx");
    expect(manager.selected).toContain("stt:stt-dgx");
    provider.stop();
  });

  test("set_profile switches the TTS profile through the manager", async () => {
    const manager = fakeManager();
    const provider = new VoiceProvider(manager);
    const consumer = connect(provider);
    await consumer.connect();
    await consumer.subscribe("/", 3);

    const result = await consumer.invoke("/tts", "set_profile", { profile_id: "tts-cloud" });
    expect(result.status).toBe("ok");
    expect(manager.selected).toContain("tts:tts-cloud");
    provider.stop();
  });

  test("batch transcribe/synthesize affordances no longer exist", async () => {
    const provider = new VoiceProvider(fakeManager());
    const consumer = connect(provider);
    await consumer.connect();
    await consumer.subscribe("/", 3);

    const transcribe = await consumer.invoke("/stt", "transcribe", { audio: "AAAA" });
    expect(transcribe.status).toBe("error");
    const synthesize = await consumer.invoke("/tts", "synthesize", { text: "hello" });
    expect(synthesize.status).toBe("error");
    provider.stop();
  });
});

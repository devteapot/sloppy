import { describe, expect, test } from "bun:test";

import { SpeechProtocolRegistry } from "../src/speech/registry";
import type {
  SttAdapterConfig,
  SttProtocolAdapter,
  TtsAdapterConfig,
  TtsProtocolAdapter,
} from "../src/speech/types";

const sttAdapter: SttProtocolAdapter = {
  inputFormat: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
  startSession: () => Promise.reject(new Error("unused")),
};

const ttsAdapter: TtsProtocolAdapter = {
  outputFormat: { encoding: "pcm16", sampleRate: 24000, channels: 1 },
  openStream: () => {
    throw new Error("unused");
  },
};

const sttConfig = (protocol: string): SttAdapterConfig => ({
  endpointId: "ep",
  protocol,
  model: "m",
  sampleRate: 16000,
});

const ttsConfig = (protocol: string): TtsAdapterConfig => ({
  endpointId: "ep",
  protocol,
  model: "m",
  pcmSampleRate: 24000,
});

describe("SpeechProtocolRegistry", () => {
  test("creates adapters from registered factories", () => {
    const registry = new SpeechProtocolRegistry();
    registry.registerStt("fake-stt", () => sttAdapter);
    registry.registerTts("fake-tts", () => ttsAdapter);

    expect(registry.createSttAdapter(sttConfig("fake-stt"))).toBe(sttAdapter);
    expect(registry.createTtsAdapter(ttsConfig("fake-tts"))).toBe(ttsAdapter);
    expect(registry.hasSttProtocol("fake-stt")).toBe(true);
    expect(registry.hasTtsProtocol("fake-tts")).toBe(true);
  });

  test("unknown protocol errors list the registered ids", () => {
    const registry = new SpeechProtocolRegistry();
    registry.registerStt("realtime-stt", () => sttAdapter);

    expect(() => registry.createSttAdapter(sttConfig("deepgram"))).toThrow(
      /Unknown STT protocol 'deepgram'. Registered: realtime-stt/,
    );
    expect(() => registry.createTtsAdapter(ttsConfig("piper"))).toThrow(
      /Unknown TTS protocol 'piper'. Registered: none/,
    );
  });

  test("duplicate registration throws", () => {
    const registry = new SpeechProtocolRegistry();
    registry.registerStt("realtime-stt", () => sttAdapter);
    expect(() => registry.registerStt("realtime-stt", () => sttAdapter)).toThrow(
      /already registered/,
    );
  });
});

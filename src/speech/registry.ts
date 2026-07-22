// Protocol registry for speech adapters. Protocols are plain strings in
// config — validated here at lookup time rather than by a closed schema enum —
// so future providers (ElevenLabs, Cartesia, vendor WS dialects) can be added
// by plugins via register*() without touching the runtime.

import {
  SpeechError,
  type SttAdapterConfig,
  type SttProtocolAdapter,
  type TtsAdapterConfig,
  type TtsProtocolAdapter,
} from "./types";

export type SttAdapterFactory = (config: SttAdapterConfig) => SttProtocolAdapter;
export type TtsAdapterFactory = (config: TtsAdapterConfig) => TtsProtocolAdapter;

export class SpeechProtocolRegistry {
  private readonly stt = new Map<string, SttAdapterFactory>();
  private readonly tts = new Map<string, TtsAdapterFactory>();

  registerStt(protocolId: string, factory: SttAdapterFactory): void {
    if (this.stt.has(protocolId)) {
      throw new SpeechError(`STT protocol '${protocolId}' is already registered.`);
    }
    this.stt.set(protocolId, factory);
  }

  registerTts(protocolId: string, factory: TtsAdapterFactory): void {
    if (this.tts.has(protocolId)) {
      throw new SpeechError(`TTS protocol '${protocolId}' is already registered.`);
    }
    this.tts.set(protocolId, factory);
  }

  hasSttProtocol(protocolId: string): boolean {
    return this.stt.has(protocolId);
  }

  hasTtsProtocol(protocolId: string): boolean {
    return this.tts.has(protocolId);
  }

  sttProtocols(): string[] {
    return [...this.stt.keys()];
  }

  ttsProtocols(): string[] {
    return [...this.tts.keys()];
  }

  createSttAdapter(config: SttAdapterConfig): SttProtocolAdapter {
    const factory = this.stt.get(config.protocol);
    if (!factory) {
      throw new SpeechError(
        `Unknown STT protocol '${config.protocol}'. Registered: ${this.sttProtocols().join(", ") || "none"}.`,
      );
    }
    return factory(config);
  }

  createTtsAdapter(config: TtsAdapterConfig): TtsProtocolAdapter {
    const factory = this.tts.get(config.protocol);
    if (!factory) {
      throw new SpeechError(
        `Unknown TTS protocol '${config.protocol}'. Registered: ${this.ttsProtocols().join(", ") || "none"}.`,
      );
    }
    return factory(config);
  }
}

/**
 * Shared registry instance. It starts EMPTY: core has no protocol knowledge.
 * The voice plugin registers the first-party protocols ("realtime-stt",
 * "openai-speech") via `registerSpeechProtocols` when `speechManagerFor`
 * first runs; other plugins add theirs the same way.
 */
export const speechRegistry = new SpeechProtocolRegistry();

import { ElevenLabsTtsAdapter } from "./elevenlabs";
import { OpenAISpeechAdapter } from "./openai-speech";
import { PiperAdapter } from "./piper";
import type { TtsAdapter, TtsAdapterConfig, TtsAdapterOptions } from "./types";

export function createTtsAdapter(config: TtsAdapterConfig): TtsAdapter {
  const base: TtsAdapterOptions = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    headers: config.headers,
    voice: config.voice,
    format: config.format,
    speed: config.speed,
  };
  switch (config.protocol) {
    case "openai-speech":
      return new OpenAISpeechAdapter(base);
    case "elevenlabs":
      return new ElevenLabsTtsAdapter(base);
    case "piper":
      return new PiperAdapter(base);
  }
}

import { DeepgramAdapter } from "./deepgram";
import { ElevenLabsSttAdapter } from "./elevenlabs";
import { OpenAITranscriptionsAdapter } from "./openai-transcriptions";
import type { SttAdapter, SttAdapterConfig, SttAdapterOptions } from "./types";

export function createSttAdapter(config: SttAdapterConfig): SttAdapter {
  const base: SttAdapterOptions = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    headers: config.headers,
    language: config.language,
  };
  switch (config.protocol) {
    case "openai-transcriptions":
      return new OpenAITranscriptionsAdapter(base);
    case "deepgram":
      return new DeepgramAdapter(base);
    case "elevenlabs":
      return new ElevenLabsSttAdapter(base);
  }
}

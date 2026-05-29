import type { TtsProtocol, VoiceAudioFormat } from "../config/schema";
import type { FetchLike } from "../voice/audio";

export interface TtsSynthesizeOptions {
  text: string;
  /** Voice id; overrides the adapter default. */
  voice?: string;
  /** Output container/codec; overrides the adapter default. */
  format?: VoiceAudioFormat;
  /** Playback speed multiplier (provider support varies). */
  speed?: number;
  signal?: AbortSignal;
}

export interface TtsResult {
  audio: Uint8Array;
  mimeType: string;
  sampleRate?: number;
}

export interface TtsAdapter {
  synthesize(options: TtsSynthesizeOptions): Promise<TtsResult>;
}

/** Common construction options shared by every TTS adapter. */
export interface TtsAdapterOptions {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Default voice applied when a call omits one. */
  voice?: string;
  /** Default output format applied when a call omits one. */
  format?: VoiceAudioFormat;
  speed?: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

/** Resolved config the factory turns into an adapter instance. */
export type TtsAdapterConfig = {
  endpointId: string;
  protocol: TtsProtocol;
  model: string;
  apiKey?: string;
  authHint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  voice?: string;
  format?: VoiceAudioFormat;
  speed?: number;
};

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

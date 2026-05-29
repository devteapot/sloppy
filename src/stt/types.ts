import type { SttProtocol } from "../config/schema";
import type { FetchLike } from "../voice/audio";

export interface SttTranscribeOptions {
  /** Raw audio bytes or a base64-encoded audio payload. */
  audio: Uint8Array | string;
  /** MIME type of the audio (e.g. "audio/wav", "audio/mpeg", "audio/webm"). */
  mimeType?: string;
  /** BCP-47 language hint (e.g. "en"). Overrides the adapter default. */
  language?: string;
  signal?: AbortSignal;
}

export interface SttResult {
  text: string;
  /** 0–1 confidence when the provider reports it. */
  confidence?: number;
  /** Detected/used language when the provider reports it. */
  language?: string;
}

export interface SttAdapter {
  transcribe(options: SttTranscribeOptions): Promise<SttResult>;
}

/** Common construction options shared by every STT adapter. */
export interface SttAdapterOptions {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Default language applied when a call omits one. */
  language?: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

/** Resolved config the factory turns into an adapter instance. */
export type SttAdapterConfig = {
  endpointId: string;
  protocol: SttProtocol;
  model: string;
  apiKey?: string;
  authHint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  language?: string;
};

export class SttError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SttError";
  }
}

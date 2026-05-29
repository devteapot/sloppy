import { type FetchLike, formatToMimeType, trimBaseUrl } from "../voice/audio";
import {
  type TtsAdapter,
  type TtsAdapterOptions,
  TtsError,
  type TtsResult,
  type TtsSynthesizeOptions,
} from "./types";

const DEFAULT_BASE_URL = "http://localhost:5000";

/**
 * Piper HTTP server adapter (local-only). Piper synthesizes WAV; the common
 * HTTP wrapper accepts a JSON `{ text, voice }` body and returns audio bytes.
 */
export class PiperAdapter implements TtsAdapter {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly voice?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: TtsAdapterOptions) {
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.headers = options.headers ?? {};
    this.voice = options.voice;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(options: TtsSynthesizeOptions): Promise<TtsResult> {
    const voice = options.voice ?? this.voice ?? this.model;
    const response = await this.fetchImpl(`${this.baseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav",
        ...this.headers,
      },
      body: JSON.stringify({ text: options.text, voice }),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new TtsError(
        `Piper synthesis failed (${response.status}): ${await safeText(response)}`,
        response.status,
      );
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    return { audio, mimeType: formatToMimeType("wav") };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

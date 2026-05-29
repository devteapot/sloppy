import { type FetchLike, formatToMimeType, trimBaseUrl } from "../voice/audio";
import {
  type TtsAdapter,
  type TtsAdapterOptions,
  TtsError,
  type TtsResult,
  type TtsSynthesizeOptions,
} from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_VOICE = "alloy";

/**
 * OpenAI `/v1/audio/speech` adapter. Also drives local OpenAI-compatible TTS
 * servers (kokoro-fastapi, openedai-speech, LocalAI) — local is just a different
 * `baseUrl` + `auth: { type: "none" }`.
 */
export class OpenAISpeechAdapter implements TtsAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly voice: string;
  private readonly format?: TtsSynthesizeOptions["format"];
  private readonly speed?: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: TtsAdapterOptions) {
    this.apiKey = options.apiKey ?? "local";
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.headers = options.headers ?? {};
    this.voice = options.voice ?? DEFAULT_VOICE;
    this.format = options.format;
    this.speed = options.speed;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(options: TtsSynthesizeOptions): Promise<TtsResult> {
    const format = options.format ?? this.format ?? "mp3";
    const body: Record<string, unknown> = {
      model: this.model,
      input: options.text,
      voice: options.voice ?? this.voice,
      response_format: format,
    };
    const speed = options.speed ?? this.speed;
    if (speed !== undefined) {
      body.speed = speed;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new TtsError(
        `OpenAI speech synthesis failed (${response.status}): ${await safeText(response)}`,
        response.status,
      );
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    return { audio, mimeType: formatToMimeType(format) };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

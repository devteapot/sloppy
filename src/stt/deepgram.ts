import { type FetchLike, toAudioBlob, toAudioBytes, trimBaseUrl } from "../voice/audio";
import {
  type SttAdapter,
  type SttAdapterOptions,
  SttError,
  type SttResult,
  type SttTranscribeOptions,
} from "./types";

const DEFAULT_BASE_URL = "https://api.deepgram.com/v1";

type DeepgramResponse = {
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
    }>;
  };
};

/** Deepgram `/v1/listen` pre-recorded transcription adapter. */
export class DeepgramAdapter implements SttAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly language?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SttAdapterOptions) {
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.headers = options.headers ?? {};
    this.language = options.language;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(options: SttTranscribeOptions): Promise<SttResult> {
    const bytes = toAudioBytes(options.audio);
    const params = new URLSearchParams({ model: this.model, smart_format: "true" });
    const language = options.language ?? this.language;
    if (language) {
      params.set("language", language);
    } else {
      params.set("detect_language", "true");
    }

    const response = await this.fetchImpl(`${this.baseUrl}/listen?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": options.mimeType ?? "audio/wav",
        ...this.headers,
      },
      body: toAudioBlob(bytes, options.mimeType ?? "audio/wav"),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new SttError(
        `Deepgram transcription failed (${response.status}): ${await safeText(response)}`,
        response.status,
      );
    }

    const data = (await response.json()) as DeepgramResponse;
    const channel = data.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    return {
      text: (alternative?.transcript ?? "").trim(),
      confidence: alternative?.confidence,
      language: channel?.detected_language ?? language,
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

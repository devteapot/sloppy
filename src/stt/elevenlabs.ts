import {
  audioFileName,
  type FetchLike,
  toAudioBlob,
  toAudioBytes,
  trimBaseUrl,
} from "../voice/audio";
import {
  type SttAdapter,
  type SttAdapterOptions,
  SttError,
  type SttResult,
  type SttTranscribeOptions,
} from "./types";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";

type ElevenLabsResponse = {
  text?: string;
  language_code?: string;
  language_probability?: number;
};

/** ElevenLabs `/v1/speech-to-text` adapter. */
export class ElevenLabsSttAdapter implements SttAdapter {
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
    const form = new FormData();
    form.append("model_id", this.model);
    const language = options.language ?? this.language;
    if (language) {
      form.append("language_code", language);
    }
    const blob = toAudioBlob(bytes, options.mimeType ?? "audio/wav");
    form.append("file", blob, audioFileName(options.mimeType));

    const response = await this.fetchImpl(`${this.baseUrl}/speech-to-text`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        ...this.headers,
      },
      body: form,
      signal: options.signal,
    });

    if (!response.ok) {
      throw new SttError(
        `ElevenLabs transcription failed (${response.status}): ${await safeText(response)}`,
        response.status,
      );
    }

    const data = (await response.json()) as ElevenLabsResponse;
    return {
      text: (data.text ?? "").trim(),
      confidence: data.language_probability,
      language: data.language_code ?? language,
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

import { type FetchLike, formatToMimeType, trimBaseUrl } from "../voice/audio";
import {
  type TtsAdapter,
  type TtsAdapterOptions,
  TtsError,
  type TtsResult,
  type TtsSynthesizeOptions,
} from "./types";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";
// ElevenLabs uses a default multilingual voice id when none is configured.
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

const OUTPUT_FORMATS: Record<string, string> = {
  mp3: "mp3_44100_128",
  pcm: "pcm_16000",
  opus: "opus_48000_64",
};

/** ElevenLabs `/v1/text-to-speech/{voice}` adapter. */
export class ElevenLabsTtsAdapter implements TtsAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly voice: string;
  private readonly format?: TtsSynthesizeOptions["format"];
  private readonly fetchImpl: FetchLike;

  constructor(options: TtsAdapterOptions) {
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.headers = options.headers ?? {};
    this.voice = options.voice ?? DEFAULT_VOICE;
    this.format = options.format;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(options: TtsSynthesizeOptions): Promise<TtsResult> {
    const format = options.format ?? this.format ?? "mp3";
    const voice = options.voice ?? this.voice;
    const outputFormat = OUTPUT_FORMATS[format] ?? OUTPUT_FORMATS.mp3;
    const params = new URLSearchParams({ output_format: outputFormat });

    const response = await this.fetchImpl(
      `${this.baseUrl}/text-to-speech/${encodeURIComponent(voice)}?${params.toString()}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify({ text: options.text, model_id: this.model }),
        signal: options.signal,
      },
    );

    if (!response.ok) {
      throw new TtsError(
        `ElevenLabs synthesis failed (${response.status}): ${await safeText(response)}`,
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

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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type VerboseTranscription = {
  text?: string;
  language?: string;
  segments?: Array<{ avg_logprob?: number; no_speech_prob?: number }>;
};

/**
 * OpenAI `/v1/audio/transcriptions` adapter. Also drives local OpenAI-compatible
 * servers (faster-whisper-server, speaches, LocalAI) — they differ only by
 * `baseUrl` and `auth`, so a local endpoint is just `baseUrl: localhost` +
 * `apiKey: "local"`, exactly like the `ollama` LLM endpoint.
 */
export class OpenAITranscriptionsAdapter implements SttAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly language?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SttAdapterOptions) {
    this.apiKey = options.apiKey ?? "local";
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.headers = options.headers ?? {};
    this.language = options.language;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(options: SttTranscribeOptions): Promise<SttResult> {
    const bytes = toAudioBytes(options.audio);
    const form = new FormData();
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    const language = options.language ?? this.language;
    if (language) {
      form.append("language", language);
    }
    const blob = toAudioBlob(bytes, options.mimeType ?? "audio/wav");
    form.append("file", blob, audioFileName(options.mimeType));

    const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: form,
      signal: options.signal,
    });

    if (!response.ok) {
      throw new SttError(
        `OpenAI transcription failed (${response.status}): ${await safeText(response)}`,
        response.status,
      );
    }

    const data = (await response.json()) as VerboseTranscription;
    return {
      text: (data.text ?? "").trim(),
      language: data.language ?? language,
      confidence: averageConfidence(data.segments),
    };
  }
}

function averageConfidence(segments: VerboseTranscription["segments"]): number | undefined {
  if (!segments || segments.length === 0) {
    return undefined;
  }
  const probs = segments
    .map((segment) => segment.avg_logprob)
    .filter((value): value is number => typeof value === "number")
    .map((logprob) => Math.exp(logprob));
  if (probs.length === 0) {
    return undefined;
  }
  const mean = probs.reduce((sum, value) => sum + value, 0) / probs.length;
  return Math.max(0, Math.min(1, mean));
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

// Streaming TTS over the OpenAI `/v1/audio/speech` protocol — the one
// multi-implementation standard for synthesis (OpenAI cloud, Kokoro-FastAPI,
// community Qwen3-TTS servers, llama.cpp). Text is segmented into sentences
// and synthesized as sequential chunked-streaming HTTP requests; the request
// for sentence N+1 is prefetched while N's audio drains so playback never
// waits on HTTP latency between sentences. Output is raw PCM
// (`response_format: "pcm"`) at the endpoint's configured rate.

import { trimBaseUrl } from "./audio";
import { normalizeForSpeech, SentenceAssembler } from "./segment";
import {
  type FetchLike,
  type PcmFormat,
  SpeechError,
  type TtsAdapterConfig,
  type TtsProtocolAdapter,
  type TtsStream,
} from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_VOICE = "alloy";

export class OpenAISpeechStreamAdapter implements TtsProtocolAdapter {
  readonly outputFormat: PcmFormat;
  private readonly config: TtsAdapterConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: TtsAdapterConfig) {
    this.config = config;
    this.outputFormat = { encoding: "pcm16", sampleRate: config.pcmSampleRate, channels: 1 };
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  openStream(options?: { voice?: string; speed?: number; signal?: AbortSignal }): TtsStream {
    return new OpenAISpeechStream(this.config, this.fetchImpl, this.outputFormat, options);
  }
}

class OpenAISpeechStream implements TtsStream {
  readonly format: PcmFormat;

  private readonly assembler = new SentenceAssembler();
  private readonly sentences: string[] = [];
  private sentencesEnded = false;
  private wakeSentences: (() => void) | null = null;

  private readonly chunkQueue = new AsyncChunkQueue();
  private readonly abortController = new AbortController();
  private started = false;

  constructor(
    private readonly config: TtsAdapterConfig,
    private readonly fetchImpl: FetchLike,
    format: PcmFormat,
    private readonly options?: { voice?: string; speed?: number; signal?: AbortSignal },
  ) {
    this.format = format;
    options?.signal?.addEventListener("abort", () => this.abort(), { once: true });
  }

  appendText(text: string): void {
    if (this.sentencesEnded) {
      return;
    }
    // Normalization is per-append: callers currently push whole replies. A
    // future token-delta feed should normalize upstream of appendText.
    this.pushSentences(this.assembler.push(normalizeForSpeech(text)));
    this.ensureStarted();
  }

  end(): void {
    if (this.sentencesEnded) {
      return;
    }
    const rest = this.assembler.flush();
    if (rest) {
      this.pushSentences([rest]);
    }
    this.sentencesEnded = true;
    this.wakeSentences?.();
    this.ensureStarted();
  }

  chunks(): AsyncIterable<Uint8Array> {
    this.ensureStarted();
    return this.chunkQueue;
  }

  abort(): void {
    this.sentencesEnded = true;
    this.wakeSentences?.();
    this.abortController.abort();
    // Discard buffered audio too — abort means stop the voice now, not after
    // already-fetched chunks finish draining.
    this.chunkQueue.close({ discard: true });
  }

  private pushSentences(sentences: string[]): void {
    if (sentences.length === 0) {
      return;
    }
    this.sentences.push(...sentences);
    this.wakeSentences?.();
  }

  private ensureStarted(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.run();
  }

  /**
   * Sequential synthesis with one-request prefetch: requests are issued in
   * sentence order, and while sentence N's body streams out, N+1's request is
   * already in flight (when its text is known). Chunks stay strictly ordered
   * because only the current response is drained.
   */
  private async run(): Promise<void> {
    try {
      const first = await this.nextSentence();
      if (first === null) {
        this.chunkQueue.close();
        return;
      }
      let currentResponse = this.requestSentence(first);
      for (;;) {
        const prefetched = this.sentences.shift();
        const prefetchedResponse =
          prefetched !== undefined ? this.requestSentence(prefetched) : null;
        await this.drain(await currentResponse);
        if (prefetchedResponse !== null) {
          currentResponse = prefetchedResponse;
          continue;
        }
        const upcoming = await this.nextSentence();
        if (upcoming === null) {
          break;
        }
        currentResponse = this.requestSentence(upcoming);
      }
      this.chunkQueue.close();
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.chunkQueue.close();
        return;
      }
      this.chunkQueue.fail(
        error instanceof SpeechError
          ? error
          : new SpeechError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Next queued sentence; waits for appendText/end. Null when ended+drained. */
  private async nextSentence(): Promise<string | null> {
    for (;;) {
      const sentence = this.sentences.shift();
      if (sentence !== undefined) {
        return sentence;
      }
      if (this.sentencesEnded) {
        return null;
      }
      await new Promise<void>((resolve) => {
        this.wakeSentences = resolve;
      });
      this.wakeSentences = null;
    }
  }

  private requestSentence(sentence: string): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: sentence,
      voice: this.options?.voice ?? this.config.voice ?? DEFAULT_VOICE,
      response_format: "pcm",
    };
    const speed = this.options?.speed ?? this.config.speed;
    if (speed !== undefined) {
      body.speed = speed;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return this.fetchImpl(`${trimBaseUrl(this.config.baseUrl ?? DEFAULT_BASE_URL)}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });
  }

  private async drain(response: Response): Promise<void> {
    if (!response.ok) {
      throw new SpeechError(
        `Speech synthesis failed (${response.status}): ${await safeText(response)}`,
        response.status,
      );
    }
    if (!response.body) {
      return;
    }
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value && value.byteLength > 0) {
          this.chunkQueue.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Single-consumer async chunk queue backing TtsStream.chunks(). */
class AsyncChunkQueue implements AsyncIterable<Uint8Array> {
  private readonly buffered: Uint8Array[] = [];
  private done = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    if (this.done) {
      return;
    }
    this.buffered.push(chunk);
    this.wake?.();
  }

  close(options?: { discard?: boolean }): void {
    if (options?.discard) {
      this.buffered.length = 0;
    }
    this.done = true;
    this.wake?.();
  }

  fail(error: Error): void {
    if (this.done) {
      return;
    }
    this.error = error;
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const chunk = this.buffered.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (this.done) {
        if (this.error) {
          throw this.error;
        }
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

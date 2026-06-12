// Runtime-owned speech contract. The wire protocols for realtime STT and
// streaming TTS are a dialect family (OpenAI GA, vLLM, NVIDIA NIM, DashScope),
// not a single standard — so the runtime owns this semantic contract and
// protocol adapters (registered in `registry.ts`) translate to/from each wire
// format. Audio between the mic, adapters, and playback is raw PCM16LE mono.

/** Raw audio framing shared by capture, STT input, and TTS output. */
export type PcmFormat = {
  encoding: "pcm16";
  sampleRate: number;
  channels: 1;
};

export class SpeechError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export type SttSessionEvent =
  | { type: "speech_started"; itemId?: string; audioStartMs?: number }
  | { type: "speech_stopped"; itemId?: string; audioEndMs?: number }
  | { type: "partial"; itemId?: string; delta: string; text: string }
  | { type: "final"; itemId?: string; text: string; language?: string }
  | { type: "error"; message: string; fatal?: boolean }
  /**
   * Emitted exactly once per session — on local close(), remote close, or a
   * fatal transport error — so consumers can never end up pumping audio into a
   * dead session without knowing.
   */
  | { type: "closed"; cause: "local" | "remote" | "error"; code?: number; reason?: string };

export type SttSessionOptions = {
  language?: string;
  signal?: AbortSignal;
  onEvent: (event: SttSessionEvent) => void;
};

export interface SttSession {
  appendAudio(pcm16: Uint8Array): Promise<void>;
  /** Flush pending audio (protocol-specific commit); may produce a trailing final. */
  end(): Promise<void>;
  /** Idempotent. Emits closed{cause:"local"} if no closed event has fired yet. */
  close(): void;
}

export interface SttProtocolAdapter {
  /** What appendAudio expects — resolved from the endpoint's sampleRate config. */
  readonly inputFormat: PcmFormat;
  startSession(options: SttSessionOptions): Promise<SttSession>;
}

/** Resolved config a registered STT protocol factory turns into an adapter. */
export type SttAdapterConfig = {
  endpointId: string;
  /** Registry key, e.g. "realtime-stt". */
  protocol: string;
  /** Wire-format variant within the protocol, e.g. "openai" | "vllm". */
  dialect?: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  language?: string;
  sampleRate: number;
  /** Injectable WebSocket for tests; defaults to the global WebSocket. */
  webSocketCtor?: WebSocketConstructorLike;
};

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

/**
 * One synthesis stream. Text goes in incrementally (today callers push the
 * complete reply in one appendText; the contract is incremental so a future
 * token-stream tap needs no adapter changes), ordered PCM chunks come out.
 */
export interface TtsStream {
  readonly format: PcmFormat;
  appendText(text: string): void;
  /** No more text; chunks() completes once buffered synthesis drains. */
  end(): void;
  /** Ordered audio chunks. Single consumer; completes after end() + drain. */
  chunks(): AsyncIterable<Uint8Array>;
  /** Cancel in-flight synthesis and terminate chunks() early. */
  abort(): void;
}

export interface TtsProtocolAdapter {
  readonly outputFormat: PcmFormat;
  openStream(options?: { voice?: string; speed?: number; signal?: AbortSignal }): TtsStream;
}

/** Resolved config a registered TTS protocol factory turns into an adapter. */
export type TtsAdapterConfig = {
  endpointId: string;
  /** Registry key, e.g. "openai-speech". */
  protocol: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  voice?: string;
  speed?: number;
  pcmSampleRate: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
};

// ---------------------------------------------------------------------------
// WebSocket structural types (injectable for tests; Bun's WebSocket satisfies
// them). Adapters must use these rather than depending on a global.
// ---------------------------------------------------------------------------

export type WebSocketConstructorLike = new (
  url: string,
  protocolsOrOptions?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

export type WebSocketLike = {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

// Realtime transcription over WebSocket: one session core for the whole
// OpenAI-Realtime-like dialect family. Dialect maps (./dialects.ts) translate
// payloads and event names; this file owns the socket lifecycle, auth, audio
// framing, and the guarantee that every session emits exactly one `closed`
// event — a consumer can never keep pumping audio into a dead socket unknowingly.

import WebSocket from "ws";

import { toBase64 } from "../../../../../speech/audio";
import { once, waitForOpen } from "../../../../../speech/streaming";
import {
  SpeechError,
  type SttAdapterConfig,
  type SttProtocolAdapter,
  type SttSession,
  type SttSessionEvent,
  type SttSessionOptions,
  type WebSocketConstructorLike,
  type WebSocketLike,
} from "../../../../../speech/types";
import {
  type RealtimeServerEvent,
  type RealtimeSttDialect,
  resolveRealtimeSttDialect,
} from "./dialects";

const DEFAULT_BASE_URL = "wss://api.openai.com/v1/realtime";

export class RealtimeSttAdapter implements SttProtocolAdapter {
  readonly inputFormat;

  private readonly dialect: RealtimeSttDialect;
  private readonly config: SttAdapterConfig;
  private readonly webSocketCtor: WebSocketConstructorLike;

  constructor(config: SttAdapterConfig) {
    this.config = config;
    this.dialect = resolveRealtimeSttDialect(config.dialect);
    this.inputFormat = { encoding: "pcm16", sampleRate: config.sampleRate, channels: 1 } as const;
    const webSocketCtor =
      config.webSocketCtor ?? (WebSocket as unknown as WebSocketConstructorLike | undefined);
    if (!webSocketCtor) {
      throw new SpeechError("Realtime transcription requires a WebSocket implementation.");
    }
    this.webSocketCtor = webSocketCtor;
  }

  async startSession(options: SttSessionOptions): Promise<SttSession> {
    if (options.signal?.aborted) {
      throw new SpeechError("WebSocket connection was cancelled.");
    }
    const headers: Record<string, string> = { ...this.config.headers };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const url = this.dialect.connectUrl(this.config.baseUrl ?? DEFAULT_BASE_URL);
    const socket = new this.webSocketCtor(url, { headers, followRedirects: false });
    await waitForOpen(socket, options.signal);
    if (new URL(socket.url).origin !== new URL(url).origin) {
      socket.close(1008, "Speech endpoint origin changed during connection.");
      throw new SpeechError("Realtime transcription refused a cross-origin WebSocket redirect.");
    }

    const session = new RealtimeSttSession(socket, this.dialect, options.onEvent);
    session.configure({
      model: this.config.model,
      language: options.language ?? this.config.language,
      sampleRate: this.config.sampleRate,
    });
    options.signal?.addEventListener("abort", () => session.close(), { once: true });
    return session;
  }
}

class RealtimeSttSession implements SttSession {
  private readonly state = { text: "" };
  private closed = false;
  private readonly emitClosed = once((event: Extract<SttSessionEvent, { type: "closed" }>) =>
    this.onEvent(event),
  );

  constructor(
    private readonly socket: WebSocketLike,
    private readonly dialect: RealtimeSttDialect,
    private readonly onEvent: (event: SttSessionEvent) => void,
  ) {
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
    this.socket.addEventListener("error", this.handleError);
  }

  configure(options: { model: string; language?: string; sampleRate: number }): void {
    this.send(this.dialect.sessionUpdate(options));
  }

  async appendAudio(pcm16: Uint8Array): Promise<void> {
    if (this.closed || pcm16.byteLength === 0) {
      return;
    }
    this.send({ type: "input_audio_buffer.append", audio: toBase64(pcm16) });
  }

  async end(): Promise<void> {
    const commit = this.dialect.commitMessage();
    if (commit) {
      this.send(commit);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Detach before closing so the socket's own close event can't race a
    // `remote` cause in ahead of the `local` one.
    this.detach();
    this.socket.close();
    this.emitClosed({ type: "closed", cause: "local" });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  private detach(): void {
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    this.socket.removeEventListener("error", this.handleError);
  }

  private handleMessage = (event: MessageEvent): void => {
    let data: RealtimeServerEvent;
    try {
      data = JSON.parse(String(event.data)) as RealtimeServerEvent;
    } catch {
      this.onEvent({ type: "error", message: "Realtime transcription returned invalid JSON." });
      return;
    }
    const mapped = this.dialect.mapEvent(data, this.state);
    if (mapped) {
      this.onEvent(mapped);
    }
  };

  private handleClose = (event: CloseEvent): void => {
    this.closed = true;
    this.emitClosed({
      type: "closed",
      cause: "remote",
      code: event?.code,
      reason: event?.reason || undefined,
    });
    this.detach();
  };

  private handleError = (): void => {
    this.closed = true;
    this.emitClosed({ type: "closed", cause: "error" });
    this.detach();
  };
}

import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { SloppyConfig } from "../../../config/schema";
import { ProviderApprovalManager } from "../../../providers/approvals";
import {
  createVoiceAdapters,
  type SttAdapter,
  type TtsAdapter,
  type VoiceAdapterMap,
  type VoiceFormat,
  voiceMimeForFormat,
} from "./adapters";

type VoicePluginConfig = SloppyConfig["plugins"]["voice"];

type VoiceStream = {
  id: string;
  token: string;
  status: "open" | "transcribing" | "closed" | "cancelled" | "error";
  created_at: string;
  updated_at: string;
  expires_at: string;
  mime: string;
  bytes_received: number;
  task_id?: string;
  transcript_id?: string;
  error?: string;
};

type VoiceTranscript = {
  id: string;
  stream_id: string;
  text: string;
  status: "final";
  created_at: string;
};

type VoiceSegment = {
  id: string;
  text: string;
  status: "synthesizing" | "ready" | "error" | "cancelled";
  created_at: string;
  completed_at?: string;
  model: string;
  voice: string;
  format: VoiceFormat;
  mime: string;
  size?: number;
  audio?: Uint8Array;
  error?: string;
  message_id?: string;
  task_id: string;
};

type VoiceTask = {
  id: string;
  kind: "transcription" | "synthesis";
  status: "running" | "done" | "failed" | "cancelled";
  message: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  stream_id?: string;
  segment_id?: string;
  error?: string;
  abortController: AbortController;
};

type VoiceProviderOptions = {
  config: VoicePluginConfig;
  adapters?: Partial<VoiceAdapterMap>;
};

const STREAM_TTL_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalFormat(value: unknown): VoiceFormat | undefined {
  return value === "mp3" ||
    value === "opus" ||
    value === "aac" ||
    value === "flac" ||
    value === "wav" ||
    value === "pcm"
    ? value
    : undefined;
}

function contentRefForSegment(segment: VoiceSegment) {
  return {
    type: "binary" as const,
    mime: segment.mime,
    size: segment.size,
    uri: `slop://voice/output/segments/${segment.id}/audio`,
    summary: `Synthesized speech for ${segment.text.length} characters using ${segment.model}/${segment.voice}.`,
  };
}

export class VoiceProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private readonly config: VoicePluginConfig;
  private readonly sttAdapters: Map<string, SttAdapter>;
  private readonly ttsAdapters: Map<string, TtsAdapter>;
  private readonly streams = new Map<string, VoiceStream>();
  private readonly transcripts = new Map<string, VoiceTranscript>();
  private readonly segments = new Map<string, VoiceSegment>();
  private readonly tasks = new Map<string, VoiceTask>();
  private readonly mediaServer: ReturnType<typeof Bun.serve>;
  private readonly mediaBaseUrl: string;
  private inputAdapterId: string;
  private inputModel: string;
  private inputLanguage: string;
  private inputState: "idle" | "listening" | "transcribing" | "ready" | "error" = "idle";
  private inputPartialText = "";
  private inputFinalText = "";
  private inputLastError: string | undefined;
  private activeStreamId: string | undefined;
  private outputAdapterId: string;
  private outputModel: string;
  private outputVoice: string;
  private outputFormat: VoiceFormat;
  private outputState: "idle" | "synthesizing" | "ready" | "error" = "idle";
  private outputLastError: string | undefined;
  private activeSegmentId: string | undefined;

  constructor(options: VoiceProviderOptions) {
    this.config = options.config;
    const configuredAdapters = createVoiceAdapters(options.config.adapters);
    this.sttAdapters = options.adapters?.stt ?? configuredAdapters.stt;
    this.ttsAdapters = options.adapters?.tts ?? configuredAdapters.tts;
    this.inputAdapterId = options.config.input.adapterId;
    this.inputModel = options.config.input.model;
    this.inputLanguage = options.config.input.language;
    this.outputAdapterId = options.config.output.adapterId;
    this.outputModel = options.config.output.model;
    this.outputVoice = options.config.output.voice;
    this.outputFormat = options.config.output.format;

    this.server = createSlopServer({
      id: "voice",
      name: "Voice",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.mediaServer = Bun.serve({
      hostname: options.config.media.host,
      port: options.config.media.port,
      fetch: (request) => this.handleMediaRequest(request),
    });
    this.mediaBaseUrl = `http://${options.config.media.host}:${this.mediaServer.port}`;

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("input", () => this.buildInputDescriptor());
    this.server.register("transcripts", () => this.buildTranscriptsDescriptor());
    this.server.register("output", () => this.buildOutputDescriptor());
    this.server.register("output/segments", () => this.buildSegmentsDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.mediaServer.stop(true);
    this.server.stop();
  }

  private get sttAdapter(): SttAdapter {
    const adapter = this.sttAdapters.get(this.inputAdapterId);
    if (!adapter) {
      throw new Error(`Unknown voice input adapter: ${this.inputAdapterId}`);
    }
    return adapter;
  }

  private get ttsAdapter(): TtsAdapter {
    const adapter = this.ttsAdapters.get(this.outputAdapterId);
    if (!adapter) {
      throw new Error(`Unknown voice output adapter: ${this.outputAdapterId}`);
    }
    return adapter;
  }

  private refresh(): void {
    this.server.refresh();
  }

  private createTask(kind: VoiceTask["kind"], message: string): VoiceTask {
    const time = nowIso();
    const task: VoiceTask = {
      id: `voice-${kind}-${crypto.randomUUID()}`,
      kind,
      status: "running",
      message,
      started_at: time,
      updated_at: time,
      abortController: new AbortController(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  private completeTask(task: VoiceTask, message: string): void {
    const time = nowIso();
    task.status = "done";
    task.message = message;
    task.updated_at = time;
    task.completed_at = time;
  }

  private failTask(task: VoiceTask, error: string): void {
    const time = nowIso();
    task.status = "failed";
    task.message = error;
    task.error = error;
    task.updated_at = time;
    task.completed_at = time;
  }

  private cancelTask(taskId: string): { task_id: string; status: string } {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown voice task: ${taskId}`);
    }
    if (task.status === "running") {
      task.abortController.abort();
      const time = nowIso();
      task.status = "cancelled";
      task.message = "Cancelled";
      task.updated_at = time;
      task.completed_at = time;
      const stream = task.stream_id ? this.streams.get(task.stream_id) : undefined;
      if (stream?.status === "transcribing") {
        stream.status = "cancelled";
        stream.updated_at = time;
      }
      const segment = task.segment_id ? this.segments.get(task.segment_id) : undefined;
      if (segment?.status === "synthesizing") {
        segment.status = "cancelled";
        segment.completed_at = time;
      }
    }
    this.refresh();
    return { task_id: taskId, status: task.status };
  }

  private async handleMediaRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const match = url.pathname.match(/^\/streams\/([^/]+)\/audio$/);
    if (request.method !== "POST" || !match?.[1]) {
      return new Response("Not found", { status: 404 });
    }

    const stream = this.streams.get(match[1]);
    if (!stream) {
      return Response.json({ error: "unknown_stream" }, { status: 404 });
    }
    if (!this.authorizeStreamUpload(request, url, stream)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (stream.status !== "open") {
      return Response.json({ error: `stream_${stream.status}` }, { status: 409 });
    }
    if (Date.parse(stream.expires_at) < Date.now()) {
      stream.status = "closed";
      stream.updated_at = nowIso();
      this.refresh();
      return Response.json({ error: "stream_expired" }, { status: 410 });
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > this.config.media.maxUploadBytes) {
      return Response.json({ error: "upload_too_large" }, { status: 413 });
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > this.config.media.maxUploadBytes) {
      return Response.json({ error: "upload_too_large" }, { status: 413 });
    }

    const partialText = request.headers.get("x-sloppy-partial-text");
    if (partialText) {
      this.inputPartialText = partialText;
    }

    try {
      const transcript = await this.transcribeUpload(
        stream,
        bytes,
        request.headers.get("content-type") ?? stream.mime,
      );
      return Response.json({
        status: "ok",
        transcript_id: transcript.id,
        text: transcript.text,
      });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  private authorizeStreamUpload(request: Request, url: URL, stream: VoiceStream): boolean {
    const authorization = request.headers.get("authorization");
    if (authorization === `Bearer ${stream.token}`) {
      return true;
    }
    return url.searchParams.get("token") === stream.token;
  }

  private openStream(mime = "audio/wav"): Record<string, unknown> {
    if (!this.sttAdapters.has(this.inputAdapterId)) {
      throw new Error(`Voice input adapter '${this.inputAdapterId}' is not available.`);
    }

    const id = crypto.randomUUID();
    const token = randomToken();
    const time = nowIso();
    const expiresAt = new Date(Date.now() + STREAM_TTL_MS).toISOString();
    const stream: VoiceStream = {
      id,
      token,
      status: "open",
      created_at: time,
      updated_at: time,
      expires_at: expiresAt,
      mime,
      bytes_received: 0,
    };
    this.streams.set(id, stream);
    this.activeStreamId = id;
    this.inputState = "listening";
    this.inputPartialText = "";
    this.inputFinalText = "";
    this.inputLastError = undefined;
    this.refresh();

    return {
      stream_id: id,
      upload_url: `${this.mediaBaseUrl}/streams/${id}/audio`,
      token,
      expires_at: expiresAt,
      max_upload_bytes: this.config.media.maxUploadBytes,
      mime,
    };
  }

  private closeStream(streamId?: string): { stream_id: string; status: string } {
    const id = streamId ?? this.activeStreamId;
    if (!id) {
      throw new Error("No active voice input stream.");
    }
    const stream = this.streams.get(id);
    if (!stream) {
      throw new Error(`Unknown voice input stream: ${id}`);
    }
    if (stream.status === "open") {
      stream.status = "closed";
      stream.updated_at = nowIso();
    }
    if (this.activeStreamId === id) {
      this.activeStreamId = undefined;
    }
    if (this.inputState === "listening") {
      this.inputState = "idle";
    }
    this.refresh();
    return { stream_id: id, status: stream.status };
  }

  private cancelStream(streamId?: string): { stream_id: string; status: string } {
    const id = streamId ?? this.activeStreamId;
    if (!id) {
      throw new Error("No active voice input stream.");
    }
    const stream = this.streams.get(id);
    if (!stream) {
      throw new Error(`Unknown voice input stream: ${id}`);
    }
    if (stream.task_id) {
      this.cancelTask(stream.task_id);
    }
    stream.status = "cancelled";
    stream.updated_at = nowIso();
    if (this.activeStreamId === id) {
      this.activeStreamId = undefined;
    }
    this.inputState = "idle";
    this.refresh();
    return { stream_id: id, status: stream.status };
  }

  private async transcribeUpload(
    stream: VoiceStream,
    bytes: Uint8Array,
    mime: string,
  ): Promise<VoiceTranscript> {
    const task = this.createTask("transcription", "Transcribing voice input");
    task.stream_id = stream.id;
    const time = nowIso();
    stream.status = "transcribing";
    stream.updated_at = time;
    stream.bytes_received = bytes.byteLength;
    stream.task_id = task.id;
    this.inputState = "transcribing";
    this.inputLastError = undefined;
    this.refresh();

    try {
      const result = await this.sttAdapter.transcribe({
        audio: bytes,
        mime,
        model: this.inputModel,
        language: this.inputLanguage,
        signal: task.abortController.signal,
      });
      const transcript: VoiceTranscript = {
        id: crypto.randomUUID(),
        stream_id: stream.id,
        text: result.text,
        status: "final",
        created_at: nowIso(),
      };
      this.transcripts.set(transcript.id, transcript);
      stream.status = "closed";
      stream.transcript_id = transcript.id;
      stream.updated_at = transcript.created_at;
      this.inputState = "ready";
      this.inputFinalText = transcript.text;
      this.inputPartialText = "";
      if (this.activeStreamId === stream.id) {
        this.activeStreamId = undefined;
      }
      this.completeTask(task, "Transcription ready");
      this.refresh();
      return transcript;
    } catch (error) {
      const message = errorMessage(error);
      stream.status = task.status === "cancelled" ? "cancelled" : "error";
      stream.error = message;
      stream.updated_at = nowIso();
      this.inputState = "error";
      this.inputLastError = message;
      this.failTask(task, message);
      this.refresh();
      throw error;
    }
  }

  private clearInput(): { status: string } {
    this.inputState = "idle";
    this.inputPartialText = "";
    this.inputFinalText = "";
    this.inputLastError = undefined;
    this.activeStreamId = undefined;
    this.refresh();
    return { status: "cleared" };
  }

  private setInputAdapter(params: Record<string, unknown>): Record<string, unknown> {
    const adapterId = optionalString(params.adapter_id);
    if (!adapterId) {
      throw new Error("adapter_id is required.");
    }
    if (!this.sttAdapters.has(adapterId)) {
      throw new Error(`Unknown voice STT adapter: ${adapterId}`);
    }
    this.inputAdapterId = adapterId;
    this.inputModel = optionalString(params.model) ?? this.inputModel;
    this.inputLanguage = optionalString(params.language) ?? this.inputLanguage;
    this.refresh();
    return {
      adapter_id: this.inputAdapterId,
      model: this.inputModel,
      language: this.inputLanguage,
    };
  }

  private setOutputAdapter(params: Record<string, unknown>): Record<string, unknown> {
    const adapterId = optionalString(params.adapter_id);
    if (!adapterId) {
      throw new Error("adapter_id is required.");
    }
    if (!this.ttsAdapters.has(adapterId)) {
      throw new Error(`Unknown voice TTS adapter: ${adapterId}`);
    }
    this.outputAdapterId = adapterId;
    this.outputModel = optionalString(params.model) ?? this.outputModel;
    const format = optionalFormat(params.format);
    if (format) {
      this.outputFormat = format;
    }
    this.refresh();
    return {
      adapter_id: this.outputAdapterId,
      model: this.outputModel,
      format: this.outputFormat,
    };
  }

  private setVoice(voice: string): Record<string, unknown> {
    this.outputVoice = voice;
    this.refresh();
    return { voice: this.outputVoice };
  }

  private async synthesize(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const text = optionalString(params.text);
    if (!text) {
      throw new Error("text is required.");
    }
    if (!this.ttsAdapters.has(this.outputAdapterId)) {
      throw new Error(`Voice output adapter '${this.outputAdapterId}' is not available.`);
    }

    const task = this.createTask("synthesis", "Synthesizing assistant speech");
    const time = nowIso();
    const format = optionalFormat(params.format) ?? this.outputFormat;
    const segment: VoiceSegment = {
      id: crypto.randomUUID(),
      text,
      status: "synthesizing",
      created_at: time,
      model: optionalString(params.model) ?? this.outputModel,
      voice: optionalString(params.voice) ?? this.outputVoice,
      format,
      mime: voiceMimeForFormat(format),
      message_id: optionalString(params.message_id),
      task_id: task.id,
    };
    task.segment_id = segment.id;
    this.segments.set(segment.id, segment);
    this.outputState = "synthesizing";
    this.outputLastError = undefined;
    this.activeSegmentId = segment.id;
    this.refresh();

    try {
      const result = await this.ttsAdapter.synthesize({
        text,
        model: segment.model,
        voice: segment.voice,
        format: segment.format,
        instructions: optionalString(params.instructions),
        signal: task.abortController.signal,
      });
      segment.status = "ready";
      segment.audio = result.audio;
      segment.mime = result.mime;
      segment.format = result.format;
      segment.size = result.audio.byteLength;
      segment.completed_at = nowIso();
      this.outputState = "ready";
      this.completeTask(task, "Speech segment ready");
      this.refresh();
      return {
        segment_id: segment.id,
        status: segment.status,
        content_ref: contentRefForSegment(segment),
      };
    } catch (error) {
      const message = errorMessage(error);
      segment.status = task.status === "cancelled" ? "cancelled" : "error";
      segment.error = message;
      segment.completed_at = nowIso();
      this.outputState = "error";
      this.outputLastError = message;
      this.failTask(task, message);
      this.refresh();
      throw error;
    }
  }

  private cancelOutput(): { status: string; segment_id?: string } {
    if (!this.activeSegmentId) {
      this.outputState = "idle";
      this.refresh();
      return { status: "idle" };
    }
    const segment = this.segments.get(this.activeSegmentId);
    if (segment && segment.status === "synthesizing") {
      this.cancelTask(segment.task_id);
    }
    this.outputState = "idle";
    this.activeSegmentId = undefined;
    this.refresh();
    return { status: "idle", segment_id: segment?.id };
  }

  private readSegmentContent(segmentId: string): Record<string, unknown> {
    const segment = this.segments.get(segmentId);
    if (!segment) {
      throw new Error(`Unknown voice output segment: ${segmentId}`);
    }
    if (!segment.audio) {
      throw new Error(`Voice output segment '${segmentId}' has no ready audio content.`);
    }
    return {
      segment_id: segment.id,
      mime: segment.mime,
      encoding: "base64",
      content: Buffer.from(segment.audio).toString("base64"),
      size: segment.audio.byteLength,
    };
  }

  private buildSessionDescriptor() {
    return {
      type: "context",
      props: {
        status: "ready",
        media_endpoint: this.mediaBaseUrl,
        media_host: this.config.media.host,
        media_port: this.mediaServer.port,
        max_upload_bytes: this.config.media.maxUploadBytes,
        input_adapter_id: this.inputAdapterId,
        output_adapter_id: this.outputAdapterId,
        active_stream_id: this.activeStreamId,
        active_segment_id: this.activeSegmentId,
        transcript_count: this.transcripts.size,
        segment_count: this.segments.size,
      },
      summary: "Voice pipeline provider: STT/TTS adapter state and media side-channel controls.",
      meta: {
        focus: true,
        salience: 0.85,
      },
    };
  }

  private buildInputDescriptor() {
    return {
      type: "control",
      props: {
        state: this.inputState,
        active_adapter_id: this.inputAdapterId,
        active_model: this.inputModel,
        language: this.inputLanguage,
        available_adapters: [...this.sttAdapters.keys()],
        active_stream_id: this.activeStreamId,
        partial_text: this.inputPartialText,
        final_text: this.inputFinalText,
        last_error: this.inputLastError,
      },
      summary:
        "Speech-to-text input control. Consumer UIs own microphone capture and upload audio through open_stream details.",
      actions: {
        open_stream: action(
          {
            mime: {
              type: "string",
              optional: true,
              description: "Audio MIME type for the upload. Defaults to audio/wav.",
            },
          },
          async ({ mime }) => this.openStream(optionalString(mime) ?? "audio/wav"),
          {
            label: "Open Voice Input Stream",
            description:
              "Create a short-lived loopback upload endpoint for microphone audio captured by a consumer UI.",
            estimate: "instant",
          },
        ),
        close_stream: action(
          {
            stream_id: {
              type: "string",
              optional: true,
              description: "Stream id. Defaults to the active stream.",
            },
          },
          async ({ stream_id }) => this.closeStream(optionalString(stream_id)),
          {
            label: "Close Voice Input Stream",
            description: "Close an open voice input stream without transcribing more audio.",
            estimate: "instant",
          },
        ),
        cancel_stream: action(
          {
            stream_id: {
              type: "string",
              optional: true,
              description: "Stream id. Defaults to the active stream.",
            },
          },
          async ({ stream_id }) => this.cancelStream(optionalString(stream_id)),
          {
            label: "Cancel Voice Input Stream",
            description: "Cancel an open or transcribing voice input stream.",
            estimate: "fast",
          },
        ),
        clear: action(async () => this.clearInput(), {
          label: "Clear Voice Input",
          description: "Clear visible partial/final transcript state.",
          estimate: "instant",
        }),
        set_adapter: action(
          {
            adapter_id: "string",
            model: {
              type: "string",
              optional: true,
              description: "Session-local STT model override.",
            },
            language: {
              type: "string",
              optional: true,
              description: "Session-local language override. Use auto to omit provider language.",
            },
          },
          async (params) => this.setInputAdapter(params),
          {
            label: "Set STT Adapter",
            description: "Switch the session-local speech-to-text adapter/model.",
            estimate: "instant",
          },
        ),
      },
      meta: {
        salience: this.inputState === "idle" ? 0.5 : 0.9,
      },
    };
  }

  private buildTranscriptsDescriptor() {
    const items: ItemDescriptor[] = [...this.transcripts.values()].map((transcript) => ({
      id: transcript.id,
      props: {
        id: transcript.id,
        stream_id: transcript.stream_id,
        text: transcript.text,
        status: transcript.status,
        created_at: transcript.created_at,
      },
      summary: transcript.text.slice(0, 160),
      meta: {
        salience: 0.75,
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Finalized voice input transcripts ready for consumer UI submission.",
      items,
    };
  }

  private buildOutputDescriptor() {
    return {
      type: "control",
      props: {
        state: this.outputState,
        active_adapter_id: this.outputAdapterId,
        active_model: this.outputModel,
        voice: this.outputVoice,
        format: this.outputFormat,
        available_adapters: [...this.ttsAdapters.keys()],
        active_segment_id: this.activeSegmentId,
        last_error: this.outputLastError,
      },
      summary:
        "Text-to-speech output control. Consumer UIs own speaker playback and fetch synthesized audio from content refs.",
      actions: {
        synthesize: action(
          {
            text: "string",
            message_id: {
              type: "string",
              optional: true,
              description: "Optional assistant transcript message id that produced this speech.",
            },
            voice: {
              type: "string",
              optional: true,
              description: "Session-local voice override for this segment.",
            },
            model: {
              type: "string",
              optional: true,
              description: "Session-local TTS model override for this segment.",
            },
            format: {
              type: "string",
              optional: true,
              description: "Audio format: mp3, opus, aac, flac, wav, or pcm.",
            },
            instructions: {
              type: "string",
              optional: true,
              description: "Optional provider-specific voice instructions.",
            },
          },
          async (params) => this.synthesize(params),
          {
            label: "Synthesize Speech",
            description:
              "Turn text into a speech segment. Returns a content ref for the synthesized audio.",
            estimate: "slow",
          },
        ),
        cancel: action(async () => this.cancelOutput(), {
          label: "Cancel Speech Output",
          description: "Cancel the active speech synthesis task if one is running.",
          estimate: "fast",
        }),
        set_adapter: action(
          {
            adapter_id: "string",
            model: {
              type: "string",
              optional: true,
              description: "Session-local TTS model override.",
            },
            format: {
              type: "string",
              optional: true,
              description: "Session-local audio format override.",
            },
          },
          async (params) => this.setOutputAdapter(params),
          {
            label: "Set TTS Adapter",
            description: "Switch the session-local text-to-speech adapter/model.",
            estimate: "instant",
          },
        ),
        set_voice: action({ voice: "string" }, async ({ voice }) => this.setVoice(String(voice)), {
          label: "Set TTS Voice",
          description: "Switch the session-local TTS voice.",
          estimate: "instant",
        }),
      },
      meta: {
        salience: this.outputState === "idle" ? 0.5 : 0.85,
      },
    };
  }

  private buildSegmentsDescriptor() {
    const items: ItemDescriptor[] = [...this.segments.values()].map((segment) => ({
      id: segment.id,
      props: {
        id: segment.id,
        text: segment.text,
        status: segment.status,
        created_at: segment.created_at,
        completed_at: segment.completed_at,
        model: segment.model,
        voice: segment.voice,
        format: segment.format,
        mime: segment.mime,
        size: segment.size,
        message_id: segment.message_id,
        task_id: segment.task_id,
        error: segment.error,
      },
      summary:
        segment.status === "ready"
          ? `Speech segment ready (${segment.size ?? 0} bytes).`
          : `Speech segment ${segment.status}.`,
      contentRef: segment.status === "ready" ? contentRefForSegment(segment) : undefined,
      actions:
        segment.status === "ready"
          ? {
              read_content: action(async () => this.readSegmentContent(segment.id), {
                label: "Read Audio Content",
                description: "Return synthesized audio as base64 content.",
                idempotent: true,
                estimate: "fast",
              }),
            }
          : undefined,
      meta: {
        salience: segment.status === "ready" ? 0.75 : 0.55,
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Synthesized speech output segments.",
      items,
    };
  }

  private buildTasksDescriptor() {
    const items: ItemDescriptor[] = [...this.tasks.values()].map((task) => ({
      id: task.id,
      props: {
        id: task.id,
        kind: task.kind,
        status: task.status,
        message: task.message,
        started_at: task.started_at,
        updated_at: task.updated_at,
        completed_at: task.completed_at,
        stream_id: task.stream_id,
        segment_id: task.segment_id,
        error: task.error,
      },
      summary: task.message,
      actions:
        task.status === "running"
          ? {
              cancel: action(async () => this.cancelTask(task.id), {
                label: "Cancel Voice Task",
                description: "Cancel this voice task.",
                estimate: "fast",
              }),
            }
          : undefined,
      meta: {
        salience: task.status === "running" ? 0.85 : 0.45,
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
        running_count: items.filter((item) => item.props?.status === "running").length,
      },
      summary: "Voice transcription and synthesis tasks.",
      items,
    };
  }
}

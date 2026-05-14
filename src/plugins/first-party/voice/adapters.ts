import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenAI from "openai";

import type { SloppyConfig } from "../../../config/schema";

export type VoiceAdapterConfig = SloppyConfig["plugins"]["voice"]["adapters"][string];
export type VoiceFormat = SloppyConfig["plugins"]["voice"]["output"]["format"];

export type SttRequest = {
  audio: Uint8Array;
  mime: string;
  model: string;
  language?: string;
  signal?: AbortSignal;
};

export type SttResult = {
  text: string;
};

export type TtsRequest = {
  text: string;
  model: string;
  voice: string;
  format: VoiceFormat;
  instructions?: string;
  signal?: AbortSignal;
};

export type TtsResult = {
  audio: Uint8Array;
  mime: string;
  format: VoiceFormat;
};

export interface SttAdapter {
  readonly id: string;
  readonly kind: "openai-transcribe" | "local-stt-command";
  transcribe(request: SttRequest): Promise<SttResult>;
}

export interface TtsAdapter {
  readonly id: string;
  readonly kind: "openai-tts" | "local-tts-command";
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

export type VoiceAdapterMap = {
  stt: Map<string, SttAdapter>;
  tts: Map<string, TtsAdapter>;
};

function mimeForFormat(format: VoiceFormat): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/opus";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/pcm";
    case "wav":
      return "audio/wav";
  }
}

function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("m4a")) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("wav")) return "wav";
  return "audio";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function expandCommandArgs(args: string[], replacements: Record<string, string>): string[] {
  return args.map((arg) =>
    Object.entries(replacements).reduce(
      (value, [key, replacement]) => value.replaceAll(`{${key}}`, replacement),
      arg,
    ),
  );
}

async function runCommand(
  args: string[],
  cwd = process.cwd(),
): Promise<{
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}> {
  const [command, ...commandArgs] = args;
  if (!command) {
    throw new Error("Voice adapter command cannot be empty.");
  }

  const proc = Bun.spawn([command, ...commandArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: new Uint8Array(stdout),
    stderr: stderrText,
    exitCode,
  };
}

class OpenAiTranscribeAdapter implements SttAdapter {
  readonly kind = "openai-transcribe";

  constructor(
    readonly id: string,
    private readonly apiKeyEnv: string,
  ) {}

  async transcribe(request: SttRequest): Promise<SttResult> {
    const apiKey = Bun.env[this.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Voice STT adapter '${this.id}' requires ${this.apiKeyEnv}.`);
    }

    const client = new OpenAI({ apiKey });
    const extension = extensionForMime(request.mime);
    const file = new File([toArrayBuffer(request.audio)], `speech.${extension}`, {
      type: request.mime,
    });
    const result = await client.audio.transcriptions.create(
      {
        file,
        model: request.model,
        response_format: "json",
        ...(request.language && request.language !== "auto" ? { language: request.language } : {}),
      },
      { signal: request.signal },
    );

    return { text: result.text.trim() };
  }
}

class OpenAiTtsAdapter implements TtsAdapter {
  readonly kind = "openai-tts";

  constructor(
    readonly id: string,
    private readonly apiKeyEnv: string,
  ) {}

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = Bun.env[this.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Voice TTS adapter '${this.id}' requires ${this.apiKeyEnv}.`);
    }

    const client = new OpenAI({ apiKey });
    const response = await client.audio.speech.create(
      {
        model: request.model,
        voice: request.voice,
        input: request.text,
        response_format: request.format,
        ...(request.instructions ? { instructions: request.instructions } : {}),
      },
      { signal: request.signal },
    );

    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      mime: mimeForFormat(request.format),
      format: request.format,
    };
  }
}

class LocalSttCommandAdapter implements SttAdapter {
  readonly kind = "local-stt-command";

  constructor(
    readonly id: string,
    private readonly command: string[],
  ) {}

  async transcribe(request: SttRequest): Promise<SttResult> {
    const dir = await mkdtemp(join(tmpdir(), "sloppy-voice-stt-"));
    const inputPath = join(dir, `input.${extensionForMime(request.mime)}`);
    try {
      await Bun.write(inputPath, request.audio);
      const expanded = expandCommandArgs(this.command, {
        input: inputPath,
        model: request.model,
        language: request.language ?? "auto",
      });
      const result = await runCommand(expanded);
      if (result.exitCode !== 0) {
        throw new Error(`Local STT adapter '${this.id}' failed: ${result.stderr.trim()}`);
      }

      const text = new TextDecoder().decode(result.stdout).trim();
      return { text };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

class LocalTtsCommandAdapter implements TtsAdapter {
  readonly kind = "local-tts-command";

  constructor(
    readonly id: string,
    private readonly command: string[],
  ) {}

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const dir = await mkdtemp(join(tmpdir(), "sloppy-voice-tts-"));
    const outputPath = join(dir, `output.${request.format}`);
    try {
      const expanded = expandCommandArgs(this.command, {
        text: request.text,
        output: outputPath,
        model: request.model,
        voice: request.voice,
        format: request.format,
      });
      const result = await runCommand(expanded);
      if (result.exitCode !== 0) {
        throw new Error(`Local TTS adapter '${this.id}' failed: ${result.stderr.trim()}`);
      }

      const outputFile = Bun.file(outputPath);
      const audio = (await outputFile.exists())
        ? new Uint8Array(await readFile(outputPath))
        : result.stdout;
      return {
        audio,
        mime: mimeForFormat(request.format),
        format: request.format,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function createVoiceAdapters(
  adapters: SloppyConfig["plugins"]["voice"]["adapters"],
): VoiceAdapterMap {
  const stt = new Map<string, SttAdapter>();
  const tts = new Map<string, TtsAdapter>();

  for (const [id, config] of Object.entries(adapters)) {
    switch (config.kind) {
      case "openai-transcribe":
        stt.set(id, new OpenAiTranscribeAdapter(id, config.apiKeyEnv));
        break;
      case "openai-tts":
        tts.set(id, new OpenAiTtsAdapter(id, config.apiKeyEnv));
        break;
      case "local-stt-command":
        stt.set(id, new LocalSttCommandAdapter(id, config.command));
        break;
      case "local-tts-command":
        tts.set(id, new LocalTtsCommandAdapter(id, config.command));
        break;
    }
  }

  return { stt, tts };
}

export function voiceMimeForFormat(format: VoiceFormat): string {
  return mimeForFormat(format);
}

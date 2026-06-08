import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { VoiceConversationPluginConfig } from "../../../config/schema";

/** A captured/synthesized audio clip carried across the loop as base64. */
export type CapturedAudio = {
  audioBase64: string;
  mimeType: string;
};

/**
 * Where the conversation loop's audio comes from and goes to. Both ends are
 * deliberately behind one interface so the loop is identical whether audio is
 * the local machine (dev / pre-hardware) or the robot's mic and speaker.
 */
export interface AudioBackend {
  /**
   * Record one utterance, ending on silence (VAD). Resolves to the clip, or
   * null when nothing was captured (timeout / empty) so the caller can re-arm.
   */
  captureUtterance(signal?: AbortSignal): Promise<CapturedAudio | null>;
  /** Play a clip to completion (so callers can animate for its duration). */
  play(audio: CapturedAudio, signal?: AbortSignal): Promise<void>;
  /** Tear down any in-flight subprocess / resources. */
  dispose(): void;
}

/** `(providerId, path, action, params) => result` — i.e. ctx.invokeProvider. */
export type InvokeProvider = (
  providerId: string,
  path: string,
  action: string,
  params?: Record<string, unknown>,
) => Promise<ResultMessage>;

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
};

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.split(";")[0]?.trim() ?? mimeType] ?? "audio";
}

// A WAV header alone is 44 bytes; anything at or below that is effectively empty
// (sox emitted a header but captured no samples).
const MIN_CAPTURE_BYTES = 64;

type HostAudioConfig = VoiceConversationPluginConfig["audio"];

/**
 * Local-machine audio via subprocesses. Capture shells out to a recorder that
 * self-terminates on trailing silence (the host-side VAD); playback writes the
 * clip to a temp file and hands it to a player. Commands are config-overridable;
 * the defaults target macOS (sox + afplay).
 */
export class HostAudioBackend implements AudioBackend {
  private readonly captureCommand: string[];
  private readonly playbackCommand: string[];
  private active: ReturnType<typeof Bun.spawn> | null = null;

  constructor(config: HostAudioConfig) {
    this.captureCommand =
      config.captureCommand ??
      defaultCaptureCommand(config.silenceStopSeconds, config.silenceThresholdPercent);
    this.playbackCommand = config.playbackCommand ?? ["afplay", "{file}"];
  }

  async captureUtterance(signal?: AbortSignal): Promise<CapturedAudio | null> {
    const proc = Bun.spawn(this.captureCommand, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.active = proc;
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      const exitCode = await proc.exited;
      if (signal?.aborted) {
        return null;
      }
      if (exitCode !== 0) {
        throw new Error(
          `capture command exited ${exitCode}: ${(await stderrText(proc)).slice(0, 500)}`,
        );
      }
      if (bytes.byteLength <= MIN_CAPTURE_BYTES) {
        return null;
      }
      return { audioBase64: Buffer.from(bytes).toString("base64"), mimeType: "audio/wav" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.active = null;
    }
  }

  async play(audio: CapturedAudio, signal?: AbortSignal): Promise<void> {
    const bytes = Buffer.from(audio.audioBase64, "base64");
    const file = join(
      tmpdir(),
      `sloppy-voice-${process.pid}-${bytes.byteLength}.${extensionForMime(audio.mimeType)}`,
    );
    await Bun.write(file, bytes);
    const command = this.playbackCommand.map((part) => part.replace("{file}", file));
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    this.active = proc;
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const exitCode = await proc.exited;
      if (exitCode !== 0 && !signal?.aborted) {
        throw new Error(
          `playback command exited ${exitCode}: ${(await stderrText(proc)).slice(0, 500)}`,
        );
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.active = null;
      await unlink(file).catch(() => {});
    }
  }

  dispose(): void {
    this.active?.kill();
    this.active = null;
  }
}

/**
 * Robot audio via the reachy provider's affordances (Phase 2b). Mirrors the host
 * backend so the loop is unchanged — only the provider needs `/mic` `/speaker`
 * affordances implemented when hardware arrives.
 */
export class RobotAudioBackend implements AudioBackend {
  constructor(
    private readonly providerId: string,
    private readonly invoke: InvokeProvider,
  ) {}

  async captureUtterance(): Promise<CapturedAudio | null> {
    const result = await this.invoke(this.providerId, "/mic", "capture_utterance");
    if (result.status !== "ok" || !result.data) {
      return null;
    }
    const data = result.data as { audio_base64?: string; mime_type?: string };
    if (!data.audio_base64) {
      return null;
    }
    return { audioBase64: data.audio_base64, mimeType: data.mime_type ?? "audio/wav" };
  }

  async play(audio: CapturedAudio): Promise<void> {
    const result = await this.invoke(this.providerId, "/speaker", "play", {
      audio_base64: audio.audioBase64,
      mime_type: audio.mimeType,
    });
    if (result.status === "error") {
      throw new Error(result.error?.message ?? "speaker play failed");
    }
  }

  dispose(): void {}
}

/**
 * Default macOS capture: record from the default input as 16 kHz mono **16-bit**
 * PCM WAV to stdout, starting on sound and stopping after `silenceStopSeconds` of
 * silence. `-b 16 -e signed-integer` forces a plain PCM WAV — without it sox
 * inherits the coreaudio 32-bit format and writes WAVE_FORMAT_EXTENSIBLE, which
 * many decoders reject. The threshold gates start/stop on amplitude.
 */
function defaultCaptureCommand(silenceStopSeconds: number, thresholdPercent: number): string[] {
  const threshold = `${thresholdPercent}%`;
  return [
    "sox",
    "-d",
    "-c",
    "1",
    "-r",
    "16000",
    "-b",
    "16",
    "-e",
    "signed-integer",
    "-t",
    "wav",
    "-",
    "silence",
    "1",
    "0.1",
    threshold,
    "1",
    String(silenceStopSeconds),
    threshold,
  ];
}

async function stderrText(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  try {
    return await new Response(proc.stderr as ReadableStream).text();
  } catch {
    return "";
  }
}

/** Build the configured audio backend. `robot` requires an invoke function. */
export function createAudioBackend(
  config: VoiceConversationPluginConfig["audio"],
  invoke: InvokeProvider,
): AudioBackend {
  if (config.backend === "robot") {
    return new RobotAudioBackend(config.providerId, invoke);
  }
  return new HostAudioBackend(config);
}

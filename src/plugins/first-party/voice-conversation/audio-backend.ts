import type { ResultMessage } from "@slop-ai/consumer/browser";

import { toBase64, wavFromPcm16 } from "../../../speech/audio";
import type { PcmFormat } from "../../../speech/types";

/** A synthesized audio clip carried to the robot speaker as base64. */
export type CapturedAudio = {
  audioBase64: string;
  mimeType: string;
};

export interface AudioStreamSource {
  frames(signal?: AbortSignal): AsyncIterable<Uint8Array>;
  close(): void;
}

/**
 * Where the conversation loop's audio comes from and goes to. Both ends are
 * deliberately behind one interface so the loop is identical whether audio is
 * the local machine (dev / pre-hardware) or the robot's mic and speaker.
 */
export interface AudioBackend {
  /** Open a continuous PCM16LE mono stream for realtime STT (default 16 kHz). */
  openStream?(signal?: AbortSignal, sampleRate?: number): AudioStreamSource;
  /** Play a PCM chunk stream as it arrives (streamed synthesis playback). */
  playStream(
    format: PcmFormat,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void>;
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

const DEFAULT_STREAM_SAMPLE_RATE = 16000;

// Structural so the zod plugin config satisfies it and tests can pass plain
// objects. Command templates support a `{rate}` token (sample rate in Hz).
type HostAudioConfig = {
  streamCommand?: string[];
  playStreamCommand?: string[];
  streamChunkMs: number;
};

/**
 * Local-machine audio via subprocesses. The mic streams raw PCM from a capture
 * command's stdout; playback pipes PCM into a player's stdin. Commands are
 * config-overridable; the defaults target macOS (sox `sox -d` / `play`).
 */
export class HostAudioBackend implements AudioBackend {
  private readonly streamCommand: string[] | undefined;
  private readonly playStreamCommand: string[] | undefined;
  private readonly streamChunkMs: number;
  private active: ReturnType<typeof Bun.spawn> | null = null;

  constructor(config: HostAudioConfig) {
    this.streamCommand = config.streamCommand;
    this.playStreamCommand = config.playStreamCommand;
    this.streamChunkMs = config.streamChunkMs;
  }

  dispose(): void {
    this.active?.kill();
    this.active = null;
  }

  openStream(signal?: AbortSignal, sampleRate?: number): AudioStreamSource {
    const rate = sampleRate ?? DEFAULT_STREAM_SAMPLE_RATE;
    const command = substituteRate(this.streamCommand ?? defaultStreamCommand(), rate);
    const proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.active = proc;
    const chunkBytes = Math.max(2, Math.floor((rate * 2 * this.streamChunkMs) / 1000));
    const source = new HostCommandAudioStreamSource(proc, chunkBytes, () => {
      if (this.active === proc) {
        this.active = null;
      }
    });
    signal?.addEventListener("abort", () => source.close(), { once: true });
    return source;
  }

  /**
   * Pipe PCM chunks into a long-lived player process as they arrive. One
   * process per reply (not per sentence) so there are no startup gaps between
   * synthesis units.
   */
  async playStream(
    format: PcmFormat,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const command = substituteRate(
      this.playStreamCommand ?? defaultPlayStreamCommand(),
      format.sampleRate,
    );
    const proc = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    this.active = proc;
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const stdin = proc.stdin;
    try {
      try {
        for await (const chunk of chunks) {
          if (signal?.aborted) {
            break;
          }
          try {
            stdin.write(chunk);
            await stdin.flush();
          } catch (error) {
            // EPIPE after the player was killed/aborted is expected teardown.
            if (signal?.aborted) {
              break;
            }
            throw error;
          }
        }
      } catch (error) {
        proc.kill();
        throw error;
      } finally {
        try {
          await stdin.end();
        } catch {
          // Already closed by kill/exit.
        }
      }
      const exitCode = await proc.exited;
      if (exitCode !== 0 && !signal?.aborted) {
        throw new Error(
          `play stream command exited ${exitCode}: ${(await stderrText(proc)).slice(0, 500)}`,
        );
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.active === proc) {
        this.active = null;
      }
    }
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

  async play(audio: CapturedAudio): Promise<void> {
    const result = await this.invoke(this.providerId, "/speaker", "play", {
      audio_base64: audio.audioBase64,
      mime_type: audio.mimeType,
    });
    if (result.status === "error") {
      throw new Error(result.error?.message ?? "speaker play failed");
    }
  }

  /**
   * Robot playback collects the stream into one WAV clip and issues a single
   * /speaker invoke — per-chunk affordance calls would push ~25 base64 frames
   * a second through the hub for no latency benefit until hardware exists.
   */
  async playStream(
    format: PcmFormat,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) {
      if (signal?.aborted) {
        return;
      }
      parts.push(chunk);
    }
    if (signal?.aborted || parts.length === 0) {
      return;
    }
    const pcm = parts.reduce((merged, part) => concatBytes(merged, part), new Uint8Array(0));
    await this.play({ audioBase64: toBase64(wavFromPcm16(format, pcm)), mimeType: "audio/wav" });
  }

  dispose(): void {}
}

class HostCommandAudioStreamSource implements AudioStreamSource {
  private closed = false;

  constructor(
    private readonly proc: ReturnType<typeof Bun.spawn>,
    private readonly chunkBytes: number,
    private readonly onClose: () => void,
  ) {}

  async *frames(signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let exitError: Error | undefined;
    try {
      while (!this.closed && !signal?.aborted) {
        const { done, value } = await reader.read();
        if (done || !value) {
          break;
        }
        pending = concatBytes(pending, value);
        while (pending.byteLength >= this.chunkBytes) {
          const frame = pending.slice(0, this.chunkBytes);
          pending = pending.slice(this.chunkBytes);
          yield frame;
        }
      }
      if (!this.closed && !signal?.aborted && pending.byteLength > 0) {
        yield pending;
      }
    } finally {
      reader.releaseLock();
      this.close();
      const exitCode = await this.proc.exited.catch(() => 0);
      if (exitCode !== 0 && !signal?.aborted) {
        exitError = new Error(
          `stream command exited ${exitCode}: ${(await stderrText(this.proc)).slice(0, 500)}`,
        );
      }
    }
    if (exitError) {
      throw exitError;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.proc.kill();
    this.onClose();
  }
}

// Default macOS mic stream: record from the default input as mono 16-bit
// signed PCM at the requested rate. `-b 16 -e signed-integer` forces plain
// PCM — without it sox inherits the coreaudio 32-bit format.
function defaultStreamCommand(): string[] {
  return [
    "sox",
    "-d",
    "-c",
    "1",
    "-r",
    "{rate}",
    "-b",
    "16",
    "-e",
    "signed-integer",
    "-t",
    "raw",
    "-",
  ];
}

/** Default streamed playback: sox `play` reading raw PCM from stdin. */
function defaultPlayStreamCommand(): string[] {
  return [
    "play",
    "-q",
    "-t",
    "raw",
    "-r",
    "{rate}",
    "-e",
    "signed-integer",
    "-b",
    "16",
    "-c",
    "1",
    "-",
  ];
}

function substituteRate(command: string[], rate: number): string[] {
  return command.map((part) => part.replaceAll("{rate}", String(rate)));
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right;
  }
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
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
  config: HostAudioConfig & { backend: "host" | "robot"; providerId: string },
  invoke: InvokeProvider,
): AudioBackend {
  if (config.backend === "robot") {
    return new RobotAudioBackend(config.providerId, invoke);
  }
  return new HostAudioBackend(config);
}

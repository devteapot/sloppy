import { afterAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultMessage } from "@slop-ai/consumer/browser";

import {
  createAudioBackend,
  HostAudioBackend,
  type InvokeProvider,
  RobotAudioBackend,
} from "./audio-backend";

type AudioConfig = Parameters<typeof createAudioBackend>[0];

function audioConfig(overrides: Partial<AudioConfig>): AudioConfig {
  return {
    backend: "host",
    streamChunkMs: 40,
    providerId: "reachy",
    ...overrides,
  };
}

const tempFiles: string[] = [];

afterAll(async () => {
  await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
});

describe("HostAudioBackend", () => {
  test("openStream yields raw PCM chunks from the stream command", async () => {
    const backend = new HostAudioBackend(
      audioConfig({
        streamCommand: ["sh", "-c", "printf '\\001\\002\\003\\004\\005\\006'"],
        streamChunkMs: 10,
      }),
    );
    const source = backend.openStream();
    const frames: number[][] = [];
    for await (const frame of source.frames()) {
      frames.push(Array.from(frame));
    }
    expect(frames).toEqual([[1, 2, 3, 4, 5, 6]]);
  });

  test("openStream substitutes {rate} into the stream command", async () => {
    const backend = new HostAudioBackend(
      audioConfig({ streamCommand: ["sh", "-c", "printf %s {rate}"], streamChunkMs: 10 }),
    );
    const source = backend.openStream(undefined, 24000);
    const received: number[] = [];
    for await (const frame of source.frames()) {
      received.push(...frame);
    }
    expect(new TextDecoder().decode(new Uint8Array(received))).toBe("24000");
  });

  test("openStream throws asynchronously when the stream command exits non-zero", async () => {
    const backend = new HostAudioBackend(audioConfig({ streamCommand: ["false"] }));
    const source = backend.openStream();
    await expect(
      (async () => {
        for await (const _frame of source.frames()) {
          // drain
        }
      })(),
    ).rejects.toThrow(/stream command exited/);
  });

  test("playStream pipes chunks to the player's stdin with {rate} substituted", async () => {
    const sink = join(tmpdir(), `sloppy-voice-test-playstream-${process.pid}`);
    tempFiles.push(sink);
    const backend = new HostAudioBackend(
      audioConfig({
        playStreamCommand: ["sh", "-c", `printf '%s|' {rate} > ${sink}; cat >> ${sink}`],
      }),
    );

    async function* chunks() {
      yield new TextEncoder().encode("aaa");
      yield new TextEncoder().encode("bbb");
    }
    await backend.playStream({ encoding: "pcm16", sampleRate: 22050, channels: 1 }, chunks());

    expect(await Bun.file(sink).text()).toBe("22050|aaabbb");
  });

  test("playStream rejects when the player exits non-zero", async () => {
    const backend = new HostAudioBackend(audioConfig({ playStreamCommand: ["false"] }));
    async function* chunks() {
      yield new Uint8Array([1]);
    }
    await expect(
      backend.playStream({ encoding: "pcm16", sampleRate: 16000, channels: 1 }, chunks()),
    ).rejects.toThrow(/play stream command exited/);
  });

  test("playStream abort kills the player and resolves without error", async () => {
    const backend = new HostAudioBackend(
      // Player keeps running after stdin closes; only the abort kill ends it.
      audioConfig({ playStreamCommand: ["sh", "-c", "cat >/dev/null; sleep 30"] }),
    );
    const controller = new AbortController();
    async function* chunks() {
      yield new Uint8Array([1, 2]);
    }
    const playing = backend.playStream(
      { encoding: "pcm16", sampleRate: 16000, channels: 1 },
      chunks(),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(playing).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("RobotAudioBackend", () => {
  function okResult(data: unknown): ResultMessage {
    return { type: "result", id: "1", status: "ok", data };
  }

  test("play forwards the clip to the provider's /speaker affordance", async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: InvokeProvider = async (_p, _path, _action, params) => {
      received = params;
      return okResult(undefined);
    };
    await new RobotAudioBackend("reachy", invoke).play({
      audioBase64: "WFla",
      mimeType: "audio/mpeg",
    });
    expect(received).toEqual({ audio_base64: "WFla", mime_type: "audio/mpeg" });
  });

  test("play throws when the provider returns an error", async () => {
    const invoke: InvokeProvider = async () => ({
      type: "result",
      id: "1",
      status: "error",
      error: { code: "x", message: "no speaker" },
    });
    await expect(
      new RobotAudioBackend("reachy", invoke).play({ audioBase64: "AA", mimeType: "audio/wav" }),
    ).rejects.toThrow("no speaker");
  });

  test("playStream collects chunks into one WAV /speaker invoke", async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: InvokeProvider = async (_p, _path, _action, params) => {
      received = params;
      return okResult(undefined);
    };
    async function* chunks() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    }
    await new RobotAudioBackend("reachy", invoke).playStream(
      { encoding: "pcm16", sampleRate: 16000, channels: 1 },
      chunks(),
    );

    expect(received?.mime_type).toBe("audio/wav");
    const wav = Buffer.from(String(received?.audio_base64), "base64");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate in the header
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4]); // PCM payload
  });
});

describe("createAudioBackend", () => {
  const invoke: InvokeProvider = async () => ({ type: "result", id: "1", status: "ok" });

  test("returns a RobotAudioBackend for the robot backend", () => {
    expect(createAudioBackend(audioConfig({ backend: "robot" }), invoke)).toBeInstanceOf(
      RobotAudioBackend,
    );
  });

  test("returns a HostAudioBackend for the host backend", () => {
    expect(createAudioBackend(audioConfig({ backend: "host" }), invoke)).toBeInstanceOf(
      HostAudioBackend,
    );
  });
});

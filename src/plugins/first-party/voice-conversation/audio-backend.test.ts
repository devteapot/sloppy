import { afterAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { VoiceConversationPluginConfig } from "../../../config/schema";
import {
  createAudioBackend,
  HostAudioBackend,
  type InvokeProvider,
  RobotAudioBackend,
} from "./audio-backend";

type AudioConfig = VoiceConversationPluginConfig["audio"];

function audioConfig(overrides: Partial<AudioConfig>): AudioConfig {
  return {
    backend: "host",
    silenceStopSeconds: 1.2,
    silenceThresholdPercent: 1,
    maxUtteranceSeconds: 30,
    providerId: "reachy",
    ...overrides,
  };
}

const tempFiles: string[] = [];

async function writeFixture(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(tmpdir(), `sloppy-voice-test-${name}-${bytes.byteLength}`);
  await Bun.write(path, bytes);
  tempFiles.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
});

describe("HostAudioBackend", () => {
  test("captureUtterance returns base64 of the recorder's stdout", async () => {
    const fixture = new Uint8Array(200).fill(7);
    const path = await writeFixture("capture", fixture);
    const backend = new HostAudioBackend(audioConfig({ captureCommand: ["cat", path] }));

    const result = await backend.captureUtterance();

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("audio/wav");
    expect(result?.audioBase64).toBe(Buffer.from(fixture).toString("base64"));
  });

  test("captureUtterance returns null when the recording is effectively empty", async () => {
    // `true` exits 0 with no stdout → below the min-bytes floor → null.
    const backend = new HostAudioBackend(audioConfig({ captureCommand: ["true"] }));
    expect(await backend.captureUtterance()).toBeNull();
  });

  test("captureUtterance throws when the recorder exits non-zero", async () => {
    const backend = new HostAudioBackend(audioConfig({ captureCommand: ["false"] }));
    await expect(backend.captureUtterance()).rejects.toThrow();
  });

  test("play substitutes {file} with the written clip and resolves on success", async () => {
    const backend = new HostAudioBackend(
      // Succeeds only if the substituted path points at a non-empty file.
      audioConfig({ playbackCommand: ["sh", "-c", "test -s {file}"] }),
    );
    await expect(
      backend.play({
        audioBase64: Buffer.from("hello audio").toString("base64"),
        mimeType: "audio/mpeg",
      }),
    ).resolves.toBeUndefined();
  });

  test("play throws when the player exits non-zero", async () => {
    const backend = new HostAudioBackend(audioConfig({ playbackCommand: ["false"] }));
    await expect(
      backend.play({ audioBase64: Buffer.from("x").toString("base64"), mimeType: "audio/wav" }),
    ).rejects.toThrow();
  });
});

describe("RobotAudioBackend", () => {
  function okResult(data: unknown): ResultMessage {
    return { type: "result", id: "1", status: "ok", data };
  }

  test("captureUtterance maps the provider's /mic affordance result", async () => {
    const calls: Array<[string, string, string]> = [];
    const invoke: InvokeProvider = async (providerId, path, action) => {
      calls.push([providerId, path, action]);
      return okResult({ audio_base64: "QUJD", mime_type: "audio/wav" });
    };
    const backend = new RobotAudioBackend("reachy", invoke);

    const result = await backend.captureUtterance();

    expect(calls).toEqual([["reachy", "/mic", "capture_utterance"]]);
    expect(result).toEqual({ audioBase64: "QUJD", mimeType: "audio/wav" });
  });

  test("captureUtterance returns null when the provider yields no audio", async () => {
    const invoke: InvokeProvider = async () => okResult({});
    expect(await new RobotAudioBackend("reachy", invoke).captureUtterance()).toBeNull();
  });

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

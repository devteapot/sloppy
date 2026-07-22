import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromPaths } from "../src/config/load";
import { sloppyConfigSchema } from "../src/config/schema";

describe("plugins.voice config", () => {
  test("defaults to disabled with empty modalities", () => {
    const config = sloppyConfigSchema.parse({});
    expect(config.plugins.voice.enabled).toBe(false);
    expect(config.plugins.voice.stt.profiles).toEqual([]);
    expect(config.plugins.voice.tts.profiles).toEqual([]);
    expect(config.plugins.voice.conversation.realtime).toEqual({
      autoStartMode: "off",
      defaultStartMode: "single_turn",
    });
    expect(config.plugins.voice.conversation.audio.streamChunkMs).toBe(40);
  });

  test("parses realtime STT and streaming TTS endpoints with dialect and rates", () => {
    const config = sloppyConfigSchema.parse({
      plugins: {
        voice: {
          enabled: true,
          stt: {
            endpoints: {
              "nemotron-dgx": {
                protocol: "realtime-stt",
                baseUrl: "ws://dgx-spark.local:8000/v1/realtime",
                auth: { type: "none" },
                models: { "/models/nemotron-3.5-asr-streaming-0.6b": {} },
              },
              "vllm-voxtral": {
                protocol: "realtime-stt",
                dialect: "vllm",
                baseUrl: "ws://localhost:8000/v1/realtime",
                auth: { type: "none" },
                sampleRate: 16000,
              },
              "openai-cloud": {
                protocol: "realtime-stt",
                baseUrl: "wss://api.openai.com/v1/realtime",
                auth: { type: "env", env: "OPENAI_API_KEY" },
                sampleRate: 24000,
              },
            },
            profiles: [{ id: "stt-dgx", endpointId: "nemotron-dgx", model: "/models/nemotron" }],
            defaultProfileId: "stt-dgx",
          },
          tts: {
            endpoints: {
              kokoro: {
                protocol: "openai-speech",
                baseUrl: "http://localhost:8880/v1",
                auth: { type: "none" },
                model: "kokoro",
                pcmSampleRate: 24000,
              },
            },
            profiles: [{ id: "tts-local", endpointId: "kokoro", voice: "af_bella" }],
            defaultProfileId: "tts-local",
          },
        },
      },
    });

    // Dialect defaults to "openai"; sampleRate to 16000; pcmSampleRate to 24000.
    expect(config.plugins.voice.stt.endpoints["nemotron-dgx"]?.dialect).toBe("openai");
    expect(config.plugins.voice.stt.endpoints["nemotron-dgx"]?.sampleRate).toBe(16000);
    expect(config.plugins.voice.stt.endpoints["vllm-voxtral"]?.dialect).toBe("vllm");
    expect(config.plugins.voice.stt.endpoints["openai-cloud"]?.sampleRate).toBe(24000);
    expect(config.plugins.voice.tts.endpoints.kokoro?.pcmSampleRate).toBe(24000);
  });

  test("protocols are open strings — registry validation happens at runtime", () => {
    // A config naming an unregistered protocol parses; the profile manager
    // surfaces it as the profile's invalidReason instead of a config crash.
    const config = sloppyConfigSchema.parse({
      plugins: {
        voice: {
          stt: {
            endpoints: {
              legacy: { protocol: "deepgram", baseUrl: "wss://api.deepgram.com/v1/listen" },
            },
          },
        },
      },
    });
    expect(config.plugins.voice.stt.endpoints.legacy?.protocol).toBe("deepgram");
  });

  test("voice conversation accepts canonical {rate}-templated command overrides", () => {
    const config = sloppyConfigSchema.parse({
      plugins: {
        voice: {
          conversation: {
            enabled: true,
            audio: {
              backend: "host",
              streamCommand: ["sox", "-d", "-r", "{rate}", "-t", "raw", "-"],
              playStreamCommand: ["play", "-t", "raw", "-r", "{rate}", "-"],
              streamChunkMs: 20,
            },
          },
        },
      },
    });
    const audio = config.plugins.voice.conversation.audio;
    expect(audio.streamCommand).toContain("{rate}");
    expect(audio.playStreamCommand).toContain("{rate}");
    expect(audio.streamChunkMs).toBe(20);
  });

  test("migrates the legacy conversation key into the canonical voice Plugin", () => {
    const config = sloppyConfigSchema.parse({
      plugins: {
        "voice-conversation": {
          enabled: true,
          realtime: { autoStartMode: "continuous" },
        },
      },
    });
    expect(config.plugins.voice.conversation.enabled).toBe(true);
    expect(config.plugins.voice.conversation.realtime.autoStartMode).toBe("continuous");
    expect("voice-conversation" in config.plugins).toBe(false);
  });

  test("migrates each config layer before merging so a legacy upper layer wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-voice-config-"));
    const home = join(root, "home.yaml");
    const workspace = join(root, "workspace.yaml");
    await writeFile(
      home,
      "plugins:\n  voice:\n    conversation:\n      enabled: false\n      audio:\n        streamChunkMs: 20\n",
    );
    await writeFile(
      workspace,
      "plugins:\n  voice-conversation:\n    enabled: true\n    audio:\n      streamChunkMs: 30\n",
    );
    try {
      const config = await loadConfigFromPaths(home, workspace, { cwd: root });
      expect(config.plugins.voice.conversation.enabled).toBe(true);
      expect(config.plugins.voice.conversation.audio.streamChunkMs).toBe(30);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects removed batch-era fields", () => {
    expect(() =>
      sloppyConfigSchema.parse({
        plugins: {
          voice: { conversation: { audio: { captureCommand: ["sox"] } } },
        },
      }),
    ).toThrow();
    expect(() =>
      sloppyConfigSchema.parse({
        plugins: {
          voice: {
            tts: { profiles: [{ id: "t", endpointId: "kokoro", voice: "a", autospeak: true }] },
          },
        },
      }),
    ).toThrow();
  });
});

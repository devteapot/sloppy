import { describe, expect, test } from "bun:test";

import { sloppyConfigSchema } from "../src/config/schema";

describe("plugins.voice config", () => {
  test("defaults to disabled with empty modalities", () => {
    const config = sloppyConfigSchema.parse({});
    expect(config.plugins.voice.enabled).toBe(false);
    expect(config.plugins.voice.stt.profiles).toEqual([]);
    expect(config.plugins.voice.tts.profiles).toEqual([]);
  });

  test("parses cloud and local endpoints across both modalities", () => {
    const config = sloppyConfigSchema.parse({
      plugins: {
        voice: {
          enabled: true,
          stt: {
            endpoints: {
              "local-whisper": {
                protocol: "openai-transcriptions",
                baseUrl: "http://localhost:8000/v1",
                auth: { type: "none" },
              },
              cloud: { protocol: "deepgram", auth: { type: "env", env: "DEEPGRAM_API_KEY" } },
            },
            profiles: [{ id: "stt-local", endpointId: "local-whisper", model: "base" }],
            defaultProfileId: "stt-local",
          },
          tts: {
            endpoints: {
              kokoro: {
                protocol: "openai-speech",
                baseUrl: "http://localhost:8880/v1",
                auth: { type: "none" },
                model: "kokoro",
              },
            },
            profiles: [
              { id: "tts-local", endpointId: "kokoro", voice: "af_bella", autospeak: true },
            ],
            defaultProfileId: "tts-local",
          },
        },
      },
    });

    expect(config.plugins.voice.stt.endpoints["local-whisper"]?.auth).toEqual({ type: "none" });
    expect(config.plugins.voice.tts.profiles[0]?.autospeak).toBe(true);
  });

  test("autospeak defaults to false on TTS profiles", () => {
    const config = sloppyConfigSchema.parse({
      plugins: {
        voice: {
          tts: { profiles: [{ id: "t", endpointId: "openai-tts", voice: "alloy" }] },
        },
      },
    });
    expect(config.plugins.voice.tts.profiles[0]?.autospeak).toBe(false);
  });

  test("rejects an unknown STT protocol", () => {
    expect(() =>
      sloppyConfigSchema.parse({
        plugins: {
          voice: { stt: { endpoints: { x: { protocol: "not-a-protocol" } } } },
        },
      }),
    ).toThrow();
  });
});

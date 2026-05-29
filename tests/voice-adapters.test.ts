import { describe, expect, test } from "bun:test";

import { DeepgramAdapter } from "../src/stt/deepgram";
import { ElevenLabsSttAdapter } from "../src/stt/elevenlabs";
import { OpenAITranscriptionsAdapter } from "../src/stt/openai-transcriptions";
import { ElevenLabsTtsAdapter } from "../src/tts/elevenlabs";
import { OpenAISpeechAdapter } from "../src/tts/openai-speech";
import { PiperAdapter } from "../src/tts/piper";
import type { FetchLike } from "../src/voice/audio";

type Call = { url: string; init?: RequestInit };

function recordingFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const SAMPLE_AUDIO = "AAAA"; // base64 placeholder bytes

describe("STT adapters", () => {
  test("OpenAITranscriptionsAdapter parses verbose_json and derives confidence", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            text: "  hello world ",
            language: "en",
            segments: [{ avg_logprob: 0 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const adapter = new OpenAITranscriptionsAdapter({
      apiKey: "sk-test",
      model: "whisper-1",
      fetchImpl,
    });

    const result = await adapter.transcribe({ audio: SAMPLE_AUDIO, mimeType: "audio/wav" });

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.confidence).toBeCloseTo(1, 5);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = calls[0]?.init?.body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("response_format")).toBe("verbose_json");
  });

  test("OpenAITranscriptionsAdapter targets a local baseUrl with the 'local' key", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ text: "local" }), { status: 200 }),
    );
    const adapter = new OpenAITranscriptionsAdapter({
      model: "Systran/faster-whisper-base",
      baseUrl: "http://localhost:8000/v1",
      fetchImpl,
    });

    await adapter.transcribe({ audio: SAMPLE_AUDIO });

    expect(calls[0]?.url).toBe("http://localhost:8000/v1/audio/transcriptions");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer local");
  });

  test("OpenAITranscriptionsAdapter throws on non-2xx", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("nope", { status: 401 }));
    const adapter = new OpenAITranscriptionsAdapter({ apiKey: "x", model: "whisper-1", fetchImpl });
    await expect(adapter.transcribe({ audio: SAMPLE_AUDIO })).rejects.toThrow(/401/);
  });

  test("DeepgramAdapter parses channel alternatives and confidence", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  detected_language: "en",
                  alternatives: [{ transcript: "hi there", confidence: 0.97 }],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DeepgramAdapter({ apiKey: "dg-key", model: "nova-3", fetchImpl });

    const result = await adapter.transcribe({ audio: SAMPLE_AUDIO });

    expect(result.text).toBe("hi there");
    expect(result.confidence).toBe(0.97);
    expect(result.language).toBe("en");
    expect(calls[0]?.url).toContain("https://api.deepgram.com/v1/listen?");
    expect(calls[0]?.url).toContain("model=nova-3");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token dg-key");
  });

  test("ElevenLabsSttAdapter parses text and language", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ text: "bonjour", language_code: "fr", language_probability: 0.9 }),
          { status: 200 },
        ),
    );
    const adapter = new ElevenLabsSttAdapter({ apiKey: "xi", model: "scribe_v1", fetchImpl });

    const result = await adapter.transcribe({ audio: SAMPLE_AUDIO });

    expect(result.text).toBe("bonjour");
    expect(result.language).toBe("fr");
    expect(result.confidence).toBe(0.9);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("xi");
  });
});

describe("TTS adapters", () => {
  test("OpenAISpeechAdapter posts JSON and returns audio bytes", async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    );
    const adapter = new OpenAISpeechAdapter({
      apiKey: "sk",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      fetchImpl,
    });

    const result = await adapter.synthesize({ text: "hello" });

    expect(result.audio.length).toBe(4);
    expect(result.mimeType).toBe("audio/mpeg");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toMatchObject({
      model: "gpt-4o-mini-tts",
      input: "hello",
      voice: "alloy",
      response_format: "mp3",
    });
  });

  test("OpenAISpeechAdapter honors a local baseUrl and per-call voice override", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(new Uint8Array([0]), { status: 200 }),
    );
    const adapter = new OpenAISpeechAdapter({
      model: "kokoro",
      baseUrl: "http://localhost:8880/v1",
      voice: "af_bella",
      format: "wav",
      fetchImpl,
    });

    const result = await adapter.synthesize({ text: "hi", voice: "af_sky" });

    expect(calls[0]?.url).toBe("http://localhost:8880/v1/audio/speech");
    expect(result.mimeType).toBe("audio/wav");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.voice).toBe("af_sky");
    expect(body.response_format).toBe("wav");
  });

  test("ElevenLabsTtsAdapter posts to the voice URL", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(new Uint8Array([9]), { status: 200 }),
    );
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: "xi",
      model: "eleven_multilingual_v2",
      voice: "rachel",
      fetchImpl,
    });

    await adapter.synthesize({ text: "hey" });

    expect(calls[0]?.url).toContain("https://api.elevenlabs.io/v1/text-to-speech/rachel?");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("xi");
  });

  test("PiperAdapter posts text+voice to the local server", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(new Uint8Array([7, 7]), { status: 200 }),
    );
    const adapter = new PiperAdapter({
      model: "en_US-amy-medium",
      baseUrl: "http://localhost:5000",
      fetchImpl,
    });

    const result = await adapter.synthesize({ text: "spoken" });

    expect(result.mimeType).toBe("audio/wav");
    expect(calls[0]?.url).toBe("http://localhost:5000/");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toMatchObject({ text: "spoken", voice: "en_US-amy-medium" });
  });
});

import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import type { SttAdapter, TtsAdapter } from "../src/plugins/first-party/voice/adapters";
import { VoiceProvider } from "../src/plugins/first-party/voice/provider";
import { InProcessTransport } from "../src/providers/in-process";
import { createTestConfig } from "./helpers/config";

class FakeSttAdapter implements SttAdapter {
  readonly id = "openai-transcribe";
  readonly kind = "openai-transcribe" as const;

  async transcribe(request: Parameters<SttAdapter["transcribe"]>[0]) {
    return {
      text: new TextDecoder().decode(request.audio).trim(),
    };
  }
}

class FakeTtsAdapter implements TtsAdapter {
  readonly id = "openai-tts";
  readonly kind = "openai-tts" as const;

  async synthesize(request: Parameters<TtsAdapter["synthesize"]>[0]) {
    return {
      audio: new TextEncoder().encode(`audio:${request.model}:${request.voice}:${request.text}`),
      mime: "audio/wav",
      format: request.format,
    };
  }
}

function createHarness() {
  const config = createTestConfig({
    plugins: {
      voice: { enabled: true },
    },
  }).plugins.voice;
  const provider = new VoiceProvider({
    config,
    adapters: {
      stt: new Map([["openai-transcribe", new FakeSttAdapter()]]),
      tts: new Map([["openai-tts", new FakeTtsAdapter()]]),
    },
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 4);
}

describe("VoiceProvider", () => {
  test("exposes voice pipeline state and media endpoint", async () => {
    const { provider, consumer } = createHarness();
    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties?.status).toBe("ready");
      expect(session.properties?.input_adapter_id).toBe("openai-transcribe");
      expect(session.properties?.output_adapter_id).toBe("openai-tts");
      expect(String(session.properties?.media_endpoint)).toContain("http://127.0.0.1:");

      const input = await consumer.query("/input", 2);
      expect(input.type).toBe("control");
      expect(input.properties?.state).toBe("idle");
      expect(input.affordances?.map((item) => item.action)).toContain("open_stream");

      const output = await consumer.query("/output", 2);
      expect(output.type).toBe("control");
      expect(output.properties?.voice).toBe("marin");
      expect(output.affordances?.map((item) => item.action)).toContain("synthesize");
    } finally {
      provider.stop();
    }
  });

  test("accepts audio through the side channel and exposes final transcripts", async () => {
    const { provider, consumer } = createHarness();
    try {
      await connect(consumer);

      const opened = await consumer.invoke("/input", "open_stream", { mime: "audio/wav" });
      expect(opened.status).toBe("ok");
      const stream = opened.data as {
        stream_id: string;
        upload_url: string;
        token: string;
      };

      const upload = await fetch(stream.upload_url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${stream.token}`,
          "content-type": "audio/wav",
          "x-sloppy-partial-text": "run the",
        },
        body: new TextEncoder().encode("run the focused voice test"),
      });
      expect(upload.status).toBe(200);
      const uploadResult = (await upload.json()) as { transcript_id: string; text: string };
      expect(uploadResult.text).toBe("run the focused voice test");

      const input = await consumer.query("/input", 2);
      expect(input.properties).toMatchObject({
        state: "ready",
        final_text: "run the focused voice test",
        active_stream_id: undefined,
      });

      const transcripts = await consumer.query("/transcripts", 2);
      expect(transcripts.properties?.count).toBe(1);
      expect(transcripts.children?.[0]?.properties).toMatchObject({
        id: uploadResult.transcript_id,
        stream_id: stream.stream_id,
        text: "run the focused voice test",
        status: "final",
      });

      const tasks = await consumer.query("/tasks", 2);
      expect(tasks.children?.[0]?.properties).toMatchObject({
        kind: "transcription",
        status: "done",
      });
    } finally {
      provider.stop();
    }
  });

  test("synthesizes speech and returns audio through a content ref affordance", async () => {
    const { provider, consumer } = createHarness();
    try {
      await connect(consumer);

      const result = await consumer.invoke("/output", "synthesize", {
        text: "Focused tests passed.",
        message_id: "msg-123",
      });
      expect(result.status).toBe("ok");
      const data = result.data as {
        segment_id: string;
        content_ref: { type: string; mime: string; uri: string };
      };
      expect(data.content_ref).toMatchObject({
        type: "binary",
        mime: "audio/wav",
        uri: `slop://voice/output/segments/${data.segment_id}/audio`,
      });

      const segments = await consumer.query("/output/segments", 2);
      expect(segments.properties?.count).toBe(1);
      const segment = segments.children?.[0];
      expect(segment?.properties).toMatchObject({
        id: data.segment_id,
        text: "Focused tests passed.",
        status: "ready",
        message_id: "msg-123",
      });
      expect(segment?.content_ref).toMatchObject(data.content_ref);
      expect(segment?.affordances?.map((item) => item.action)).toEqual(["read_content"]);

      const content = await consumer.invoke(`/output/segments/${data.segment_id}`, "read_content");
      expect(content.status).toBe("ok");
      const audio = content.data as { encoding: string; content: string; mime: string };
      expect(audio.encoding).toBe("base64");
      expect(audio.mime).toBe("audio/wav");
      expect(Buffer.from(audio.content, "base64").toString("utf8")).toBe(
        "audio:gpt-4o-mini-tts:marin:Focused tests passed.",
      );
    } finally {
      provider.stop();
    }
  });

  test("switches STT and TTS adapter state session-locally", async () => {
    const { provider, consumer } = createHarness();
    try {
      await connect(consumer);

      const stt = await consumer.invoke("/input", "set_adapter", {
        adapter_id: "openai-transcribe",
        model: "gpt-4o-transcribe",
        language: "en",
      });
      expect(stt.status).toBe("ok");
      expect(stt.data).toMatchObject({
        adapter_id: "openai-transcribe",
        model: "gpt-4o-transcribe",
        language: "en",
      });

      const tts = await consumer.invoke("/output", "set_adapter", {
        adapter_id: "openai-tts",
        model: "gpt-4o-mini-tts",
        format: "mp3",
      });
      expect(tts.status).toBe("ok");
      expect(tts.data).toMatchObject({
        adapter_id: "openai-tts",
        format: "mp3",
      });

      const voice = await consumer.invoke("/output", "set_voice", { voice: "cedar" });
      expect(voice.status).toBe("ok");
      expect(voice.data).toEqual({ voice: "cedar" });

      const output = await consumer.query("/output", 2);
      expect(output.properties).toMatchObject({
        active_model: "gpt-4o-mini-tts",
        voice: "cedar",
        format: "mp3",
      });
    } finally {
      provider.stop();
    }
  });
});

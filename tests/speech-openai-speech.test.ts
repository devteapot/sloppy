import { describe, expect, test } from "bun:test";

import { OpenAISpeechStreamAdapter } from "../src/speech/openai-speech";
import type { FetchLike, TtsAdapterConfig } from "../src/speech/types";

type Call = { url: string; body: Record<string, unknown>; signal?: AbortSignal };

/**
 * Fetch double whose responses stream their body in scripted chunks. Each
 * response's chunks are released one at a time via `release()` so tests can
 * control interleaving.
 */
function streamingFetch(options: { failStatus?: number } = {}) {
  const calls: Call[] = [];
  let release: (() => void)[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body, signal: init?.signal ?? undefined });
    if (options.failStatus) {
      return new Response("synthesis exploded", { status: options.failStatus });
    }
    const sentence = String(body.input);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of [`${sentence}|a`, `${sentence}|b`]) {
          await new Promise<void>((resolve) => {
            release.push(resolve);
          });
          controller.enqueue(new TextEncoder().encode(part));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  return {
    fetchImpl,
    calls,
    releaseAll(): void {
      const pending = release;
      release = [];
      for (const fn of pending) {
        fn();
      }
    },
  };
}

function makeAdapter(fetchImpl: FetchLike, overrides: Partial<TtsAdapterConfig> = {}) {
  return new OpenAISpeechStreamAdapter({
    endpointId: "test",
    protocol: "openai-speech",
    model: "gpt-4o-mini-tts",
    apiKey: "sk-test",
    baseUrl: "http://localhost:8880/v1",
    voice: "af_bella",
    pcmSampleRate: 24000,
    fetchImpl,
    ...overrides,
  });
}

const SENTENCE_A = "This is the first complete sentence of the reply.";
const SENTENCE_B = "And here is the second one, also long enough.";

async function collect(iterable: AsyncIterable<Uint8Array>, pump: () => void): Promise<string[]> {
  const out: string[] = [];
  const done = (async () => {
    for await (const chunk of iterable) {
      out.push(new TextDecoder().decode(chunk));
    }
  })();
  // Pump the scripted stream releases until the iterator completes.
  const interval = setInterval(pump, 1);
  try {
    await done;
  } finally {
    clearInterval(interval);
  }
  return out;
}

describe("OpenAISpeechStreamAdapter", () => {
  test("requests pcm with voice/model and streams ordered chunks across sentences", async () => {
    const { fetchImpl, calls, releaseAll } = streamingFetch();
    const stream = makeAdapter(fetchImpl).openStream();
    stream.appendText(`${SENTENCE_A} ${SENTENCE_B}`);
    stream.end();

    const chunks = await collect(stream.chunks(), releaseAll);

    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8880/v1/audio/speech",
      "http://localhost:8880/v1/audio/speech",
    ]);
    expect(calls[0]?.body).toEqual({
      model: "gpt-4o-mini-tts",
      input: SENTENCE_A,
      voice: "af_bella",
      response_format: "pcm",
    });
    expect(calls[1]?.body.input).toBe(SENTENCE_B);
    // Strict order: all of sentence A's audio before any of sentence B's.
    expect(chunks).toEqual([
      `${SENTENCE_A}|a`,
      `${SENTENCE_A}|b`,
      `${SENTENCE_B}|a`,
      `${SENTENCE_B}|b`,
    ]);
  });

  test("voice and speed overrides are honored per stream", async () => {
    const { fetchImpl, calls, releaseAll } = streamingFetch();
    const stream = makeAdapter(fetchImpl, { speed: 1.0 }).openStream({
      voice: "marin",
      speed: 1.2,
    });
    stream.appendText(SENTENCE_A);
    stream.end();
    await collect(stream.chunks(), releaseAll);

    expect(calls[0]?.body.voice).toBe("marin");
    expect(calls[0]?.body.speed).toBe(1.2);
  });

  test("markdown is normalized before synthesis", async () => {
    const { fetchImpl, calls, releaseAll } = streamingFetch();
    const stream = makeAdapter(fetchImpl).openStream();
    stream.appendText("**Done!** See [the logs](https://example.com) for full details today.");
    stream.end();
    await collect(stream.chunks(), releaseAll);

    expect(calls.map((call) => call.body.input)).toEqual([
      "Done! See the logs for full details today.",
    ]);
  });

  test("empty reply closes the stream with no requests", async () => {
    const { fetchImpl, calls, releaseAll } = streamingFetch();
    const stream = makeAdapter(fetchImpl).openStream();
    stream.appendText("```ts\nconst onlyCode = true;\n```");
    stream.end();

    expect(await collect(stream.chunks(), releaseAll)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("non-2xx surfaces as a SpeechError from chunks()", async () => {
    const { fetchImpl, releaseAll } = streamingFetch({ failStatus: 500 });
    const stream = makeAdapter(fetchImpl).openStream();
    stream.appendText(SENTENCE_A);
    stream.end();

    await expect(collect(stream.chunks(), releaseAll)).rejects.toThrow(
      /Speech synthesis failed \(500\): synthesis exploded/,
    );
  });

  test("abort() terminates chunks() early and aborts the in-flight request", async () => {
    const { fetchImpl, calls, releaseAll } = streamingFetch();
    const stream = makeAdapter(fetchImpl).openStream();
    stream.appendText(`${SENTENCE_A} ${SENTENCE_B}`);
    stream.end();

    const received: string[] = [];
    const iterator = stream.chunks()[Symbol.asyncIterator]();
    const interval = setInterval(releaseAll, 1);
    const first = await iterator.next();
    clearInterval(interval);
    received.push(new TextDecoder().decode(first.value as Uint8Array));
    stream.abort();

    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(received).toEqual([`${SENTENCE_A}|a`]);
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
  });
});

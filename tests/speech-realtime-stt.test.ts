import { describe, expect, test } from "bun:test";

import { RealtimeSttAdapter } from "../src/plugins/first-party/voice/protocols/realtime-stt/session";
import type { SttSessionEvent, WebSocketConstructorLike } from "../src/speech/types";
import { FakeWebSocket } from "./helpers/fake-websocket";

const ctor = FakeWebSocket as unknown as WebSocketConstructorLike;

function makeAdapter(overrides: { dialect?: string; baseUrl?: string; apiKey?: string } = {}) {
  return new RealtimeSttAdapter({
    endpointId: "test",
    protocol: "realtime-stt",
    dialect: overrides.dialect,
    model: "test-model",
    apiKey: overrides.apiKey,
    baseUrl: overrides.baseUrl ?? "ws://localhost:8000/v1/realtime",
    language: "en",
    sampleRate: 16000,
    webSocketCtor: ctor,
  });
}

async function startSession(adapter: RealtimeSttAdapter): Promise<{
  socket: FakeWebSocket;
  events: SttSessionEvent[];
  session: Awaited<ReturnType<RealtimeSttAdapter["startSession"]>>;
}> {
  const events: SttSessionEvent[] = [];
  const session = await adapter.startSession({ onEvent: (event) => events.push(event) });
  const socket = FakeWebSocket.latest;
  if (!socket) {
    throw new Error("no socket created");
  }
  return { socket, events, session };
}

describe("RealtimeSttAdapter — openai dialect", () => {
  test("connects with ?intent=transcription and sends the GA session.update", async () => {
    const { socket } = await startSession(makeAdapter({ apiKey: "sk-test" }));

    expect(socket.url).toBe("ws://localhost:8000/v1/realtime?intent=transcription");
    expect((socket.options as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer sk-test",
    );
    expect(socket.sentJson()[0]).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 16000 },
            transcription: { model: "test-model", language: "en" },
            turn_detection: { type: "server_vad" },
          },
        },
      },
    });
  });

  test("omits Authorization when no apiKey is configured", async () => {
    const { socket } = await startSession(makeAdapter());
    const headers = (socket.options as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  test("maps the GA event sequence to runtime events", async () => {
    const { socket, events } = await startSession(makeAdapter());

    socket.emitMessage({ type: "session.created" }); // ignored
    socket.emitMessage({
      type: "input_audio_buffer.speech_started",
      item_id: "i1",
      audio_start_ms: 120,
    });
    socket.emitMessage({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i1",
      delta: "hello",
    });
    socket.emitMessage({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i1",
      delta: " world",
    });
    socket.emitMessage({
      type: "input_audio_buffer.speech_stopped",
      item_id: "i1",
      audio_end_ms: 900,
    });
    socket.emitMessage({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "i1",
      transcript: " hello world ",
    });

    expect(events).toEqual([
      { type: "speech_started", itemId: "i1", audioStartMs: 120 },
      { type: "partial", itemId: "i1", delta: "hello", text: "hello" },
      { type: "partial", itemId: "i1", delta: " world", text: "hello world" },
      { type: "speech_stopped", itemId: "i1", audioEndMs: 900 },
      { type: "final", itemId: "i1", text: "hello world", language: undefined },
    ]);
  });

  test("reconciles full-text deltas when the server sends text instead of delta", async () => {
    const { socket, events } = await startSession(makeAdapter());

    socket.emitMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "hi",
    });
    socket.emitMessage({
      type: "conversation.item.input_audio_transcription.delta",
      text: "hi there",
    });

    expect(events).toEqual([
      { type: "partial", itemId: undefined, delta: "hi", text: "hi" },
      { type: "partial", itemId: undefined, delta: " there", text: "hi there" },
    ]);
  });

  test("appendAudio frames PCM as base64 input_audio_buffer.append; end() commits", async () => {
    const { socket, session } = await startSession(makeAdapter());
    await session.appendAudio(new Uint8Array([1, 2, 3]));
    await session.appendAudio(new Uint8Array(0)); // dropped
    await session.end();

    const sent = socket.sentJson().slice(1); // skip session.update
    expect(sent).toEqual([
      { type: "input_audio_buffer.append", audio: Buffer.from([1, 2, 3]).toString("base64") },
      { type: "input_audio_buffer.commit" },
    ]);
  });

  test("invalid JSON surfaces as a non-fatal error event", async () => {
    const { socket, events } = await startSession(makeAdapter());
    socket.emitRaw("{nope");
    expect(events).toEqual([
      { type: "error", message: "Realtime transcription returned invalid JSON." },
    ]);
  });
});

describe("RealtimeSttAdapter — vllm dialect", () => {
  test("connects without intent param and maps transcription.delta/done", async () => {
    const { socket, events, session } = await startSession(makeAdapter({ dialect: "vllm" }));

    expect(socket.url).toBe("ws://localhost:8000/v1/realtime");
    expect(socket.sentJson()[0]).toEqual({
      type: "session.update",
      session: {
        model: "test-model",
        language: "en",
        input_audio_format: "pcm16",
        input_audio_sample_rate: 16000,
      },
    });

    socket.emitMessage({ type: "transcription.delta", delta: "bon" });
    socket.emitMessage({ type: "transcription.delta", delta: "jour" });
    socket.emitMessage({ type: "transcription.done", text: "bonjour" });
    await session.end();

    expect(events).toEqual([
      { type: "partial", itemId: undefined, delta: "bon", text: "bon" },
      { type: "partial", itemId: undefined, delta: "jour", text: "bonjour" },
      { type: "final", itemId: undefined, text: "bonjour" },
    ]);
    expect(socket.sentJson().at(-1)).toEqual({ type: "input_audio_buffer.commit" });
  });

  test("unknown dialect throws with the known list", () => {
    expect(() => makeAdapter({ dialect: "nope" })).toThrow(/Unknown realtime STT dialect 'nope'/);
  });
});

describe("RealtimeSttSession closed semantics", () => {
  test("remote close emits closed{remote} exactly once", async () => {
    const { socket, events } = await startSession(makeAdapter());
    socket.serverClose(1006, "service restarted");
    socket.serverClose(1006); // second close must not duplicate

    const closed = events.filter((event) => event.type === "closed");
    expect(closed).toEqual([
      { type: "closed", cause: "remote", code: 1006, reason: "service restarted" },
    ]);
  });

  test("transport error emits closed{error} once, and a later close is ignored", async () => {
    const { socket, events } = await startSession(makeAdapter());
    socket.emitError();
    socket.serverClose(1006);

    expect(events.filter((event) => event.type === "closed")).toEqual([
      { type: "closed", cause: "error" },
    ]);
  });

  test("local close emits closed{local} once and is idempotent", async () => {
    const { events, session } = await startSession(makeAdapter());
    session.close();
    session.close();

    expect(events).toEqual([{ type: "closed", cause: "local" }]);
  });

  test("appendAudio after close is a silent no-op", async () => {
    const { socket, session } = await startSession(makeAdapter());
    session.close();
    const sentBefore = socket.sent.length;
    await session.appendAudio(new Uint8Array([9]));
    expect(socket.sent.length).toBe(sentBefore);
  });

  test("abort signal closes the session", async () => {
    const controller = new AbortController();
    const events: SttSessionEvent[] = [];
    const adapter = makeAdapter();
    await adapter.startSession({ signal: controller.signal, onEvent: (e) => events.push(e) });
    controller.abort();

    expect(events).toEqual([{ type: "closed", cause: "local" }]);
  });
});

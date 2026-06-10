// Wire-format dialects of the realtime transcription protocol family. The
// session core (`session.ts`) owns the WebSocket lifecycle, auth, base64 audio
// framing, and closed-event semantics; a dialect owns only naming and payload
// shapes: connect URL, session.update body, commit message, and the mapping
// from server events to runtime `SttSessionEvent`s.

import { trimBaseUrl } from "../audio";
import { SpeechError, type SttSessionEvent } from "../types";

/** Loosely-typed server event; dialects pick the fields they understand. */
export type RealtimeServerEvent = {
  type?: string;
  error?: { message?: string };
  item_id?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
  delta?: string;
  text?: string;
  transcript?: string;
  language?: string | null;
};

export type RealtimeSttDialect = {
  id: string;
  /** Final WS URL from the trimmed endpoint baseUrl (may append query params). */
  connectUrl(baseUrl: string): string;
  /** Client config message sent immediately after the socket opens. */
  sessionUpdate(options: {
    model: string;
    language?: string;
    sampleRate: number;
  }): Record<string, unknown>;
  /** Message sent by SttSession.end() to flush trailing audio, or null. */
  commitMessage(): Record<string, unknown> | null;
  /**
   * Map one parsed server event to a runtime event; null = ignore. `state.text`
   * is the session's running transcript accumulator — dialects update it so
   * partial events always carry the full text-so-far.
   */
  mapEvent(raw: RealtimeServerEvent, state: { text: string }): SttSessionEvent | null;
};

/**
 * OpenAI GA transcription-session dialect. Also the target for
 * OpenAI-compatible local services (the DGX Nemotron ASR service, speaches,
 * NVIDIA Speech NIM's ASR intent differs only in its session.update name).
 */
const openaiDialect: RealtimeSttDialect = {
  id: "openai",
  connectUrl(baseUrl) {
    const url = trimBaseUrl(baseUrl);
    return url.includes("?") ? `${url}&intent=transcription` : `${url}?intent=transcription`;
  },
  sessionUpdate({ model, language, sampleRate }) {
    return {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: sampleRate },
            transcription: { model, language },
            turn_detection: { type: "server_vad" },
          },
        },
      },
    };
  },
  commitMessage() {
    return { type: "input_audio_buffer.commit" };
  },
  mapEvent(raw, state) {
    switch (raw.type) {
      case "input_audio_buffer.speech_started":
        state.text = "";
        return {
          type: "speech_started",
          itemId: raw.item_id,
          audioStartMs: raw.audio_start_ms,
        };
      case "input_audio_buffer.speech_stopped":
        return {
          type: "speech_stopped",
          itemId: raw.item_id,
          audioEndMs: raw.audio_end_ms,
        };
      case "conversation.item.input_audio_transcription.delta": {
        // Servers send either a delta, the full text-so-far, or both.
        const nextText = raw.text ?? `${state.text}${raw.delta ?? ""}`;
        const delta =
          raw.delta ??
          (nextText.startsWith(state.text) ? nextText.slice(state.text.length) : nextText);
        state.text = nextText;
        return { type: "partial", itemId: raw.item_id, delta, text: nextText };
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = (raw.transcript ?? state.text).trim();
        state.text = "";
        return {
          type: "final",
          itemId: raw.item_id,
          text,
          language: raw.language ?? undefined,
        };
      }
      case "error":
        return {
          type: "error",
          message: raw.error?.message ?? "Realtime transcription returned an error.",
        };
      default:
        return null;
    }
  },
};

/** vLLM's /v1/realtime ASR dialect ("inspired by" OpenAI; renamed events). */
const vllmDialect: RealtimeSttDialect = {
  id: "vllm",
  connectUrl(baseUrl) {
    return trimBaseUrl(baseUrl);
  },
  sessionUpdate({ model, language, sampleRate }) {
    return {
      type: "session.update",
      session: {
        model,
        language,
        input_audio_format: "pcm16",
        input_audio_sample_rate: sampleRate,
      },
    };
  },
  commitMessage() {
    return { type: "input_audio_buffer.commit" };
  },
  mapEvent(raw, state) {
    switch (raw.type) {
      case "input_audio_buffer.speech_started":
        state.text = "";
        return { type: "speech_started", itemId: raw.item_id };
      case "input_audio_buffer.speech_stopped":
        return { type: "speech_stopped", itemId: raw.item_id };
      case "transcription.delta": {
        const delta = raw.delta ?? "";
        state.text = `${state.text}${delta}`;
        return { type: "partial", itemId: raw.item_id, delta, text: state.text };
      }
      case "transcription.done": {
        const text = (raw.text ?? state.text).trim();
        state.text = "";
        return { type: "final", itemId: raw.item_id, text };
      }
      case "error":
        return {
          type: "error",
          message: raw.error?.message ?? "Realtime transcription returned an error.",
        };
      default:
        return null;
    }
  },
};

export const REALTIME_STT_DIALECTS: Record<string, RealtimeSttDialect> = {
  openai: openaiDialect,
  vllm: vllmDialect,
};

export function resolveRealtimeSttDialect(id: string | undefined): RealtimeSttDialect {
  const dialect = REALTIME_STT_DIALECTS[id ?? "openai"];
  if (!dialect) {
    throw new SpeechError(
      `Unknown realtime STT dialect '${id}'. Known: ${Object.keys(REALTIME_STT_DIALECTS).join(", ")}.`,
    );
  }
  return dialect;
}

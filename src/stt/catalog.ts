import type { VoiceSttEndpointConfig } from "../config/schema";

// Cloud endpoints authenticate via an env var (or stored credential); local
// self-hosted servers expose OpenAI-compatible transcription APIs, so they ride
// the same `openai-transcriptions` protocol and only differ by `baseUrl` +
// `auth: { type: "none" }` — the same pattern as the `ollama` LLM endpoint.
// Suggested default model per endpoint for UI/profile bootstrapping.
export const DEFAULT_STT_MODELS: Record<string, string> = {
  "openai-stt": "whisper-1",
  deepgram: "nova-3",
  "elevenlabs-stt": "scribe_v1",
  "faster-whisper": "Systran/faster-whisper-base",
};

export const DEFAULT_STT_ENDPOINTS: Record<string, VoiceSttEndpointConfig> = {
  "openai-stt": {
    label: "OpenAI Transcriptions",
    protocol: "openai-transcriptions",
    auth: { type: "env", env: "OPENAI_API_KEY" },
    models: {
      "whisper-1": { label: "Whisper v1" },
      "gpt-4o-transcribe": { label: "GPT-4o Transcribe" },
    },
  },
  deepgram: {
    label: "Deepgram",
    protocol: "deepgram",
    auth: { type: "env", env: "DEEPGRAM_API_KEY" },
    models: {
      "nova-3": { label: "Nova 3", streaming: true },
    },
  },
  "elevenlabs-stt": {
    label: "ElevenLabs Speech-to-Text",
    protocol: "elevenlabs",
    auth: { type: "env", env: "ELEVENLABS_API_KEY" },
    models: {
      scribe_v1: { label: "Scribe v1" },
    },
  },
  // Local, self-hosted, OpenAI-compatible (faster-whisper-server / speaches).
  "faster-whisper": {
    label: "Faster Whisper (local)",
    protocol: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    auth: { type: "none" },
    models: {
      "Systran/faster-whisper-base": { label: "faster-whisper base" },
    },
  },
};

/** Overlay user-configured STT endpoints on top of the built-in defaults. */
export function mergeSttEndpoints(
  user: Record<string, VoiceSttEndpointConfig>,
): Record<string, VoiceSttEndpointConfig> {
  return { ...DEFAULT_STT_ENDPOINTS, ...user };
}

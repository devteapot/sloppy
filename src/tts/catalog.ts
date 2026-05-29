import type { VoiceTtsEndpointConfig } from "../config/schema";

// As with STT, local self-hosted TTS servers expose OpenAI-compatible
// `/audio/speech` APIs (kokoro-fastapi, openedai-speech), so they ride the
// `openai-speech` protocol and only differ by `baseUrl` + `auth: { type: "none" }`.
// Suggested default voice per endpoint for UI/profile bootstrapping.
export const DEFAULT_TTS_VOICES: Record<string, string> = {
  "openai-tts": "alloy",
  "elevenlabs-tts": "21m00Tcm4TlvDq8ikWAM",
  kokoro: "af_bella",
  piper: "en_US-amy-medium",
};

export const DEFAULT_TTS_ENDPOINTS: Record<string, VoiceTtsEndpointConfig> = {
  "openai-tts": {
    label: "OpenAI Speech",
    protocol: "openai-speech",
    auth: { type: "env", env: "OPENAI_API_KEY" },
    model: "gpt-4o-mini-tts",
    voices: {
      alloy: { label: "Alloy", format: "mp3" },
      verse: { label: "Verse", format: "mp3" },
    },
  },
  "elevenlabs-tts": {
    label: "ElevenLabs",
    protocol: "elevenlabs",
    auth: { type: "env", env: "ELEVENLABS_API_KEY" },
    model: "eleven_multilingual_v2",
    voices: {
      "21m00Tcm4TlvDq8ikWAM": { label: "Rachel", format: "mp3", streaming: true },
    },
  },
  // Local, self-hosted, OpenAI-compatible (kokoro-fastapi / openedai-speech).
  kokoro: {
    label: "Kokoro (local)",
    protocol: "openai-speech",
    baseUrl: "http://localhost:8880/v1",
    auth: { type: "none" },
    model: "kokoro",
    voices: {
      af_bella: { label: "Bella", format: "wav" },
    },
  },
  // Local Piper HTTP server.
  piper: {
    label: "Piper (local)",
    protocol: "piper",
    baseUrl: "http://localhost:5000",
    auth: { type: "none" },
    model: "en_US-amy-medium",
    voices: {
      "en_US-amy-medium": { label: "Amy", format: "wav" },
    },
  },
};

/** Overlay user-configured TTS endpoints on top of the built-in defaults. */
export function mergeTtsEndpoints(
  user: Record<string, VoiceTtsEndpointConfig>,
): Record<string, VoiceTtsEndpointConfig> {
  return { ...DEFAULT_TTS_ENDPOINTS, ...user };
}

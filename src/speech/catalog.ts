import type { SpeechSttEndpointConfig, SpeechTtsEndpointConfig } from "./profile-manager";

// Built-in speech endpoints. Local vs cloud is config, not protocol: local
// services ride the same protocols and differ only by baseUrl + auth none.
// Suggested default model/voice per endpoint for UI/profile bootstrapping.
export const DEFAULT_STT_MODELS: Record<string, string> = {
  "dgx-nemotron": "/models/nemotron-3.5-asr-streaming",
  "openai-realtime": "gpt-4o-mini-transcribe",
  "vllm-realtime": "mistralai/Voxtral-Mini-4B-Realtime-2602",
};

export const DEFAULT_TTS_VOICES: Record<string, string> = {
  "openai-tts": "alloy",
  kokoro: "af_bella",
};

export const DEFAULT_STT_ENDPOINTS: Record<string, SpeechSttEndpointConfig> = {
  // Self-hosted OpenAI-Realtime-compatible ASR (the DGX Spark Nemotron
  // service). The model field is passed through, so local model paths work.
  "dgx-nemotron": {
    label: "DGX Nemotron ASR (realtime)",
    protocol: "realtime-stt",
    dialect: "openai",
    baseUrl: "ws://dgx-spark.local:8000/v1/realtime",
    auth: { type: "none" },
    sampleRate: 16000,
  },
  "openai-realtime": {
    label: "OpenAI Realtime Transcription",
    protocol: "realtime-stt",
    dialect: "openai",
    auth: { type: "env", env: "OPENAI_API_KEY" },
    // OpenAI's realtime input is 24 kHz pcm16 only.
    sampleRate: 24000,
    models: {
      "gpt-4o-mini-transcribe": { label: "GPT-4o mini Transcribe" },
      "gpt-realtime-whisper": { label: "GPT Realtime Whisper" },
    },
  },
  // vLLM's /v1/realtime ASR endpoint (e.g. Voxtral Realtime).
  "vllm-realtime": {
    label: "vLLM Realtime ASR (local)",
    protocol: "realtime-stt",
    dialect: "vllm",
    baseUrl: "ws://localhost:8000/v1/realtime",
    auth: { type: "none" },
    sampleRate: 16000,
    models: {
      "mistralai/Voxtral-Mini-4B-Realtime-2602": { label: "Voxtral Mini 4B Realtime" },
    },
  },
};

export const DEFAULT_TTS_ENDPOINTS: Record<string, SpeechTtsEndpointConfig> = {
  "openai-tts": {
    label: "OpenAI Speech",
    protocol: "openai-speech",
    auth: { type: "env", env: "OPENAI_API_KEY" },
    model: "gpt-4o-mini-tts",
    pcmSampleRate: 24000,
    voices: {
      alloy: { label: "Alloy" },
      marin: { label: "Marin" },
    },
  },
  // Local OpenAI-compatible streaming TTS (kokoro-fastapi; community
  // Qwen3-TTS servers expose the same surface).
  kokoro: {
    label: "Kokoro (local)",
    protocol: "openai-speech",
    baseUrl: "http://localhost:8880/v1",
    auth: { type: "none" },
    model: "kokoro",
    pcmSampleRate: 24000,
    voices: {
      af_bella: { label: "Bella" },
    },
  },
};

/** Overlay user-configured STT endpoints on top of the built-in defaults. */
export function mergeSttEndpoints(
  user: Record<string, SpeechSttEndpointConfig>,
): Record<string, SpeechSttEndpointConfig> {
  return { ...DEFAULT_STT_ENDPOINTS, ...user };
}

/** Overlay user-configured TTS endpoints on top of the built-in defaults. */
export function mergeTtsEndpoints(
  user: Record<string, SpeechTtsEndpointConfig>,
): Record<string, SpeechTtsEndpointConfig> {
  return { ...DEFAULT_TTS_ENDPOINTS, ...user };
}

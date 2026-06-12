import type {
  SpeechSttEndpointConfig,
  SpeechTtsEndpointConfig,
} from "../../../speech/profile-manager";

// Built-in speech endpoints shipped with the voice plugin, overlaid under the
// user's configured ones. Local vs cloud is config, not protocol: self-hosted
// services ride the same protocols and differ only by baseUrl + auth none.
// Site-specific endpoints (e.g. a DGX node) belong in user config — see
// .sloppy/config.example.yaml.
export const DEFAULT_STT_ENDPOINTS: Record<string, SpeechSttEndpointConfig> = {
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

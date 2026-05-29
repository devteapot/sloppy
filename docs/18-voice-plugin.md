# Voice Plugin (STT + TTS)

The `voice` first-party plugin adds speech-to-text and text-to-speech as SLOP
affordances. It is **runtime-only**: the plugin performs transcription/synthesis
through the runtime's endpoint + credential config and exposes the result over
SLOP. Audio **hardware** (microphone capture, speaker playback) is a surface
concern and is deliberately out of scope — see "Deferred" below.

## Shape

- **Service layer** (`src/stt/`, `src/tts/`) mirrors `src/llm/`: an adapter
  interface, per-protocol adapters, a factory, and a default-endpoint catalog.
- **`VoiceProfileManager`** (`src/voice/profile-manager.ts`) resolves a profile →
  endpoint → credential → adapter, reusing the shared `CredentialStore`
  (`src/llm/credential-store.ts`) with a `voice:` account prefix. It reports
  per-modality readiness (`ready | needs_credentials | not_configured`), so a
  partial pipeline (STT-only or TTS-only) is a first-class state.
- **`VoiceProvider`** (`src/plugins/first-party/voice/provider.ts`) is a SLOP
  server with `/session`, `/stt`, `/tts`, `/approvals` nodes and the affordances
  `transcribe`, `synthesize`, and `set_profile`. Audio crosses the SLOP boundary
  as base64 strings (affordance params/results are JSON), the same convention as
  image content blocks.
- **Session plugin** (`src/plugins/first-party/voice/session.ts`) mounts a
  `/voice` node onto the session provider and, when the active TTS profile has
  `autospeak` enabled, synthesizes each completed assistant turn in
  `onTurnComplete` and publishes the audio as a `voice` session extension for a
  future client to play.
- **Policy** (`src/plugins/first-party/voice/policy.ts`): `voiceNetworkRule`
  requires approval before audio/text is sent to a **non-local** endpoint. Local
  endpoints (`auth: { type: none }` + localhost `baseUrl`) run without a prompt.

Integration is one entry in `FIRST_PARTY_PLUGINS`
(`src/plugins/first-party/catalog.ts`); no changes to the agent loop, turn
coordinator, consumer/hub, or the TUI's curated client surface.

## Configuration

Nested under `plugins.voice` with independent `stt` and `tts` sections, each with
`endpoints`, `profiles`, and `defaultProfileId`. Cloud endpoints authenticate via
`auth: { type: env, env: ... }` or `secure_store`; local self-hosted servers use
`baseUrl` + `auth: { type: none }`. See `.sloppy/config.example.yaml`. Built-in
endpoint catalogs (`src/stt/catalog.ts`, `src/tts/catalog.ts`) cover OpenAI,
Deepgram, ElevenLabs, plus local faster-whisper, Kokoro, and Piper.

Local vs cloud is not a protocol distinction — local OpenAI-compatible servers
(faster-whisper-server, speaches, kokoro-fastapi, openedai-speech) ride the same
`openai-transcriptions` / `openai-speech` protocols and differ only by `baseUrl`
and `auth`, exactly like the `ollama` LLM endpoint.

## Deferred (surface follow-ups, not built)

- TUI push-to-talk mic capture and STT → `composer.send_message` re-entry.
- Client (TUI / native `apps/sloppy-voice`) playback of the `/voice` autospeak
  audio.
- Audio device selection; streaming STT (partial transcripts) and streaming TTS.
- Content-ref handling for large audio blobs (currently inlined as base64).

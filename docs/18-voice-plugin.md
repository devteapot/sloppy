# Voice Pipeline (Streaming STT + TTS)

The voice pipeline is **streaming-only**: host mic PCM → realtime STT session →
agent turn → sentence-pipelined TTS → streamed playback. There is no batch
path — no utterance capture, no `transcribe`/`synthesize` affordances, no
autospeak. Speech adapters are runtime infrastructure (like `src/llm/`); the
SLOP surface is configuration state plus the conversation loop's
`/conversation` node.

## Why a runtime-owned contract

There is no wire-format standard for realtime speech. Realtime STT is an
OpenAI-Realtime-*like* dialect family (OpenAI GA, vLLM, NVIDIA NIM, DashScope
all differ in event names and session config), and streaming TTS standardized
on chunked HTTP `/v1/audio/speech` rather than WebSockets. So the runtime owns
the semantic contract (`src/speech/types.ts`) and protocol adapters translate:

- **`SttProtocolAdapter` / `SttSession`** — PCM frames in; `partial` / `final` /
  `speech_started` / `speech_stopped` / `error` events out, plus a **`closed`
  event emitted exactly once per session** (local close, remote close, or
  transport error) so a consumer can never keep pumping audio into a dead
  socket unknowingly.
- **`TtsProtocolAdapter` / `TtsStream`** — incremental text in
  (`appendText`/`end`), strictly-ordered PCM chunks out, `abort()` for
  immediate silence. The text input is incremental by contract so a future
  mid-turn token tap needs no adapter changes, even though today the loop
  pushes the complete reply once.

## Registry

`src/speech/registry.ts` maps protocol ids to adapter factories. Protocols are
**plain strings in config**, validated at registry lookup — an unknown protocol
surfaces as the profile's `invalidReason`, not a config-load crash — so plugins
can register new providers (ElevenLabs, Cartesia, vendor WS dialects) without
touching the runtime. First-party registrations (`src/speech/register.ts`):

- **`realtime-stt`** (`src/speech/realtime-stt/`) — one WebSocket session core
  plus per-endpoint `dialect` maps:
  - `openai` (default): GA transcription sessions — `?intent=transcription`,
    `session: { type: "transcription", audio: { input: { format, transcription,
    turn_detection } } }`, `conversation.item.input_audio_transcription.delta/
    completed` events. Targets OpenAI cloud and OpenAI-compatible services (the
    DGX Nemotron ASR service, speaches).
  - `vllm`: vLLM's `/v1/realtime` ASR (`transcription.delta` /
    `transcription.done`), e.g. Voxtral Realtime.
  A dialect owns only naming and payload shapes (~40 lines); the session core
  owns the socket lifecycle, auth, base64 audio framing, and closed-event
  semantics. New dialects (NVIDIA NIM, DashScope) are additive map entries.
- **`openai-speech`** (`src/speech/openai-speech.ts`) — streaming TTS over
  `POST /v1/audio/speech` with `response_format: "pcm"`. Replies are normalized
  for speech (markdown stripped, code fences dropped — `src/speech/segment.ts`)
  and split into sentences; sentence N+1's request is prefetched while N's
  audio drains, so time-to-first-audio is one sentence, not the whole reply.
  Covers OpenAI cloud (`gpt-4o-mini-tts`), Kokoro-FastAPI, and community
  Qwen3-TTS servers.

**Sample rates are per-endpoint config**, not constants: STT endpoints declare
the PCM16 rate the service expects (`sampleRate`, default 16000 — OpenAI cloud
requires 24000), TTS endpoints declare their PCM output rate (`pcmSampleRate`,
default 24000). The mic capture command, frame chunking, and playback all
derive from these (command templates take a `{rate}` token).

## Profiles and credentials

**`SpeechProfileManager`** (`src/speech/profile-manager.ts`) mirrors
`LlmProfileManager`: profile → endpoint → credential → adapter (via the
registry), with per-profile fingerprint caching. It reuses the shared
`CredentialStore` under a `voice:` account prefix and reports per-modality
readiness (`ready | needs_credentials | not_configured`) — STT-only or
TTS-only is a first-class state. `activeSttEndpoint()`/`activeTtsEndpoint()`
expose the exact endpoint the next adapter will use, so the network policy
can never diverge from what actually receives audio.

**`VoiceProvider`** (`src/plugins/first-party/voice/provider.ts`) is the SLOP
surface for configuration only: `/session`, `/stt`, `/tts` readiness state and
`set_profile` actions. Audio never crosses the SLOP boundary here.

## Conversation loop

`src/plugins/first-party/voice-conversation/session.ts` mounts `/conversation`
and drives a half-duplex state machine:

```
idle → connecting → listening → thinking → speaking → (continuous: re-arm)
       needs_approval (non-local autostart)    restarting (backoff on session loss)
```

- The STT provider does VAD; only `final` transcripts start plugin turns.
- Unexpected session closes in continuous mode reconnect with exponential
  backoff (500ms·2ⁿ, capped at 30s; reset once audio flows again). Sessions
  reconnect per turn — cheap against local services, and sidesteps long-lived
  realtime-session instability.
- `stop_listening` aborts the mic stream, the STT session, in-flight TTS, and
  playback; a stop during `thinking` suppresses the spoken reply.
- Live state (`phase`, `partial_transcript`, `connected`, `restart_attempt`)
  publishes through a session **extension record** (namespace
  `voice-conversation`) — store changes are what refresh the session provider,
  so closure state alone would never reach clients. Partial-transcript patches
  are throttled to ~6/s with a trailing flush.
- Audio I/O is swappable (`audio.backend`): `host` shells out to sox
  (`sox -d … -t raw -` capture, `play … -t raw -` playback, both
  `{rate}`-templated); `robot` routes through the reachy provider's
  `/mic`/`/speaker` affordances (playback collects the stream into one WAV
  clip per reply).

## Privacy boundary

`createSpeechNetworkRule` (`src/plugins/first-party/voice/policy.ts`) gates the
session provider's **`start_listening`** action — the moment audio starts
flowing — because the streaming sessions themselves are opened in-process, not
via affordance invokes. It requires approval unless **both** active endpoints
are local (`auth: { type: none }` + localhost URL, `http(s)`/`ws(s)` alike);
after approval the hub re-invokes with `preApproved: true`. Continuous
auto-start (`realtime.autoStartMode: continuous`) only proceeds when both
endpoints are local; otherwise the loop parks in `needs_approval` until
`start_listening` is invoked through the hub.

## Configuration

Nested under `plugins.voice` (`stt`/`tts` × `endpoints`/`profiles`/
`defaultProfileId`) and `plugins.voice-conversation` (audio commands, autostart
mode, embodiment). See `.sloppy/config.example.yaml`. Built-in endpoint
catalogs (`src/speech/catalog.ts`): `dgx-nemotron`, `openai-realtime`,
`vllm-realtime`, `openai-tts`, `kokoro`.

## Deferred (follow-ups, not built)

- Mid-turn token streaming into TTS (sentence-chunked synthesis *during* the
  agent turn) — needs a plugin hook for LLM token deltas; the `TtsStream`
  contract already accepts incremental text.
- Warm STT sessions across turns (config knob) once long-lived realtime
  sessions prove stable.
- WS TTS dialects: DashScope `qwen3-tts-flash-realtime`, vLLM-Omni
  `/v1/audio/speech/stream`, NVIDIA NIM `intent=synthesize` — additive registry
  entries.
- Barge-in (interrupting playback by voice) — requires echo cancellation;
  the loop is deliberately half-duplex today.
- TUI push-to-talk and client-side playback surfaces.

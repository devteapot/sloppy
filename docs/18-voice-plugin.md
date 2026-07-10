# Voice Pipeline (Streaming STT + TTS)

The voice pipeline is **streaming-only**: host mic PCM → realtime STT session →
agent turn → sentence-pipelined TTS → streamed playback. There is no batch
path — no utterance capture, no `transcribe`/`synthesize` affordances, no
autospeak. Speech adapters are runtime infrastructure (like `src/llm/`); the
SLOP surface is configuration state plus the conversation loop's
`/conversation` node.

`voice` is one first-party Plugin and the sole catalog ownership unit for this
pipeline. Its descriptor owns the configuration Provider, the `/conversation`
Session plugin, UI contribution manifest, doctor checks, and
host-command probes. The source directory `voice-conversation/` is an internal
implementation location, not a second Plugin identity.

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
touching the runtime. The registry singleton starts **empty**: `src/speech/`
contains zero protocol/vendor knowledge (contract, registry, profile manager,
segmenter, and generic streaming helpers in `src/speech/streaming.ts` —
`waitForOpen`, a closed-once guard, `AsyncChunkQueue`). The first-party
bindings live in the voice plugin
(`src/plugins/first-party/voice/protocols/`) and are registered idempotently
by `registerSpeechProtocols` when `speechManagerFor` (catalog.ts) first runs:

- **`realtime-stt`** (`voice/protocols/realtime-stt/`) — one WebSocket session
  core plus per-endpoint `dialect` maps:
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
- **`openai-speech`** (`voice/protocols/openai-speech.ts`) — streaming TTS over
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
expose the exact endpoints captured into the next immutable voice run. The
public run identity is derived from process-scoped keyed routing fingerprints,
so route changes invalidate a prepared run without exposing an offline verifier
for credential-bearing URL queries or header values. The
registry and default endpoints are constructor-injected; construct managers through
`speechManagerFor` (catalog.ts) — a bare `new SpeechProfileManager(...)` sees
the empty singleton and resolves every profile to `Unknown protocol`.

**`VoiceProvider`** (`src/plugins/first-party/voice/provider.ts`) is the SLOP
surface for configuration only: `/session`, `/stt`, `/tts` readiness state and
`set_profile` actions. Audio never crosses the SLOP boundary here.

## Conversation loop

The `voice` Plugin's Session facet, implemented in
`src/plugins/first-party/voice-conversation/session.ts`, mounts `/conversation`
and drives a half-duplex state machine. Its phase and partial-caption State is
transient Session-plugin State: it refreshes the Session provider but is never
written into durable Session snapshots or `/extensions`:

```
idle → preparing → needs_approval → acquiring → connecting → listening
     → queued/thinking → speaking → cleaning → (continuous: re-arm or idle)
                                      restarting (backoff on session loss)
```

- The STT provider does VAD; only `final` transcripts start plugin turns.
- Unexpected session closes in continuous mode reconnect with exponential
  backoff (500ms·2ⁿ, capped at 30s; reset once audio flows again). Sessions
  reconnect per turn — cheap against local services, and sidesteps long-lived
  realtime-session instability.
- `stop_listening` aborts the mic stream, the STT session, in-flight TTS, and
  playback; a stop during `thinking` suppresses the spoken reply.
- `cleaning` means audio ownership is still being released. Start is absent
  until cleanup reaches `idle`; a failed release publishes `error` and retains
  stop so cleanup can be retried.
- Live state (`phase`, `partial_transcript`, `connected`, frozen endpoints,
  and audio-resource owners) publishes through transient Session-plugin State.
  It refreshes the Session provider without entering durable snapshots.
  Partial-transcript updates are throttled to ~6/s with a trailing flush.
- Audio input and output are separate adapter seams. The compatibility
  `audio.backend: host` composition shells out to sox
  (`sox -d … -t raw -` capture, `play … -t raw -` playback, both
  `{rate}`-templated). Provider-backed input and output adapters support robot
  integrations without changing the conversation controller; the current
  `robot` compatibility composition has playback only and doctor rejects it for
  realtime conversation until a streaming microphone adapter is configured.
- **Inline emote markers** (`embodiment.emotes`, default on with embodiment):
  voice replies may embed `[emote:name]` markers where the mood shifts.
  `speak()` strips them
  (`emote-markers.ts` — they survive `normalizeForSpeech`, so stripping happens
  before any text reaches a TTS stream), validates names against the robot
  provider's `/behavior` `props.emotions` (vocabulary unavailable → fire
  unvalidated, the provider rejects bad names), and splits the reply into
  sequential speech segments. `ReachyEmbodimentAdapter` owns every Reachy path,
  emotion invocation, head/antenna cadence, busy behavior, and barge-in stop;
  `NullEmbodimentAdapter` is the second adapter at the same seam. The generic
  conversation controller knows only semantic emote names.

## Privacy seam

The Session plugin gates its public **`start_listening`** action at the actual
data-egress seam. Before opening an audio device or speech transport it freezes
the selected profiles and destinations into an immutable run plan. Local plans
start immediately; remote plans create a Session-native approval whose callback
is the only path that can begin that exact plan. Continuous reconnects reuse the
same approved plan. Profile changes stop the run, so a later destination always
requires a fresh start and, when remote, fresh explicit approval. Remote voice
egress approvals set `autoApprovable: false`; Session `approval_mode=auto` never
resolves them.
Preparation is abortable and bounded (15 seconds by default), so stop, profile
change, or shutdown cannot leave credential/config resolution holding the
Session lifecycle open indefinitely.

## Configuration

All configuration is nested under the single `plugins.voice` Plugin:
`stt`/`tts` contain endpoints, profiles, and default profile ids, while
`conversation` contains audio commands, autostart mode, and embodiment. The
loader migrates the former `plugins.voice-conversation` key into
`plugins.voice.conversation` per config layer so a legacy workspace override
retains its normal precedence. See `.sloppy/config.example.yaml`. Built-in
endpoint defaults (`src/plugins/first-party/voice/endpoints.ts`): `openai-realtime`,
`vllm-realtime`, `openai-tts`, `kokoro`. Site-specific endpoints (e.g. a DGX
node) are user config, fully defined in YAML — there is no built-in for them.

The Session facet publishes typed client commands for single-turn start,
continuous start, and stop, plus a client-agnostic contribution manifest with a
phase indicator and approval/error notifications. Live values come from the
generic typed Session `pluginState.voice` entry. UIs consume those contributions
without SLOP subscriptions or voice-specific rendering branches.

`runtime:doctor` validates selected profile references, the requirement for an
STT profile when conversation is enabled, and host/robot backend consistency.
For host audio it also reports the configured capture and playback executables
through the shared subprocess-probe check; doctor never opens an audio device.

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

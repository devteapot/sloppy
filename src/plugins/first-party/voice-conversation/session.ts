import { action, type NodeDescriptor } from "@slop-ai/server";

import type { VoiceConversationPluginConfig } from "../../../config/schema";
import { createExtensionRecord, now } from "../../../session/plugins";
import type {
  PluginRuntimeContext,
  PluginTurnCompleteEvent,
  PluginTurnFailureEvent,
  SessionRuntimePlugin,
} from "../../../session/plugins/types";
import type { JsonObject } from "../../../session/types";
import type { SpeechProfileManager } from "../../../speech/profile-manager";
import type { SttSession, SttSessionEvent, TtsStream } from "../../../speech/types";
import { endpointIsLocal } from "../voice/policy";
import { type AudioBackend, type AudioStreamSource, createAudioBackend } from "./audio-backend";

const PLUGIN_ID = "voice-conversation";
export const CONVERSATION_EXTENSION_NAMESPACE = "voice-conversation";
const EXTENSION_INSTANCE_ID = "live";
const EXTENSION_SCHEMA_VERSION = 2;

type Phase =
  | "idle"
  | "needs_approval"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "restarting";
type ListenMode = "single_turn" | "continuous";

// Restart backoff for unexpected session closes in continuous mode.
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 30000;
// Partial transcripts publish at most ~6/s (with a trailing flush) so live
// captions don't spam the session store.
const PARTIAL_PUBLISH_INTERVAL_MS = 150;
// Head-animation cadence and amplitudes (degrees / radians) while speaking.
const ANIMATE_INTERVAL_MS = 100;
const HEAD_PITCH_DEG = 6;
const HEAD_YAW_DEG = 10;
const ANTENNA_RAD = 0.25;

export type VoiceConversationPluginOptions = {
  /** Injectable delay for restart-backoff tests. */
  delayFn?: (ms: number) => Promise<void>;
};

/**
 * Streaming voice conversation loop: mic PCM → realtime STT session (provider
 * VAD; final transcripts start plugin turns) → streamed TTS → streamed
 * playback. Live state (phase, partial transcripts, connection health) is
 * published through a session extension record so the /conversation node
 * actually refreshes — closure state alone never would.
 *
 * The privacy boundary is the session provider's start_listening action:
 * `createSpeechNetworkRule` requires approval when either speech endpoint is
 * non-local, and continuous auto-start only proceeds for local endpoints
 * (otherwise the loop parks in `needs_approval` until start_listening is
 * invoked through the hub).
 */
export function createVoiceConversationPlugin(
  config: VoiceConversationPluginConfig,
  voiceProfiles?: SpeechProfileManager,
  options?: VoiceConversationPluginOptions,
): SessionRuntimePlugin {
  const enabled = config.enabled;
  const delayFn = options?.delayFn ?? ((ms: number) => delay(ms));

  let backend: AudioBackend | null = null;
  let running = false;
  let phase: Phase = "idle";
  let listenMode: ListenMode | null = null;
  let startInProgress = false;
  let turnInFlight = false;
  let stopRequested = false;
  let runSeq = 0;
  let sessionGen = 0;
  let connected = false;
  let partialTranscript = "";
  let lastTranscript = "";
  let lastError = "";
  let restartAttempt = 0;
  let restartScheduled = false;
  let selectedSttProfile: string | undefined;
  let selectedTtsProfile: string | undefined;

  let listenAbort: AbortController | null = null;
  let sttSession: SttSession | null = null;
  let audioStream: AudioStreamSource | null = null;
  let speakAbort: AbortController | null = null;
  let ttsStream: TtsStream | null = null;

  let lastPartialPublishAt = 0;
  let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function logError(ctx: PluginRuntimeContext, where: string, error: unknown): void {
    ctx.audit({
      kind: "voice_conversation_error",
      where,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  function liveState(): JsonObject {
    return {
      phase,
      mode: listenMode,
      connected,
      partial_transcript: partialTranscript,
      last_transcript: lastTranscript,
      restart_attempt: restartAttempt,
      error: lastError || undefined,
      stt_profile: selectedSttProfile,
      tts_profile: selectedTtsProfile,
      updated_at: now(),
    } as JsonObject;
  }

  function publish(ctx: PluginRuntimeContext): void {
    if (!ctx.snapshot().extensions[CONVERSATION_EXTENSION_NAMESPACE]) {
      ctx.store.upsertExtension(
        createExtensionRecord({
          namespace: CONVERSATION_EXTENSION_NAMESPACE,
          instanceId: EXTENSION_INSTANCE_ID,
          schemaVersion: EXTENSION_SCHEMA_VERSION,
          owner: { kind: "runtime", id: PLUGIN_ID, version: "2.0.0" },
          state: liveState(),
          cleanupPolicy: {
            mode: "manual",
            description: "Live conversation-loop state; rewritten in place while the loop runs.",
          },
        }),
      );
      return;
    }
    ctx.store.patchExtension(CONVERSATION_EXTENSION_NAMESPACE, (record) => {
      record.state = liveState();
      return record;
    });
  }

  function publishPartial(ctx: PluginRuntimeContext): void {
    const nowMs = Date.now();
    const elapsed = nowMs - lastPartialPublishAt;
    if (elapsed >= PARTIAL_PUBLISH_INTERVAL_MS) {
      lastPartialPublishAt = nowMs;
      publish(ctx);
      return;
    }
    if (!partialFlushTimer) {
      partialFlushTimer = setTimeout(() => {
        partialFlushTimer = null;
        lastPartialPublishAt = Date.now();
        publish(ctx);
      }, PARTIAL_PUBLISH_INTERVAL_MS - elapsed);
    }
  }

  function clearPartialTimer(): void {
    if (partialFlushTimer) {
      clearTimeout(partialFlushTimer);
      partialFlushTimer = null;
    }
  }

  async function bothEndpointsLocal(): Promise<boolean> {
    if (!voiceProfiles) {
      return false;
    }
    const [stt, tts] = await Promise.all([
      voiceProfiles.activeSttEndpoint(),
      voiceProfiles.activeTtsEndpoint(),
    ]);
    const sttLocal = stt ? endpointIsLocal(stt.config.auth, stt.config.baseUrl) : true;
    const ttsLocal = tts ? endpointIsLocal(tts.config.auth, tts.config.baseUrl) : true;
    return sttLocal && ttsLocal;
  }

  function startListening(
    ctx: PluginRuntimeContext,
    requestedMode?: ListenMode,
  ): Record<string, unknown> {
    if (!enabled || !running || !backend) {
      return { status: "disabled", phase };
    }
    if (
      startInProgress ||
      turnInFlight ||
      phase === "connecting" ||
      phase === "listening" ||
      phase === "restarting" ||
      phase === "speaking"
    ) {
      return { status: "already_active", phase, mode: listenMode };
    }

    // Synchronous guard: a second start_listening invoke racing this one must
    // see it before the first await.
    startInProgress = true;
    try {
      const mode = requestedMode ?? config.realtime.defaultStartMode;
      listenMode = mode;
      stopRequested = false;
      restartAttempt = 0;
      partialTranscript = "";
      lastError = "";
      void listenLoop(ctx, mode);
      return { status: "started", phase, mode };
    } finally {
      startInProgress = false;
    }
  }

  function stopListening(ctx: PluginRuntimeContext): Record<string, unknown> {
    listenMode = null;
    if (turnInFlight) {
      stopRequested = true;
    }
    closeActiveAudio();
    speakAbort?.abort();
    ttsStream?.abort();
    if (!turnInFlight) {
      phase = "idle";
    }
    publish(ctx);
    return { status: "stopped", phase };
  }

  /** One listening run: connect a realtime STT session and pump mic frames. */
  async function listenLoop(ctx: PluginRuntimeContext, mode: ListenMode): Promise<void> {
    if (!running || !backend || listenMode !== mode || turnInFlight) {
      return;
    }
    if (!voiceProfiles) {
      logError(ctx, "listen_start", new Error("No speech profile manager available."));
      phase = "idle";
      publish(ctx);
      return;
    }

    phase = "connecting";
    connected = false;
    publish(ctx);

    const controller = new AbortController();
    listenAbort = controller;
    const gen = ++sessionGen;

    try {
      await refreshSelectedProfiles();
      const adapter = await voiceProfiles.createSttAdapter();
      if (bail()) {
        return;
      }
      const session = await adapter.startSession({
        signal: controller.signal,
        onEvent: (event) => handleSttEvent(ctx, gen, mode, event),
      });
      sttSession = session;
      if (bail()) {
        session.close();
        return;
      }
      phase = "listening";
      connected = true;
      publish(ctx);

      audioStream = backend.openStream?.(controller.signal, adapter.inputFormat.sampleRate) ?? null;
      if (!audioStream) {
        throw new Error("Audio backend does not support PCM streaming.");
      }
      for await (const frame of audioStream.frames(controller.signal)) {
        if (bail()) {
          break;
        }
        await session.appendAudio(frame);
        // A first healthy frame exchange resets the restart backoff.
        restartAttempt = 0;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        lastError = error instanceof Error ? error.message : String(error);
        logError(ctx, "realtime_stream", error);
        scheduleRestartOrIdle(ctx, mode);
      }
    } finally {
      if (listenAbort === controller) {
        listenAbort = null;
      }
      if (!controller.signal.aborted) {
        closeActiveAudio({ keepMode: true });
      }
    }

    function bail(): boolean {
      return (
        controller.signal.aborted ||
        !running ||
        listenMode !== mode ||
        turnInFlight ||
        stopRequested
      );
    }
  }

  function handleSttEvent(
    ctx: PluginRuntimeContext,
    gen: number,
    mode: ListenMode,
    event: SttSessionEvent,
  ): void {
    if (gen !== sessionGen) {
      return; // stale session
    }
    switch (event.type) {
      case "partial":
        partialTranscript = event.text;
        publishPartial(ctx);
        break;
      case "final": {
        const transcript = event.text.trim();
        partialTranscript = "";
        if (!transcript) {
          publish(ctx);
          return;
        }
        lastTranscript = transcript;
        closeActiveAudio({ keepMode: true });
        startPluginTurn(ctx, mode, transcript);
        break;
      }
      case "error":
        lastError = event.message;
        logError(ctx, "realtime_event", new Error(event.message));
        break;
      case "closed":
        connected = false;
        if (
          event.cause !== "local" &&
          running &&
          !turnInFlight &&
          listenMode === mode &&
          (phase === "listening" || phase === "connecting")
        ) {
          lastError = event.reason ?? `session closed (${event.cause})`;
          logError(ctx, "realtime_closed", new Error(lastError));
          scheduleRestartOrIdle(ctx, mode);
        } else {
          publish(ctx);
        }
        break;
      default:
        break;
    }
  }

  /** Unexpected session loss: back off and reconnect (continuous) or go idle. */
  function scheduleRestartOrIdle(ctx: PluginRuntimeContext, mode: ListenMode): void {
    if (restartScheduled) {
      return;
    }
    closeActiveAudio({ keepMode: true });
    if (!running || listenMode !== mode || mode !== "continuous") {
      phase = "idle";
      if (mode !== "continuous") {
        listenMode = null;
      }
      publish(ctx);
      return;
    }
    restartScheduled = true;
    restartAttempt += 1;
    phase = "restarting";
    publish(ctx);
    const delayMs = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** (restartAttempt - 1),
      RESTART_MAX_DELAY_MS,
    );
    void (async () => {
      try {
        await delayFn(delayMs);
      } finally {
        restartScheduled = false;
      }
      if (running && listenMode === mode && phase === "restarting") {
        void listenLoop(ctx, mode);
      }
    })();
  }

  function startPluginTurn(ctx: PluginRuntimeContext, mode: ListenMode, transcript: string): void {
    phase = "thinking";
    turnInFlight = true;
    publish(ctx);
    try {
      ctx.startTurn({
        pluginId: PLUGIN_ID,
        runId: `vc-${++runSeq}`,
        text: transcript,
        author: "reachy-voice",
        role: "user",
      });
    } catch (error) {
      // Coordinator busy (e.g. an interleaved user turn); drop this utterance
      // and resume listening.
      turnInFlight = false;
      logError(ctx, "start_turn", error);
      phase = "idle";
      publish(ctx);
      if (running && listenMode === mode) {
        void listenLoop(ctx, mode);
      }
    }
  }

  async function speak(ctx: PluginRuntimeContext, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !backend || !voiceProfiles) {
      return;
    }
    const controller = new AbortController();
    speakAbort = controller;
    let stream: TtsStream | null = null;
    try {
      await refreshSelectedProfiles();
      const adapter = await voiceProfiles.createTtsAdapter();
      if (controller.signal.aborted) {
        return;
      }
      stream = adapter.openStream({ signal: controller.signal });
      ttsStream = stream;
      stream.appendText(trimmed);
      stream.end();

      // Animate the head for the duration of playback; stop the moment it ends.
      const animateController = new AbortController();
      const animation = animateHead(ctx, animateController.signal);
      try {
        await backend.playStream(stream.format, stream.chunks(), controller.signal);
      } finally {
        animateController.abort();
        await animation;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logError(ctx, "speak", error);
      }
    } finally {
      stream?.abort();
      if (ttsStream === stream) {
        ttsStream = null;
      }
      if (speakAbort === controller) {
        speakAbort = null;
      }
    }
  }

  /** Runtime-driven head/antenna motion while speaking. No-op without embodiment. */
  async function animateHead(ctx: PluginRuntimeContext, signal: AbortSignal): Promise<void> {
    if (!config.embodiment.enabled) {
      return;
    }
    const providerId = config.embodiment.providerId;
    const start = Date.now();
    while (!signal.aborted) {
      const t = (Date.now() - start) / 1000;
      try {
        await ctx.invokeProvider(providerId, "/head", "set_pose", {
          pitch: HEAD_PITCH_DEG * Math.sin(t * 6),
          roll: 0,
          yaw: HEAD_YAW_DEG * Math.sin(t * 2.3),
          z: 0,
        });
        await ctx.invokeProvider(providerId, "/head", "set_antennas", {
          right: ANTENNA_RAD * Math.sin(t * 7),
          left: ANTENNA_RAD * Math.sin(t * 7 + Math.PI / 2),
        });
      } catch (error) {
        // Provider not connected (e.g. host-only dev) — stop animating quietly.
        logError(ctx, "animate", error);
        return;
      }
      await delay(ANIMATE_INTERVAL_MS, signal);
    }
  }

  async function refreshSelectedProfiles(): Promise<void> {
    if (!voiceProfiles) {
      return;
    }
    const [stt, tts] = await Promise.all([
      voiceProfiles.getSttState(),
      voiceProfiles.getTtsState(),
    ]);
    selectedSttProfile = stt.activeProfileId;
    selectedTtsProfile = tts.activeProfileId;
  }

  function closeActiveAudio(options: { keepMode?: boolean } = {}): void {
    listenAbort?.abort();
    listenAbort = null;
    audioStream?.close();
    audioStream = null;
    sttSession?.close();
    sttSession = null;
    connected = false;
    if (!options.keepMode) {
      listenMode = null;
    }
  }

  return {
    id: PLUGIN_ID,
    version: "2.0.0",
    description:
      "Streaming voice conversation loop (mic PCM → realtime STT → turn → streamed TTS → playback).",
    defaultEnabled: false,
    providerIds: config.embodiment.enabled ? ["voice", config.embodiment.providerId] : ["voice"],
    extensionNamespaces: [CONVERSATION_EXTENSION_NAMESPACE],
    sessionNodes: (ctx) => [
      {
        path: "/conversation",
        build: () =>
          buildConversationNode({
            enabled,
            config,
            snapshotState: ctx.snapshot().extensions[CONVERSATION_EXTENSION_NAMESPACE]?.state,
            startListening: (mode) => startListening(ctx, mode),
            stopListening: () => stopListening(ctx),
          }),
      },
    ],
    onStartup: async (ctx) => {
      if (!enabled) {
        return;
      }
      backend = createAudioBackend(config.audio, ctx.invokeProvider);
      running = true;
      await refreshSelectedProfiles().catch(() => {});
      publish(ctx);
      if (config.realtime.autoStartMode === "continuous") {
        if (await bothEndpointsLocal()) {
          startListening(ctx, "continuous");
        } else {
          // Non-local endpoint: starting would stream mic audio off-machine
          // without the policy gate, so park until start_listening is invoked
          // through the hub (where the approval flow runs).
          phase = "needs_approval";
          publish(ctx);
          ctx.audit({
            kind: "voice_conversation_needs_approval",
            reason: "continuous auto-start skipped: non-local speech endpoint",
          });
        }
      }
    },
    onTurnComplete: (event: PluginTurnCompleteEvent, ctx) => {
      if (event.pluginTurn.pluginId !== PLUGIN_ID) {
        return;
      }
      turnInFlight = false;
      if (!running) {
        return;
      }
      if (stopRequested) {
        stopRequested = false;
        phase = "idle";
        listenMode = null;
        publish(ctx);
        return;
      }
      const reply = event.result.status === "completed" ? event.result.response : "";
      phase = "speaking";
      publish(ctx);
      void (async () => {
        await speak(ctx, reply);
        phase = "idle";
        publish(ctx);
        if (running && listenMode === "continuous") {
          startListening(ctx, "continuous");
        } else if (listenMode !== "continuous") {
          listenMode = null;
        }
      })();
    },
    onTurnFailure: (event: PluginTurnFailureEvent, ctx) => {
      if (event.pluginTurn.pluginId !== PLUGIN_ID) {
        return;
      }
      turnInFlight = false;
      stopRequested = false;
      phase = "idle";
      publish(ctx);
      if (running && listenMode === "continuous") {
        startListening(ctx, "continuous");
      } else if (listenMode !== "continuous") {
        listenMode = null;
      }
    },
    onShutdown: (ctx) => {
      running = false;
      clearPartialTimer();
      closeActiveAudio();
      speakAbort?.abort();
      ttsStream?.abort();
      backend?.dispose();
      backend = null;
      phase = "idle";
      publish(ctx);
    },
  };
}

function buildConversationNode(input: {
  enabled: boolean;
  config: VoiceConversationPluginConfig;
  snapshotState: JsonObject | undefined;
  startListening: (mode?: ListenMode) => Record<string, unknown>;
  stopListening: () => Record<string, unknown>;
}): NodeDescriptor {
  const live = input.snapshotState ?? {};
  return {
    type: "context",
    props: {
      enabled: input.enabled,
      audio_backend: input.config.audio.backend,
      phase: live.phase ?? "idle",
      listening_mode: live.mode ?? null,
      connected: live.connected ?? false,
      partial_transcript: (live.partial_transcript as string) || undefined,
      last_transcript: (live.last_transcript as string) || undefined,
      restart_attempt: live.restart_attempt ?? 0,
      error: (live.error as string) || undefined,
      stt_profile: live.stt_profile,
      tts_profile: live.tts_profile,
      embodiment: input.config.embodiment.enabled,
      embodiment_provider: input.config.embodiment.enabled
        ? input.config.embodiment.providerId
        : undefined,
    },
    summary:
      "Streaming voice conversation loop: listen → think → speak. Mic PCM streams to the " +
      "active realtime STT profile (provider VAD); final transcripts start turns; replies " +
      "stream back through TTS. Starting a non-local pipeline requires approval.",
    actions: {
      start_listening: action(
        {
          mode: {
            type: "string",
            description: "Listening mode: single_turn or continuous.",
            optional: true,
          },
        },
        async ({ mode }) =>
          input.startListening(normalizeListenMode(mode, input.config.realtime.defaultStartMode)),
        {
          label: "Start Listening",
          description:
            "Open the microphone stream and start realtime transcription. Requires approval when a speech endpoint is non-local.",
          estimate: "instant",
        },
      ),
      stop_listening: action(async () => input.stopListening(), {
        label: "Stop Listening",
        description: "Stop voice capture, transcription, and any in-progress speech.",
        estimate: "instant",
      }),
    },
  };
}

function normalizeListenMode(value: unknown, fallback: ListenMode): ListenMode {
  return value === "continuous" || value === "single_turn" ? value : fallback;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

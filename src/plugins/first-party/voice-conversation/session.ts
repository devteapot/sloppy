import { action, type NodeDescriptor } from "@slop-ai/server";

import type { VoiceConversationPluginConfig } from "../../../config/schema";
import type {
  PluginRuntimeContext,
  PluginTurnCompleteEvent,
  PluginTurnFailureEvent,
  SessionRuntimePlugin,
} from "../../../session/plugins/types";
import type { JsonObject, QueuedSessionMessage } from "../../../session/types";
import type { SpeechProfileManager } from "../../../speech/profile-manager";
import type { SttSession, SttSessionEvent, TtsStream } from "../../../speech/types";
import { type PreparedVoiceRun, prepareVoiceRun, type VoiceRunExecution } from "../voice/run-plan";
import { type AudioBackend, type AudioStreamSource, createAudioBackend } from "./audio-backend";
import {
  AudioResourceArbiter,
  type AudioResourceLease,
  type AudioResourceLeaseState,
} from "./audio-resource-arbiter";
import {
  type EmbodimentAdapter,
  NullEmbodimentAdapter,
  ReachyEmbodimentAdapter,
  type SpeakingEmbodiment,
} from "./embodiment-adapter";
import { type EmoteSegment, hasEmoteMarkers, parseEmoteMarkers } from "./emote-markers";

const PLUGIN_ID = "voice";
const audioResourceArbiter = new AudioResourceArbiter();

type Phase =
  | "idle"
  | "preparing"
  | "needs_approval"
  | "acquiring"
  | "connecting"
  | "listening"
  | "queued"
  | "thinking"
  | "speaking"
  | "cleaning"
  | "restarting"
  | "error";
type ListenMode = "single_turn" | "continuous";

// Restart backoff for unexpected session closes in continuous mode.
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 30000;
// Partial transcripts publish at most ~6/s (with a trailing flush) so live
// captions don't spam the session store.
const PARTIAL_PUBLISH_INTERVAL_MS = 150;

export type VoiceConversationPluginOptions = {
  /** Injectable delay for restart-backoff tests. */
  delayFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable arbiter for isolated Session tests. */
  resourceArbiter?: Pick<AudioResourceArbiter, "acquire" | "state" | "subscribe"> &
    Partial<Pick<AudioResourceArbiter, "subscribeErrors">>;
  /** Bound credential/config preparation so stop and shutdown cannot hang forever. */
  prepareTimeoutMs?: number;
};

/**
 * Streaming voice conversation loop: mic PCM → realtime STT session (provider
 * VAD; final transcripts start plugin turns) → streamed TTS → streamed
 * playback. Live state is transient Plugin State: observable through the
 * Session provider but never written into durable Session snapshots.
 *
 * The public start action resolves an immutable run plan before any audio
 * resource or network stream opens. Remote egress begins only from the
 * Session-native approval callback for that exact plan.
 */
export function createVoiceConversationPlugin(
  config: VoiceConversationPluginConfig,
  voiceProfiles?: SpeechProfileManager,
  options?: VoiceConversationPluginOptions,
): SessionRuntimePlugin {
  const enabled = config.enabled;
  const delayFn = options?.delayFn ?? ((ms: number) => delay(ms));
  const arbiter = options?.resourceArbiter ?? audioResourceArbiter;
  const prepareTimeoutMs = options?.prepareTimeoutMs ?? 15000;

  let backend: AudioBackend | null = null;
  let embodiment: EmbodimentAdapter = new NullEmbodimentAdapter();
  let running = false;
  let phase: Phase = "idle";
  let listenMode: ListenMode | null = null;
  let startInProgress = false;
  let turnInFlight = false;
  let stopRequested = false;
  let runSeq = 0;
  let startGeneration = 0;
  let sessionGen = 0;
  let connected = false;
  let partialTranscript = "";
  let lastTranscript = "";
  let lastError = "";
  let restartAttempt = 0;
  let restartScheduled = false;
  let restartAbort: AbortController | null = null;
  let selectedSttProfile: string | undefined;
  let selectedTtsProfile: string | undefined;
  let preparedRun: PreparedVoiceRun | null = null;
  let run: VoiceRunExecution | null = null;
  let pendingApprovalId: string | null = null;
  let pendingPreparation: Promise<PreparedVoiceRun> | null = null;
  let preparationAbort: AbortController | null = null;
  let preparationTimeout: ReturnType<typeof setTimeout> | null = null;
  let audioLease: AudioResourceLease | null = null;
  let pendingAudioLease: Promise<AudioResourceLease> | null = null;
  let cleanupTask: Promise<void> | null = null;
  let unsubscribeProfileSelection: (() => void) | null = null;
  let unsubscribeAudioResources: (() => void) | null = null;
  let unsubscribeAudioResourceErrors: (() => void) | null = null;
  let audioResourceState: AudioResourceLeaseState[] = [];
  const queuedVoiceRuns = new Map<string, string>();

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
      enabled,
      phase,
      mode: listenMode,
      connected,
      partial_transcript: partialTranscript,
      last_transcript: lastTranscript,
      restart_attempt: restartAttempt,
      error: lastError || undefined,
      stt_profile: selectedSttProfile,
      tts_profile: selectedTtsProfile,
      run_id: run?.plan.id ?? preparedRun?.plan.id,
      run_fingerprint: run?.plan.fingerprint ?? preparedRun?.plan.fingerprint,
      stt_endpoint: run?.plan.stt.endpointId ?? preparedRun?.plan.stt.endpointId,
      tts_endpoint: run?.plan.tts?.endpointId ?? preparedRun?.plan.tts?.endpointId,
      audio_resources: [...(audioLease?.resources ?? [])],
      audio_resource_owners: audioResourceState.map((owner) => ({ ...owner })),
      updated_at: new Date().toISOString(),
    } as JsonObject;
  }

  function publish(ctx: PluginRuntimeContext): void {
    ctx.transientState.replace(liveState());
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

  async function startListening(
    ctx: PluginRuntimeContext,
    requestedMode?: ListenMode,
  ): Promise<Record<string, unknown>> {
    if (!enabled || !running || !backend) {
      return { status: "disabled", phase };
    }
    if (
      startInProgress ||
      turnInFlight ||
      phase === "connecting" ||
      phase === "preparing" ||
      phase === "listening" ||
      phase === "restarting" ||
      phase === "speaking" ||
      phase === "needs_approval" ||
      phase === "acquiring" ||
      phase === "queued"
    ) {
      return { status: "already_active", phase, mode: listenMode };
    }

    // Synchronous guard: a second start_listening invoke racing this one must
    // see it before the first await.
    startInProgress = true;
    const generation = ++startGeneration;
    try {
      const mode = requestedMode ?? config.realtime.defaultStartMode;
      stopRequested = false;
      restartAttempt = 0;
      partialTranscript = "";
      lastError = "";
      if (!voiceProfiles) {
        throw new Error("No speech profile manager available.");
      }
      phase = "preparing";
      publish(ctx);
      const controller = new AbortController();
      preparationAbort = controller;
      preparationTimeout = setTimeout(() => {
        controller.abort(new Error(`Voice preparation timed out after ${prepareTimeoutMs} ms.`));
      }, prepareTimeoutMs);
      preparationTimeout.unref?.();
      const preparation = prepareVoiceRun(voiceProfiles, mode, { signal: controller.signal });
      pendingPreparation = preparation;
      let prepared: PreparedVoiceRun;
      try {
        prepared = await preparation;
      } finally {
        if (pendingPreparation === preparation) {
          pendingPreparation = null;
        }
        if (preparationAbort === controller) {
          preparationAbort = null;
        }
        if (preparationTimeout) {
          clearTimeout(preparationTimeout);
          preparationTimeout = null;
        }
      }
      if (!running || generation !== startGeneration || stopRequested) {
        return { status: "cancelled", phase };
      }
      preparedRun = prepared;
      selectedSttProfile = prepared.plan.stt.profileId;
      selectedTtsProfile = prepared.plan.tts?.profileId;
      if (prepared.privacy.kind === "approval_required") {
        phase = "needs_approval";
        publish(ctx);
        const approval = ctx.approvals.request({
          path: "/conversation",
          action: "start_listening",
          reason: prepared.privacy.reason,
          paramsPreview: prepared.privacy.paramsPreview,
          dangerous: true,
          autoApprovable: false,
          execute: () => beginPreparedRun(ctx, prepared, generation),
          reject: (reason) => {
            if (preparedRun !== prepared) {
              return;
            }
            pendingApprovalId = null;
            preparedRun = null;
            listenMode = null;
            phase = "idle";
            lastError = reason ?? "Voice start was not approved.";
            publish(ctx);
          },
        });
        pendingApprovalId = approval.approvalId;
        publish(ctx);
        return approval;
      }
      return await beginPreparedRun(ctx, prepared, generation);
    } catch (error) {
      if (generation === startGeneration) {
        lastError = error instanceof Error ? error.message : String(error);
        phase = "error";
        preparedRun = null;
        logError(ctx, "run_prepare", error);
        publish(ctx);
      }
      return {
        status: generation === startGeneration ? "error" : "cancelled",
        phase,
        ...(generation === startGeneration && { error: lastError }),
      };
    } finally {
      startInProgress = false;
      publish(ctx);
    }
  }

  async function beginPreparedRun(
    ctx: PluginRuntimeContext,
    prepared: PreparedVoiceRun,
    generation: number,
  ): Promise<Record<string, unknown>> {
    if (!running || generation !== startGeneration || preparedRun !== prepared || !backend) {
      return { status: "cancelled", phase };
    }
    pendingApprovalId = null;
    phase = "acquiring";
    publish(ctx);
    const resources = [
      ...(backend.inputResourceKeys ?? []),
      ...(prepared.plan.tts ? backend.outputResourceKeys : []),
    ];
    try {
      const acquisition = arbiter.acquire(
        {
          sessionId: ctx.snapshot().session.sessionId,
          runId: prepared.plan.id,
        },
        resources,
      );
      pendingAudioLease = acquisition;
      let acquiredLease: AudioResourceLease;
      try {
        acquiredLease = await acquisition;
        audioLease = acquiredLease;
      } finally {
        if (pendingAudioLease === acquisition) {
          pendingAudioLease = null;
        }
      }
      if (!running || generation !== startGeneration || preparedRun !== prepared || !backend) {
        await releaseAudioLease();
        return { status: "cancelled", phase };
      }
      run = prepared.begin();
      preparedRun = null;
      listenMode = run.plan.mode;
      publish(ctx);
      void listenLoop(ctx, run.plan.mode);
      return { status: "started", phase, mode: listenMode, run_id: run.plan.id };
    } catch (error) {
      await releaseAudioLease().catch((releaseError) =>
        logError(ctx, "run_start_release", releaseError),
      );
      if (!running || generation !== startGeneration) {
        return { status: "cancelled", phase };
      }
      lastError = error instanceof Error ? error.message : String(error);
      phase = "error";
      preparedRun = null;
      listenMode = null;
      logError(ctx, "run_start", error);
      publish(ctx);
      return { status: "error", phase, error: lastError };
    }
  }

  async function stopListening(
    ctx: PluginRuntimeContext,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    startGeneration += 1;
    preparationAbort?.abort(new Error(reason ?? "Voice preparation cancelled."));
    stopRequested = turnInFlight;
    cancelRestart();
    if (pendingApprovalId) {
      ctx.approvals.cancel(pendingApprovalId, reason ?? "Voice stopped.");
      pendingApprovalId = null;
    }
    listenMode = null;
    closeActiveAudio();
    speakAbort?.abort();
    ttsStream?.abort();
    await embodiment.interrupt();
    run = null;
    preparedRun = null;
    await releasePendingAudioLease().catch((error) =>
      logError(ctx, "stop_pending_audio_release", error),
    );
    try {
      await cleanupAudioLease(ctx);
    } catch (error) {
      return {
        status: "error",
        phase,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (reason) {
      lastError = reason;
    }
    publish(ctx);
    return { status: "stopped", phase };
  }

  async function releaseAudioLease(): Promise<void> {
    const lease = audioLease;
    if (!lease) {
      return;
    }
    await lease.release();
    if (audioLease === lease) {
      audioLease = null;
    }
  }

  async function releasePendingAudioLease(): Promise<void> {
    const acquisition = pendingAudioLease;
    if (!acquisition) {
      return;
    }
    try {
      let lease: AudioResourceLease;
      try {
        lease = await acquisition;
      } catch {
        return;
      }
      try {
        await lease.release();
      } catch (error) {
        audioLease ??= lease;
        throw error;
      }
    } finally {
      if (pendingAudioLease === acquisition) {
        pendingAudioLease = null;
      }
    }
  }

  function cleanupAudioLease(ctx: PluginRuntimeContext): Promise<void> {
    if (cleanupTask) {
      return cleanupTask;
    }
    if (!audioLease) {
      phase = "idle";
      publish(ctx);
      return Promise.resolve();
    }
    phase = "cleaning";
    publish(ctx);
    const task = releaseAudioLease()
      .then(() => {
        phase = "idle";
      })
      .catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        phase = "error";
        logError(ctx, "audio_release", error);
        throw error;
      })
      .finally(() => {
        if (cleanupTask === task) {
          cleanupTask = null;
        }
        publish(ctx);
      });
    cleanupTask = task;
    return task;
  }

  async function releaseAudioLeaseForShutdown(ctx: PluginRuntimeContext): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && audioLease; attempt += 1) {
      try {
        await releaseAudioLease();
        return;
      } catch (error) {
        lastError = error;
        logError(ctx, "shutdown_audio_release", error);
        await delay(10);
      }
    }
    if (audioLease && lastError) {
      throw lastError;
    }
  }

  async function refreshAudioResourceState(ctx: PluginRuntimeContext): Promise<void> {
    audioResourceState = await arbiter.state();
    publish(ctx);
  }

  /** One listening run: connect a realtime STT session and pump mic frames. */
  async function listenLoop(ctx: PluginRuntimeContext, mode: ListenMode): Promise<void> {
    if (!running || !backend || listenMode !== mode || turnInFlight) {
      return;
    }
    if (!run) {
      logError(ctx, "listen_start", new Error("No authorized voice run is active."));
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
      const adapter = await run.createSttAdapter();
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
        run = null;
        void cleanupAudioLease(ctx).catch(() => undefined);
      }
      publish(ctx);
      return;
    }
    restartScheduled = true;
    const restartController = new AbortController();
    restartAbort = restartController;
    restartAttempt += 1;
    phase = "restarting";
    publish(ctx);
    const delayMs = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** (restartAttempt - 1),
      RESTART_MAX_DELAY_MS,
    );
    void (async () => {
      try {
        await delayFn(delayMs, restartController.signal);
      } finally {
        if (restartAbort === restartController) {
          restartAbort = null;
          restartScheduled = false;
        }
      }
      if (
        !restartController.signal.aborted &&
        running &&
        listenMode === mode &&
        phase === "restarting"
      ) {
        void listenLoop(ctx, mode);
      }
    })();
  }

  function cancelRestart(): void {
    restartAbort?.abort();
    restartAbort = null;
    restartScheduled = false;
  }

  function startPluginTurn(ctx: PluginRuntimeContext, mode: ListenMode, transcript: string): void {
    turnInFlight = true;
    const pluginRunId = `voice-turn-${++runSeq}`;
    const result = ctx.turns.submit({
      pluginId: PLUGIN_ID,
      runId: pluginRunId,
      text: transcript,
      author: "voice",
      role: "user",
      metadata: {
        voiceRunId: run?.plan.id,
        listenMode: mode,
      },
    });
    if (result.status === "queued" && run) {
      queuedVoiceRuns.set(pluginRunId, run.plan.id);
    }
    phase = result.status === "queued" ? "queued" : "thinking";
    publish(ctx);
  }

  async function speak(ctx: PluginRuntimeContext, text: string): Promise<void> {
    if (!backend || !run) {
      return;
    }
    const emotesActive = config.embodiment.enabled && config.embodiment.emotes;
    let segments: EmoteSegment[];
    if (hasEmoteMarkers(text)) {
      const emoteNames = emotesActive ? await embodiment.emoteNames() : null;
      segments = parseEmoteMarkers(text, emoteNames === null ? null : [...emoteNames]);
      if (!emotesActive) {
        // Markers are stripped regardless (they must never be spoken), but
        // with emotes off nothing fires and the reply stays one segment.
        const joined = segments
          .map((segment) => segment.text)
          .filter(Boolean)
          .join(" ");
        segments = [{ text: joined }];
      }
    } else {
      segments = [{ text: text.trim() }];
    }
    if (!segments.some((segment) => segment.emotion || segment.text)) {
      return;
    }
    const controller = new AbortController();
    speakAbort = controller;
    let speakingEmbodiment: SpeakingEmbodiment | null = null;
    try {
      const adapter = await run.createTtsAdapter();
      if (!adapter) {
        return;
      }
      speakingEmbodiment = await embodiment.beginSpeaking(controller.signal);
      for (const segment of segments) {
        if (controller.signal.aborted) {
          break;
        }
        if (segment.emotion && emotesActive) {
          void speakingEmbodiment.emote(segment.emotion);
        }
        if (!segment.text) {
          continue;
        }
        const stream = adapter.openStream({ signal: controller.signal });
        ttsStream = stream;
        try {
          stream.appendText(segment.text);
          stream.end();
          await backend.playStream(stream.format, stream.chunks(), controller.signal);
        } finally {
          stream.abort();
          if (ttsStream === stream) {
            ttsStream = null;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logError(ctx, "speak", error);
      }
    } finally {
      await speakingEmbodiment?.finish();
      if (speakAbort === controller) {
        speakAbort = null;
      }
    }
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
    version: "3.0.0",
    description:
      "Streaming voice conversation loop (mic PCM → realtime STT → turn → streamed TTS → playback).",
    defaultEnabled: false,
    providerIds: config.embodiment.enabled ? ["voice", config.embodiment.providerId] : ["voice"],
    sessionNodes: (ctx) => [
      {
        path: "/conversation",
        build: () =>
          buildConversationNode({
            enabled,
            config,
            snapshotState: ctx.transientState.read(),
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
      embodiment = config.embodiment.enabled
        ? new ReachyEmbodimentAdapter({
            providerId: config.embodiment.providerId,
            invoke: ctx.invokeProvider,
            query: ctx.queryProvider,
            onError: (where, error) => logError(ctx, `embodiment_${where}`, error),
          })
        : new NullEmbodimentAdapter();
      running = true;
      unsubscribeProfileSelection =
        voiceProfiles?.onSelectionChange(() => {
          if (run || preparedRun || pendingPreparation || pendingApprovalId) {
            void stopListening(ctx, "Speech profile changed; start a new voice run.").catch(
              (error) => {
                lastError = error instanceof Error ? error.message : String(error);
                phase = "error";
                logError(ctx, "profile_change_stop", error);
                publish(ctx);
              },
            );
          }
        }) ?? null;
      unsubscribeAudioResources = arbiter.subscribe(() => {
        void refreshAudioResourceState(ctx).catch((error) =>
          logError(ctx, "audio_resource_state", error),
        );
      });
      unsubscribeAudioResourceErrors =
        arbiter.subscribeErrors?.((error) => logError(ctx, "audio_resource_poll", error)) ?? null;
      await refreshAudioResourceState(ctx);
      publish(ctx);
      if (config.realtime.autoStartMode === "continuous") {
        await startListening(ctx, "continuous");
      }
    },
    acceptQueuedTurn: (message: QueuedSessionMessage, ctx) => {
      if (message.pluginId !== PLUGIN_ID || !message.pluginRunId) {
        return null;
      }
      const voiceRunId = queuedVoiceRuns.get(message.pluginRunId);
      queuedVoiceRuns.delete(message.pluginRunId);
      turnInFlight = true;
      phase = "thinking";
      publish(ctx);
      return {
        pluginId: PLUGIN_ID,
        runId: message.pluginRunId,
        text: message.text,
        author: message.author,
        role: "user",
        metadata: voiceRunId ? { voiceRunId } : { restoredVoiceTurn: true },
      };
    },
    onQueuedTurnCancelled: (message, ctx) => {
      if (!message.pluginRunId || !queuedVoiceRuns.delete(message.pluginRunId)) {
        return;
      }
      turnInFlight = false;
      phase = "idle";
      publish(ctx);
      if (running && listenMode === "continuous" && run) {
        void listenLoop(ctx, "continuous");
      } else if (listenMode !== "continuous") {
        run = null;
        listenMode = null;
        void cleanupAudioLease(ctx).catch(() => undefined);
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
      const voiceRunId = event.pluginTurn.metadata?.voiceRunId;
      const shouldSpeak =
        !!run &&
        event.pluginTurn.metadata?.restoredVoiceTurn !== true &&
        (voiceRunId === undefined || voiceRunId === run.plan.id);
      const reply = event.result.status === "completed" ? event.result.response : "";
      phase = shouldSpeak ? "speaking" : "idle";
      publish(ctx);
      void (async () => {
        if (shouldSpeak) {
          await speak(ctx, reply);
        }
        phase = "idle";
        publish(ctx);
        if (running && listenMode === "continuous" && run) {
          void listenLoop(ctx, "continuous");
        } else if (listenMode !== "continuous") {
          listenMode = null;
          run = null;
          await cleanupAudioLease(ctx).catch(() => undefined);
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
      if (running && listenMode === "continuous" && run) {
        void listenLoop(ctx, "continuous");
      } else if (listenMode !== "continuous") {
        listenMode = null;
        run = null;
        void cleanupAudioLease(ctx).catch(() => undefined);
      }
    },
    autoCloseBlockers: () =>
      startInProgress ||
      pendingPreparation ||
      pendingApprovalId ||
      run ||
      preparedRun ||
      audioLease ||
      pendingAudioLease ||
      cleanupTask ||
      turnInFlight ||
      restartScheduled
        ? [{ id: "voice-run", label: "Voice conversation active" }]
        : [],
    clientState: (ctx) => ctx.transientState.read(),
    clientCommands: (ctx) => [
      {
        id: "listen-once",
        available: () => enabled && running && (phase === "idle" || phase === "error"),
        execute: () => startListening(ctx, "single_turn"),
      },
      {
        id: "listen-continuous",
        available: () => enabled && running && (phase === "idle" || phase === "error"),
        execute: () => startListening(ctx, "continuous"),
      },
      {
        id: "stop",
        available: () => enabled && running && phase !== "idle",
        execute: () => stopListening(ctx),
      },
    ],
    client: {
      actions: [
        {
          id: "voice:listen-once",
          label: "Listen once",
          description: "Listen for one utterance and send it to the Session.",
          command: "listen-once",
        },
        {
          id: "voice:listen-continuous",
          label: "Start continuous voice",
          description: "Continue listening after each spoken reply.",
          command: "listen-continuous",
        },
        {
          id: "voice:stop",
          label: "Stop voice",
          description: "Stop capture, transcription, and playback.",
          command: "stop",
        },
      ],
      indicators: [
        {
          id: "voice-phase",
          source: "pluginState.voice",
          template: "voice:{phase}",
          fields: { phase: { format: "text" } },
          visibleWhen: { field: "enabled", equals: true },
        },
      ],
      notifications: [
        {
          id: "voice-approval",
          source: "pluginState.voice",
          field: "phase",
          to: "needs_approval",
          message: "Voice needs approval before audio leaves this machine.",
        },
        {
          id: "voice-error",
          source: "pluginState.voice",
          field: "phase",
          to: "error",
          message: "Voice stopped: {error}",
        },
      ],
    },
    onShutdown: async (ctx) => {
      const cleanupErrors: unknown[] = [];
      const cleanup = async (where: string, operation: () => void | Promise<void>) => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(error);
          logError(ctx, where, error);
        }
      };
      running = false;
      startGeneration += 1;
      preparationAbort?.abort(new Error("Session shut down."));
      cancelRestart();
      if (pendingApprovalId) {
        ctx.approvals.cancel(pendingApprovalId, "Session shut down.");
      }
      unsubscribeProfileSelection?.();
      unsubscribeProfileSelection = null;
      unsubscribeAudioResources?.();
      unsubscribeAudioResources = null;
      unsubscribeAudioResourceErrors?.();
      unsubscribeAudioResourceErrors = null;
      clearPartialTimer();
      closeActiveAudio();
      speakAbort?.abort();
      ttsStream?.abort();
      await cleanup("shutdown_embodiment", () => embodiment.dispose());
      await cleanup("shutdown_prepare", async () => {
        await pendingPreparation;
      });
      await cleanup("shutdown_pending_audio_release", releasePendingAudioLease);
      await cleanup("shutdown_audio_cleanup", async () => {
        await cleanupTask;
      });
      await cleanup("shutdown_audio_release", () => releaseAudioLeaseForShutdown(ctx));
      await cleanup("shutdown_backend", () => backend?.dispose());
      backend = null;
      run = null;
      preparedRun = null;
      pendingApprovalId = null;
      queuedVoiceRuns.clear();
      phase = "idle";
      publish(ctx);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Voice shutdown cleanup failed.");
      }
    },
  };
}

function buildConversationNode(input: {
  enabled: boolean;
  config: VoiceConversationPluginConfig;
  snapshotState: JsonObject | undefined;
  startListening: (mode?: ListenMode) => Promise<Record<string, unknown>>;
  stopListening: () => Promise<Record<string, unknown>>;
}): NodeDescriptor {
  const live = input.snapshotState ?? {};
  const emotes = input.config.embodiment.enabled && input.config.embodiment.emotes;
  const phase = typeof live.phase === "string" ? live.phase : "idle";
  const hasAudioLease = Array.isArray(live.audio_resources) && live.audio_resources.length > 0;
  const canStart = (phase === "idle" || phase === "error") && !hasAudioLease;
  return {
    type: "context",
    props: {
      enabled: input.enabled,
      audio_backend: input.config.audio.backend,
      phase,
      listening_mode: live.mode ?? null,
      connected: live.connected ?? false,
      partial_transcript: (live.partial_transcript as string) || undefined,
      last_transcript: (live.last_transcript as string) || undefined,
      restart_attempt: live.restart_attempt ?? 0,
      error: (live.error as string) || undefined,
      stt_profile: live.stt_profile,
      tts_profile: live.tts_profile,
      run_id: live.run_id,
      run_fingerprint: live.run_fingerprint,
      stt_endpoint: live.stt_endpoint,
      tts_endpoint: live.tts_endpoint,
      audio_resources: live.audio_resources ?? [],
      audio_resource_owners: live.audio_resource_owners ?? [],
      embodiment: input.config.embodiment.enabled,
      embodiment_provider: input.config.embodiment.enabled
        ? input.config.embodiment.providerId
        : undefined,
      emotes: emotes || undefined,
    },
    summary:
      "Streaming voice conversation loop: listen → think → speak. Mic PCM streams to the " +
      "active realtime STT profile (provider VAD); final transcripts queue Session turns; replies " +
      "stream back through TTS. Each run freezes its destinations; non-local egress requires approval." +
      (emotes
        ? " When replying to a voice conversation turn, you may embed inline [emote:name] " +
          "markers (multiple allowed) where the mood of your reply shifts; each marker is " +
          "stripped from speech and plays the matching robot emotion silently while you " +
          `keep talking. Valid names are listed in the ${input.config.embodiment.providerId} ` +
          "provider's /behavior props.emotions. Voice turns only — never use markers in " +
          "plain text replies."
        : ""),
    actions: {
      ...(canStart
        ? {
            start_listening: action(
              {
                mode: {
                  type: "string",
                  description: "Listening mode: single_turn or continuous.",
                  optional: true,
                },
              },
              async ({ mode }) =>
                input.startListening(
                  normalizeListenMode(mode, input.config.realtime.defaultStartMode),
                ),
              {
                label: "Start Listening",
                description:
                  "Open the microphone stream and start realtime transcription. Requires explicit approval when a speech endpoint is non-local.",
                estimate: "instant",
              },
            ),
          }
        : {
            stop_listening: action(async () => input.stopListening(), {
              label: "Stop Listening",
              description: "Stop voice capture, transcription, and any in-progress speech.",
              estimate: "instant",
            }),
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

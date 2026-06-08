import type { NodeDescriptor } from "@slop-ai/server";

import type { VoiceConversationPluginConfig } from "../../../config/schema";
import type {
  PluginRuntimeContext,
  PluginTurnCompleteEvent,
  PluginTurnFailureEvent,
  SessionRuntimePlugin,
} from "../../../session/plugins/types";
import { type AudioBackend, type CapturedAudio, createAudioBackend } from "./audio-backend";

const PLUGIN_ID = "voice-conversation";
type Phase = "idle" | "listening" | "thinking" | "speaking";

// Stop the capture loop after this many consecutive capture failures (e.g. the
// recorder binary is missing) instead of spinning hot on the error.
const MAX_CONSECUTIVE_CAPTURE_FAILURES = 3;
// Head-animation cadence and amplitudes (degrees / radians) while speaking.
const ANIMATE_INTERVAL_MS = 100;
const HEAD_PITCH_DEG = 6;
const HEAD_YAW_DEG = 10;
const ANTENNA_RAD = 0.25;

/**
 * Half-duplex voice conversation loop layered on the voice provider. Drives:
 * mic capture (VAD-endpointed) → voice /stt transcribe → agent turn → voice /tts
 * synthesize → playback, animating the robot head during the reply. Audio I/O is
 * a swappable backend (host machine now, robot when hardware arrives); STT/TTS
 * profiles live in the `voice` plugin. The loop is event-driven — armed in
 * onStartup and re-armed in onTurnComplete — because `nextTurn` is synchronous
 * and cannot block for capture.
 */
export function createVoiceConversationPlugin(
  config: VoiceConversationPluginConfig,
): SessionRuntimePlugin {
  let backend: AudioBackend | null = null;
  let running = false;
  let listening = false;
  let turnInFlight = false;
  let phase: Phase = "idle";
  let runSeq = 0;
  let speakAbort: AbortController | null = null;

  const enabled = config.enabled;

  function logError(ctx: PluginRuntimeContext, where: string, error: unknown): void {
    ctx.audit({
      kind: "voice_conversation_error",
      where,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Capture one real utterance (skipping silence/empty captures), transcribe it,
   * and start an agent turn. Returns once a turn is started or the loop stops;
   * re-arming happens in onTurnComplete.
   */
  async function listen(ctx: PluginRuntimeContext): Promise<void> {
    if (!running || listening || turnInFlight || !backend) {
      return;
    }
    listening = true;
    phase = "listening";
    let failures = 0;
    try {
      while (running && !turnInFlight) {
        let audio: CapturedAudio | null;
        try {
          audio = await backend.captureUtterance();
          failures = 0;
        } catch (error) {
          logError(ctx, "capture", error);
          if (++failures >= MAX_CONSECUTIVE_CAPTURE_FAILURES) {
            running = false;
            ctx.audit({
              kind: "voice_conversation_stopped",
              reason: "capture failed repeatedly",
            });
            return;
          }
          continue;
        }
        if (!audio || !running) {
          continue;
        }

        const transcript = await transcribe(ctx, audio);
        if (!transcript) {
          continue; // nothing intelligible — keep listening
        }

        phase = "thinking";
        turnInFlight = true;
        try {
          ctx.startTurn({
            pluginId: PLUGIN_ID,
            runId: `vc-${++runSeq}`,
            text: transcript,
            author: "reachy-voice",
            role: "user",
          });
        } catch (error) {
          // Coordinator busy (e.g. an interleaved user turn); drop this utterance.
          turnInFlight = false;
          phase = "listening";
          logError(ctx, "start_turn", error);
          continue;
        }
        return; // turn running; onTurnComplete re-arms the loop
      }
    } finally {
      listening = false;
    }
  }

  async function transcribe(
    ctx: PluginRuntimeContext,
    audio: CapturedAudio,
  ): Promise<string | null> {
    try {
      const result = await ctx.invokeProvider("voice", "/stt", "transcribe", {
        audio: audio.audioBase64,
        mime_type: audio.mimeType,
      });
      if (result.status !== "ok" || !result.data) {
        return null;
      }
      const text = (result.data as { text?: string }).text?.trim();
      return text ? text : null;
    } catch (error) {
      logError(ctx, "transcribe", error);
      return null;
    }
  }

  async function speak(ctx: PluginRuntimeContext, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !backend) {
      return;
    }
    let audio: CapturedAudio | null = null;
    try {
      const result = await ctx.invokeProvider("voice", "/tts", "synthesize", { text: trimmed });
      if (result.status === "ok" && result.data) {
        const data = result.data as { audio_base64?: string; mime_type?: string };
        if (data.audio_base64) {
          audio = { audioBase64: data.audio_base64, mimeType: data.mime_type ?? "audio/mpeg" };
        }
      }
    } catch (error) {
      logError(ctx, "synthesize", error);
    }
    if (!audio) {
      return;
    }

    // Play the reply and animate the head for its duration; stop animation the
    // moment playback resolves.
    const animateController = new AbortController();
    speakAbort = animateController;
    const animation = animateHead(ctx, animateController.signal);
    try {
      await backend.play(audio);
    } catch (error) {
      logError(ctx, "playback", error);
    } finally {
      animateController.abort();
      await animation;
      speakAbort = null;
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

  return {
    id: PLUGIN_ID,
    version: "1.0.0",
    description: "Voice conversation loop (capture → STT → turn → TTS → playback).",
    defaultEnabled: false,
    providerIds: config.embodiment.enabled ? ["voice", config.embodiment.providerId] : ["voice"],
    sessionNodes: () => [
      {
        path: "/conversation",
        build: () => buildConversationNode({ enabled, phase, config }),
      },
    ],
    onStartup: (ctx) => {
      if (!enabled) {
        return;
      }
      backend = createAudioBackend(config.audio, ctx.invokeProvider);
      running = true;
      void listen(ctx);
    },
    onTurnComplete: (event: PluginTurnCompleteEvent, ctx) => {
      if (event.pluginTurn.pluginId !== PLUGIN_ID) {
        return;
      }
      turnInFlight = false;
      if (!running) {
        return;
      }
      const reply = event.result.status === "completed" ? event.result.response : "";
      phase = "speaking";
      void (async () => {
        await speak(ctx, reply);
        phase = "idle";
        if (running) {
          void listen(ctx);
        }
      })();
    },
    onTurnFailure: (event: PluginTurnFailureEvent, ctx) => {
      if (event.pluginTurn.pluginId !== PLUGIN_ID) {
        return;
      }
      turnInFlight = false;
      phase = "idle";
      if (running) {
        void listen(ctx);
      }
    },
    onShutdown: () => {
      running = false;
      speakAbort?.abort();
      backend?.dispose();
      backend = null;
      phase = "idle";
    },
  };
}

function buildConversationNode(input: {
  enabled: boolean;
  phase: Phase;
  config: VoiceConversationPluginConfig;
}): NodeDescriptor {
  return {
    type: "context",
    props: {
      enabled: input.enabled,
      phase: input.phase,
      audio_backend: input.config.audio.backend,
      embodiment: input.config.embodiment.enabled,
      embodiment_provider: input.config.embodiment.enabled
        ? input.config.embodiment.providerId
        : undefined,
    },
    summary:
      "Voice conversation loop state: listen → think → speak. Audio capture/playback and head " +
      "animation are driven by the runtime against the voice and robot providers.",
  };
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

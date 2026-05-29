import type { NodeDescriptor } from "@slop-ai/server";
import type { PluginRuntimeContext, SessionRuntimePlugin } from "../../../session/plugins/types";
import { createExtensionRecord } from "../../../session/store/extensions";
import { now } from "../../../session/store/helpers";
import type { VoiceProfileManager } from "../../../voice/profile-manager";
import { maybeSynthesizeAutospeak } from "./autospeak";

export const VOICE_EXTENSION_NAMESPACE = "voice";
const AUTOSPEAK_INSTANCE_ID = "autospeak";
const AUTOSPEAK_SCHEMA_VERSION = 1;
// Auto-spoken audio is transient — keep only the latest turn's clip briefly.
const AUTOSPEAK_RETENTION_MS = 5 * 60 * 1000;

type AutospeakState = {
  turnId: string;
  mimeType: string;
  audio_base64: string;
  created_at: string;
};

/**
 * Session-side half of the voice plugin. Mounts a `/voice` node onto the session
 * provider (the public surface clients consume) and, when the active TTS profile
 * has autospeak enabled, synthesizes each completed assistant turn and publishes
 * the audio as a session extension for a future client to play. Mic capture and
 * playback live at the surface and are out of scope here.
 */
export function createVoicePlugin(profiles: VoiceProfileManager): SessionRuntimePlugin {
  return {
    id: "voice",
    version: "1.0.0",
    description: "Speech-to-text and text-to-speech voice surface.",
    defaultEnabled: false,
    providerIds: ["voice"],
    extensionNamespaces: [VOICE_EXTENSION_NAMESPACE],
    sessionNodes: () => [
      {
        path: "/voice",
        build: (ctx) => buildVoiceNode(ctx),
      },
    ],
    onTurnComplete: (event, ctx) => {
      if (event.result.status !== "completed") {
        return;
      }
      const text = event.result.response;
      if (!text?.trim()) {
        return;
      }
      // Fire-and-forget: synthesis must not block the turn. The later
      // upsertExtension triggers a store change → session provider refresh,
      // which republishes /voice so a subscribed client can play it.
      void maybeSynthesizeAutospeak(profiles, text)
        .then((audio) => {
          if (!audio) {
            return;
          }
          const state: AutospeakState = {
            turnId: event.turnId,
            mimeType: audio.mimeType,
            audio_base64: audio.audioBase64,
            created_at: now(),
          };
          ctx.store.upsertExtension(
            createExtensionRecord({
              namespace: VOICE_EXTENSION_NAMESPACE,
              instanceId: AUTOSPEAK_INSTANCE_ID,
              schemaVersion: AUTOSPEAK_SCHEMA_VERSION,
              owner: { kind: "runtime", id: "voice", version: "1.0.0" },
              state: { autospeak: state },
              cleanupPolicy: {
                mode: "ttl",
                ttlMs: AUTOSPEAK_RETENTION_MS,
                description: "Latest auto-spoken assistant audio; transient playback artifact.",
              },
            }),
          );
        })
        .catch(() => {
          // Autospeak is best-effort; ignore synthesis failures.
        });
    },
    ui: {
      subscriptions: [{ path: "/voice", depth: 1 }],
      indicators: [
        {
          id: "voice-autospeak",
          path: "/voice",
          depth: 1,
          template: "voice: audio ready",
          visibleWhen: { prop: "autospeak_pending", equals: true },
        },
      ],
    },
  };
}

function buildVoiceNode(ctx: PluginRuntimeContext): NodeDescriptor {
  const record = ctx.snapshot().extensions[VOICE_EXTENSION_NAMESPACE];
  const autospeak = (record?.state.autospeak as AutospeakState | undefined) ?? undefined;
  return {
    type: "context",
    props: {
      autospeak_pending: Boolean(autospeak),
      last_turn_id: autospeak?.turnId,
      mime_type: autospeak?.mimeType,
      audio_base64: autospeak?.audio_base64,
      created_at: autospeak?.created_at,
    },
    summary:
      "Voice surface state: the latest auto-spoken assistant audio for a client to play. Capture and playback are surface concerns.",
  };
}

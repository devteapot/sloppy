import type { EndpointAuthConfig } from "../../../config/schema";
import type { InvokeContext, InvokePolicy, PolicyDecision } from "../../../core/policy";
import { mergeSttEndpoints } from "../../../stt/catalog";
import { mergeTtsEndpoints } from "../../../tts/catalog";

const ALLOW: PolicyDecision = { kind: "allow" };

const LOCAL_HOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** A voice endpoint is "local" when it needs no auth and points at localhost. */
function endpointIsLocal(
  auth: EndpointAuthConfig | undefined,
  baseUrl: string | undefined,
): boolean {
  const noAuth = !auth || auth.type === "none";
  const localUrl = baseUrl ? LOCAL_HOST_RE.test(baseUrl) : false;
  return noAuth && localUrl;
}

/**
 * Requires approval before transcription/synthesis is sent to a non-local
 * endpoint — the privacy boundary where the user's audio (STT) or conversation
 * text (TTS) leaves the machine. Local self-hosted endpoints run without a
 * prompt. Endpoint locality is pure config, so the rule resolves the modality's
 * default (or first) profile's endpoint without needing credentials.
 */
export const voiceNetworkRule: InvokePolicy = {
  evaluate(ctx: InvokeContext): PolicyDecision {
    if (ctx.providerId !== "voice") {
      return ALLOW;
    }
    if (ctx.action !== "transcribe" && ctx.action !== "synthesize") {
      return ALLOW;
    }
    if (ctx.preApproved) {
      return ALLOW;
    }

    const voice = ctx.config.plugins.voice;
    const isStt = ctx.action === "transcribe";
    const endpoints = isStt
      ? mergeSttEndpoints(voice.stt.endpoints)
      : mergeTtsEndpoints(voice.tts.endpoints);
    const profiles = isStt ? voice.stt.profiles : voice.tts.profiles;
    const defaultProfileId = isStt ? voice.stt.defaultProfileId : voice.tts.defaultProfileId;
    const active = profiles.find((profile) => profile.id === defaultProfileId) ?? profiles[0];
    const endpoint = active ? endpoints[active.endpointId] : undefined;

    if (endpoint && endpointIsLocal(endpoint.auth, endpoint.baseUrl)) {
      return ALLOW;
    }

    const target = endpoint?.label ?? active?.endpointId ?? "a remote service";
    return {
      kind: "require_approval",
      reason: isStt
        ? `Transcription sends your audio to ${target}.`
        : `Speech synthesis sends conversation text to ${target}.`,
      dangerous: true,
      paramsPreview: previewParams(ctx.action, ctx.params),
    };
  },
};

function previewParams(action: string, params: Record<string, unknown>): string {
  if (action === "transcribe") {
    const audio = typeof params.audio === "string" ? params.audio : "";
    return JSON.stringify({
      mime_type: params.mime_type,
      language: params.language,
      audio_bytes: Math.floor((audio.length * 3) / 4),
    });
  }
  const text = typeof params.text === "string" ? params.text : "";
  return JSON.stringify({
    text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    voice: params.voice,
  });
}

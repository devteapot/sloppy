import type { EndpointAuthConfig } from "../../../config/schema";
import type { InvokeContext, InvokePolicy, PolicyDecision } from "../../../core/policy";
import type { SpeechProfileManager } from "../../../speech/profile-manager";

const ALLOW: PolicyDecision = { kind: "allow" };

// http(s) for TTS endpoints, ws(s) for realtime STT endpoints.
const LOCAL_HOST_RE = /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

// Session providers are created as `sloppy-session-<sessionId>`; the rule only
// targets their /conversation node so another provider's same-named node can't
// trip it.
const SESSION_PROVIDER_PREFIX = "sloppy-session";

/** A speech endpoint is "local" when it needs no auth and points at localhost. */
export function endpointIsLocal(
  auth: EndpointAuthConfig | undefined,
  baseUrl: string | undefined,
): boolean {
  const noAuth = !auth || auth.type === "none";
  const localUrl = baseUrl ? LOCAL_HOST_RE.test(baseUrl) : false;
  return noAuth && localUrl;
}

/**
 * Requires approval before the conversation loop starts listening when either
 * active speech endpoint is non-local — the privacy boundary where live
 * microphone audio (STT) and conversation text (TTS) leave the machine. The
 * loop is gated at start_listening (the moment audio begins flowing) because
 * the streaming sessions themselves are opened in-process, not via affordance
 * invokes. Endpoint locality comes from the same selection logic the manager
 * uses to build adapters, so the approval decision can't diverge from the
 * endpoint that actually receives audio. After the user approves, the hub
 * re-invokes start_listening with `preApproved: true`.
 */
export function createSpeechNetworkRule(manager: SpeechProfileManager): InvokePolicy {
  return {
    async evaluate(ctx: InvokeContext): Promise<PolicyDecision> {
      if (ctx.action !== "start_listening" || ctx.path !== "/conversation") {
        return ALLOW;
      }
      if (!ctx.providerId.startsWith(SESSION_PROVIDER_PREFIX)) {
        return ALLOW;
      }
      if (ctx.preApproved) {
        return ALLOW;
      }

      const [stt, tts] = await Promise.all([
        manager.activeSttEndpoint(),
        manager.activeTtsEndpoint(),
      ]);
      const remote: string[] = [];
      if (stt && !endpointIsLocal(stt.config.auth, stt.config.baseUrl)) {
        remote.push(`your microphone audio to ${stt.config.label ?? stt.id}`);
      }
      if (tts && !endpointIsLocal(tts.config.auth, tts.config.baseUrl)) {
        remote.push(`conversation text to ${tts.config.label ?? tts.id}`);
      }
      if (remote.length === 0) {
        return ALLOW;
      }

      return {
        kind: "require_approval",
        reason: `Voice conversation streams ${remote.join(" and ")}.`,
        dangerous: true,
        paramsPreview: JSON.stringify({
          mode: typeof ctx.params.mode === "string" ? ctx.params.mode : undefined,
          stt_endpoint: stt?.id,
          tts_endpoint: tts?.id,
        }),
      };
    },
  };
}

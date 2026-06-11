// First-party speech protocol bindings. The runtime's `src/speech/` is
// protocol-agnostic; these bindings are registered into a registry by the
// plugin layer (catalog.ts's speechManagerFor) before any adapter is resolved.

import type { SpeechProtocolRegistry } from "../../../../speech/registry";
import { OpenAISpeechStreamAdapter } from "./openai-speech";
import { RealtimeSttAdapter } from "./realtime-stt/session";

/**
 * Idempotent: guarded per registry (not by a module flag) so tests can
 * register into multiple fresh registries. If another plugin registered a
 * protocol under the same id first, that registration wins silently.
 */
export function registerSpeechProtocols(registry: SpeechProtocolRegistry): void {
  if (!registry.hasSttProtocol("realtime-stt")) {
    registry.registerStt("realtime-stt", (config) => new RealtimeSttAdapter(config));
  }
  if (!registry.hasTtsProtocol("openai-speech")) {
    registry.registerTts("openai-speech", (config) => new OpenAISpeechStreamAdapter(config));
  }
}

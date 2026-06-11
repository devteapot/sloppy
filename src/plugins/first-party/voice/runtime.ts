import type { SloppyConfig } from "../../../config/schema";
import { SpeechProfileManager } from "../../../speech/profile-manager";
import { speechRegistry } from "../../../speech/registry";
import { DEFAULT_STT_ENDPOINTS, DEFAULT_TTS_ENDPOINTS } from "./endpoints";
import { registerSpeechProtocols } from "./protocols";

const speechManagers = new WeakMap<SloppyConfig, SpeechProfileManager>();

export function speechManagerFor(config: SloppyConfig): SpeechProfileManager {
  let manager = speechManagers.get(config);
  if (!manager) {
    registerSpeechProtocols(speechRegistry);
    manager = new SpeechProfileManager(config.plugins.voice, {
      defaults: { stt: DEFAULT_STT_ENDPOINTS, tts: DEFAULT_TTS_ENDPOINTS },
    });
    speechManagers.set(config, manager);
  }
  return manager;
}

import type { SloppyConfig } from "../../../config/schema";
import { SpeechProfileManager } from "../../../speech/profile-manager";

const speechManagers = new WeakMap<SloppyConfig, SpeechProfileManager>();

export function speechManagerFor(config: SloppyConfig): SpeechProfileManager {
  let manager = speechManagers.get(config);
  if (!manager) {
    manager = new SpeechProfileManager(config.plugins.voice);
    speechManagers.set(config, manager);
  }
  return manager;
}

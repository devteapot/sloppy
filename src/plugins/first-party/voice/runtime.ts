import type { SloppyConfig } from "../../../config/schema";
import { VoiceProfileManager } from "../../../voice/profile-manager";

const voiceManagers = new WeakMap<SloppyConfig, VoiceProfileManager>();

export function voiceManagerFor(config: SloppyConfig): VoiceProfileManager {
  let manager = voiceManagers.get(config);
  if (!manager) {
    manager = new VoiceProfileManager(config.plugins.voice);
    voiceManagers.set(config, manager);
  }
  return manager;
}

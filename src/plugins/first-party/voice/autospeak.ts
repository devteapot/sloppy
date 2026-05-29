import { toBase64 } from "../../../voice/audio";
import type { VoiceProfileManager } from "../../../voice/profile-manager";

export type AutospeakAudio = {
  mimeType: string;
  audioBase64: string;
};

/**
 * If the active TTS profile is ready and has autospeak enabled, synthesize the
 * given assistant text and return the audio for publishing. Returns null when
 * autospeak is off, no TTS profile is ready, or the text is empty — so callers
 * can no-op cheaply. Pure (no store writes), which keeps it unit-testable.
 */
export async function maybeSynthesizeAutospeak(
  profiles: VoiceProfileManager,
  text: string,
): Promise<AutospeakAudio | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (!(await profiles.activeTtsAutospeak())) {
    return null;
  }
  const adapter = await profiles.createTtsAdapter();
  const result = await adapter.synthesize({ text: trimmed });
  return { mimeType: result.mimeType, audioBase64: toBase64(result.audio) };
}

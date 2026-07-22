import { action, createSlopServer, type NodeDescriptor, type SlopServer } from "@slop-ai/server";

import type {
  SpeechModalityStateSnapshot,
  SpeechProfileManager,
} from "../../../speech/profile-manager";

/**
 * SLOP provider exposing speech configuration state: per-modality readiness,
 * the active STT/TTS profiles, and `set_profile` to switch them. Speech
 * itself is streaming-only and runs inside the voice Plugin's conversation loop —
 * audio never crosses the SLOP boundary here.
 */
export class VoiceProvider {
  readonly server: SlopServer;
  private readonly profiles: SpeechProfileManager;
  private sttState?: SpeechModalityStateSnapshot;
  private ttsState?: SpeechModalityStateSnapshot;

  constructor(profiles: SpeechProfileManager) {
    this.profiles = profiles;
    this.server = createSlopServer({ id: "voice", name: "Voice" });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("stt", () => this.buildSttDescriptor());
    this.server.register("tts", () => this.buildTtsDescriptor());

    void this.refreshState();
  }

  stop(): void {
    this.server.stop();
  }

  /** Recompute cached modality readiness and notify subscribers. */
  async refreshState(): Promise<void> {
    [this.sttState, this.ttsState] = await Promise.all([
      this.profiles.getSttState(),
      this.profiles.getTtsState(),
    ]);
    this.server.refresh();
  }

  private buildSessionDescriptor(): NodeDescriptor {
    const stt = this.sttState;
    const tts = this.ttsState;
    return {
      type: "context",
      props: {
        stt_status: stt?.status ?? "initializing",
        tts_status: tts?.status ?? "initializing",
        stt_available: stt?.status === "ready",
        tts_available: tts?.status === "ready",
        secure_store: stt?.secureStoreStatus ?? tts?.secureStoreStatus,
      },
      summary:
        "Speech configuration: streaming STT and TTS profiles consumed by the voice conversation loop. STT and TTS are independent — either may be unconfigured.",
    };
  }

  private buildSttDescriptor(): NodeDescriptor {
    const state = this.sttState;
    return {
      type: "context",
      props: {
        status: state?.status ?? "initializing",
        active_profile: state?.activeProfileId,
        endpoint: state?.selectedEndpointId,
        protocol: state?.selectedProtocol,
        dialect: state?.selectedDialect,
        model: state?.selectedModel,
        sample_rate: state?.selectedSampleRate,
        profiles: (state?.profiles ?? []).map((profile) => ({
          id: profile.id,
          ready: profile.ready,
          endpoint: profile.endpointId,
          protocol: profile.protocol,
          dialect: profile.dialect,
          key_source: profile.keySource,
          is_default: profile.isDefault,
        })),
      },
      summary: "Streaming speech-to-text configuration (realtime transcription sessions).",
      actions: {
        set_profile: action(
          { profile_id: "string" },
          async ({ profile_id }) => this.setSttProfile(profile_id as string),
          {
            label: "Set STT Profile",
            description: "Select which configured STT profile the conversation loop uses.",
            estimate: "instant",
          },
        ),
      },
    };
  }

  private buildTtsDescriptor(): NodeDescriptor {
    const state = this.ttsState;
    return {
      type: "context",
      props: {
        status: state?.status ?? "initializing",
        active_profile: state?.activeProfileId,
        endpoint: state?.selectedEndpointId,
        protocol: state?.selectedProtocol,
        model: state?.selectedModel,
        voice: state?.selectedVoice,
        pcm_sample_rate: state?.selectedSampleRate,
        profiles: (state?.profiles ?? []).map((profile) => ({
          id: profile.id,
          ready: profile.ready,
          endpoint: profile.endpointId,
          voice: profile.voice,
          key_source: profile.keySource,
          is_default: profile.isDefault,
        })),
      },
      summary: "Streaming text-to-speech configuration used to voice conversation replies.",
      actions: {
        set_profile: action(
          { profile_id: "string" },
          async ({ profile_id }) => this.setTtsProfile(profile_id as string),
          {
            label: "Set TTS Profile",
            description: "Select which configured TTS profile the conversation loop uses.",
            estimate: "instant",
          },
        ),
      },
    };
  }

  private async setSttProfile(profileId: string): Promise<{ active_profile: string }> {
    this.profiles.setSttProfile(profileId);
    await this.refreshState();
    return { active_profile: profileId };
  }

  private async setTtsProfile(profileId: string): Promise<{ active_profile: string }> {
    this.profiles.setTtsProfile(profileId);
    await this.refreshState();
    return { active_profile: profileId };
  }
}

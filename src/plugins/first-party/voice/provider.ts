import { action, createSlopServer, type NodeDescriptor, type SlopServer } from "@slop-ai/server";

import { ProviderApprovalManager } from "../../../providers/approvals";
import { toAudioBytes, toBase64 } from "../../../voice/audio";
import type {
  VoiceModalityStateSnapshot,
  VoiceProfileManager,
} from "../../../voice/profile-manager";

/**
 * SLOP provider exposing speech-to-text and text-to-speech as affordances. The
 * provider performs the external API calls (transcription/synthesis) using the
 * runtime's endpoint + credential config; audio bytes cross the SLOP boundary as
 * base64 strings. Audio hardware (mic capture, playback) lives at the surface,
 * not here — this provider only turns audio↔text.
 */
export class VoiceProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private readonly profiles: VoiceProfileManager;
  private sttState?: VoiceModalityStateSnapshot;
  private ttsState?: VoiceModalityStateSnapshot;

  constructor(profiles: VoiceProfileManager) {
    this.profiles = profiles;
    this.server = createSlopServer({ id: "voice", name: "Voice" });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("stt", () => this.buildSttDescriptor());
    this.server.register("tts", () => this.buildTtsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());

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

  async transcribe(params: {
    audio: string;
    mimeType?: string;
    language?: string;
  }): Promise<{ text: string; confidence?: number; language?: string }> {
    const adapter = await this.profiles.createSttAdapter();
    const result = await adapter.transcribe({
      audio: toAudioBytes(params.audio),
      mimeType: params.mimeType,
      language: params.language,
    });
    return { text: result.text, confidence: result.confidence, language: result.language };
  }

  async synthesize(params: {
    text: string;
    voice?: string;
    format?: "mp3" | "wav" | "opus" | "pcm";
  }): Promise<{ audio_base64: string; mime_type: string; sample_rate?: number }> {
    const adapter = await this.profiles.createTtsAdapter();
    const result = await adapter.synthesize({
      text: params.text,
      voice: params.voice,
      format: params.format,
    });
    return {
      audio_base64: toBase64(result.audio),
      mime_type: result.mimeType,
      sample_rate: result.sampleRate,
    };
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
        autospeak: tts?.autospeak ?? false,
        secure_store: stt?.secureStoreStatus ?? tts?.secureStoreStatus,
      },
      summary:
        "Voice services: speech-to-text and text-to-speech. STT and TTS are independent — either may be unconfigured.",
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
        model: state?.selectedModel,
        profiles: (state?.profiles ?? []).map((profile) => ({
          id: profile.id,
          ready: profile.ready,
          endpoint: profile.endpointId,
          key_source: profile.keySource,
          is_default: profile.isDefault,
        })),
      },
      summary: "Speech-to-text transcription.",
      actions: {
        transcribe: action(
          {
            audio: { type: "string", description: "Base64-encoded audio bytes to transcribe." },
            mime_type: {
              type: "string",
              description: "Audio MIME type (e.g. audio/wav, audio/webm).",
              optional: true,
            },
            language: {
              type: "string",
              description: "BCP-47 language hint (e.g. 'en').",
              optional: true,
            },
          },
          async ({ audio, mime_type, language }) =>
            this.transcribe({
              audio: audio as string,
              mimeType: mime_type as string | undefined,
              language: language as string | undefined,
            }),
          {
            label: "Transcribe Audio",
            description: "Transcribe base64-encoded audio to text using the active STT profile.",
            estimate: "slow",
          },
        ),
        set_profile: action(
          { profile_id: "string" },
          async ({ profile_id }) => this.setSttProfile(profile_id as string),
          {
            label: "Set STT Profile",
            description: "Select which configured STT profile transcription uses.",
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
        autospeak: state?.autospeak ?? false,
        profiles: (state?.profiles ?? []).map((profile) => ({
          id: profile.id,
          ready: profile.ready,
          endpoint: profile.endpointId,
          voice: profile.voice,
          key_source: profile.keySource,
          is_default: profile.isDefault,
        })),
      },
      summary: "Text-to-speech synthesis. Invoke synthesize to speak text aloud.",
      actions: {
        synthesize: action(
          {
            text: { type: "string", description: "Text to synthesize into speech." },
            voice: { type: "string", description: "Voice id override.", optional: true },
            format: {
              type: "string",
              description: "Output audio format: mp3, wav, opus, or pcm.",
              optional: true,
            },
          },
          async ({ text, voice, format }) =>
            this.synthesize({
              text: text as string,
              voice: voice as string | undefined,
              format: format as "mp3" | "wav" | "opus" | "pcm" | undefined,
            }),
          {
            label: "Synthesize Speech",
            description:
              "Synthesize text to speech using the active TTS profile. Returns base64-encoded audio.",
            estimate: "slow",
          },
        ),
        set_profile: action(
          { profile_id: "string" },
          async ({ profile_id }) => this.setTtsProfile(profile_id as string),
          {
            label: "Set TTS Profile",
            description: "Select which configured TTS profile synthesis uses.",
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

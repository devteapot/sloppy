import type {
  EndpointAuthConfig,
  TtsProtocol,
  VoicePluginConfig,
  VoiceSttEndpointConfig,
  VoiceSttProfileConfig,
  VoiceTtsEndpointConfig,
  VoiceTtsProfileConfig,
} from "../config/schema";
import {
  type CredentialStore,
  type CredentialStoreKind,
  type CredentialStoreStatus,
  createCredentialStore,
} from "../llm/credential-store";
import { mergeSttEndpoints } from "../stt/catalog";
import { createSttAdapter } from "../stt/factory";
import type { SttAdapter } from "../stt/types";
import { mergeTtsEndpoints } from "../tts/catalog";
import { createTtsAdapter } from "../tts/factory";
import type { TtsAdapter } from "../tts/types";

// Voice credentials live in the same secure store as LLM keys but under a
// dedicated `voice:` account prefix so they never collide with LLM endpoint ids.
const CREDENTIAL_PREFIX = "voice:";

export type VoiceKeySource = "env" | "secure_store" | "not_required" | "missing";

export type VoiceProfileState = {
  id: string;
  label?: string;
  endpointId: string;
  protocol: string;
  model: string;
  voice?: string;
  ready: boolean;
  keySource: VoiceKeySource;
  isDefault: boolean;
  invalidReason?: string;
};

export type VoiceModalityStateSnapshot = {
  status: "ready" | "needs_credentials" | "not_configured";
  activeProfileId?: string;
  selectedEndpointId?: string;
  selectedProtocol?: string;
  selectedModel?: string;
  selectedVoice?: string;
  autospeak: boolean;
  secureStoreKind: CredentialStoreKind;
  secureStoreStatus: CredentialStoreStatus;
  profiles: VoiceProfileState[];
};

type ResolvedCredential = {
  ready: boolean;
  keySource: VoiceKeySource;
  apiKey?: string;
  invalidReason?: string;
};

/**
 * Resolves voice STT/TTS profiles to ready-to-use adapters, mirroring
 * `LlmProfileManager`: profile → endpoint → credential → adapter. Reuses the
 * shared `CredentialStore`; reports per-modality readiness so a partial pipeline
 * (STT-only or TTS-only) is a first-class state, not an error.
 */
export class VoiceProfileManager {
  private config: VoicePluginConfig;
  private readonly credentialStore: CredentialStore;
  private sttSelected?: string;
  private ttsSelected?: string;

  constructor(config: VoicePluginConfig, options?: { credentialStore?: CredentialStore }) {
    this.config = config;
    this.credentialStore = options?.credentialStore ?? createCredentialStore();
  }

  updateConfig(config: VoicePluginConfig): void {
    this.config = config;
  }

  setSttProfile(profileId: string): void {
    this.sttSelected = profileId;
  }

  setTtsProfile(profileId: string): void {
    this.ttsSelected = profileId;
  }

  sttEndpoints(): Record<string, VoiceSttEndpointConfig> {
    return mergeSttEndpoints(this.config.stt.endpoints);
  }

  ttsEndpoints(): Record<string, VoiceTtsEndpointConfig> {
    return mergeTtsEndpoints(this.config.tts.endpoints);
  }

  async getSttState(): Promise<VoiceModalityStateSnapshot> {
    const endpoints = this.sttEndpoints();
    const profiles = this.config.stt.profiles;
    const secureStoreStatus = await this.credentialStore.getStatus();
    const states = await Promise.all(
      profiles.map((profile) => this.resolveSttProfile(profile, endpoints)),
    );
    const activeId = this.selectActive("stt", states);
    const profileStates = states.map((state) => ({ ...state, isDefault: state.id === activeId }));
    const active = profileStates.find((state) => state.id === activeId);
    return {
      status:
        profiles.length === 0 ? "not_configured" : active?.ready ? "ready" : "needs_credentials",
      activeProfileId: active?.id,
      selectedEndpointId: active?.endpointId,
      selectedProtocol: active?.protocol,
      selectedModel: active?.model,
      autospeak: false,
      secureStoreKind: this.credentialStore.kind,
      secureStoreStatus,
      profiles: profileStates,
    };
  }

  async getTtsState(): Promise<VoiceModalityStateSnapshot> {
    const endpoints = this.ttsEndpoints();
    const profiles = this.config.tts.profiles;
    const secureStoreStatus = await this.credentialStore.getStatus();
    const states = await Promise.all(
      profiles.map((profile) => this.resolveTtsProfile(profile, endpoints)),
    );
    const activeId = this.selectActive("tts", states);
    const profileStates = states.map((state) => ({ ...state, isDefault: state.id === activeId }));
    const active = profileStates.find((state) => state.id === activeId);
    const activeProfile = profiles.find((profile) => profile.id === activeId);
    return {
      status:
        profiles.length === 0 ? "not_configured" : active?.ready ? "ready" : "needs_credentials",
      activeProfileId: active?.id,
      selectedEndpointId: active?.endpointId,
      selectedProtocol: active?.protocol,
      selectedModel: active?.model,
      selectedVoice: active?.voice,
      autospeak: Boolean(activeProfile?.autospeak),
      secureStoreKind: this.credentialStore.kind,
      secureStoreStatus,
      profiles: profileStates,
    };
  }

  /** True when the active TTS profile is ready and has autospeak enabled. */
  async activeTtsAutospeak(): Promise<boolean> {
    const state = await this.getTtsState();
    return state.status === "ready" && state.autospeak;
  }

  async createSttAdapter(profileId?: string): Promise<SttAdapter> {
    const state = await this.getSttState();
    const targetId = profileId ?? state.activeProfileId;
    if (!targetId) {
      throw new Error("No STT profile is configured. Add one under plugins.voice.stt.profiles.");
    }
    const profile = this.config.stt.profiles.find((candidate) => candidate.id === targetId);
    if (!profile) {
      throw new Error(`STT profile '${targetId}' is not configured.`);
    }
    const profileState = state.profiles.find((candidate) => candidate.id === targetId);
    if (!profileState?.ready) {
      throw new Error(
        profileState?.invalidReason ?? "STT profile is not ready (missing credentials).",
      );
    }
    const endpoint = this.sttEndpoints()[profile.endpointId];
    if (!endpoint) {
      throw new Error(
        `STT profile '${targetId}' references unknown endpoint '${profile.endpointId}'.`,
      );
    }
    const credential = await this.resolveCredential(profile.endpointId, profile.id, endpoint.auth);
    return createSttAdapter({
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model: profile.model,
      apiKey: credential.apiKey,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers,
      language: profile.language,
    });
  }

  async createTtsAdapter(profileId?: string): Promise<TtsAdapter> {
    const state = await this.getTtsState();
    const targetId = profileId ?? state.activeProfileId;
    if (!targetId) {
      throw new Error("No TTS profile is configured. Add one under plugins.voice.tts.profiles.");
    }
    const profile = this.config.tts.profiles.find((candidate) => candidate.id === targetId);
    if (!profile) {
      throw new Error(`TTS profile '${targetId}' is not configured.`);
    }
    const profileState = state.profiles.find((candidate) => candidate.id === targetId);
    if (!profileState?.ready) {
      throw new Error(
        profileState?.invalidReason ?? "TTS profile is not ready (missing credentials).",
      );
    }
    const endpoint = this.ttsEndpoints()[profile.endpointId];
    if (!endpoint) {
      throw new Error(
        `TTS profile '${targetId}' references unknown endpoint '${profile.endpointId}'.`,
      );
    }
    const credential = await this.resolveCredential(profile.endpointId, profile.id, endpoint.auth);
    return createTtsAdapter({
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model: resolveTtsModel(endpoint.protocol, endpoint, profile),
      apiKey: credential.apiKey,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers,
      voice: profile.voice,
      format: profile.format,
      speed: profile.speed,
    });
  }

  private async resolveSttProfile(
    profile: VoiceSttProfileConfig,
    endpoints: Record<string, VoiceSttEndpointConfig>,
  ): Promise<VoiceProfileState> {
    const endpoint = endpoints[profile.endpointId];
    if (!endpoint) {
      return {
        id: profile.id,
        label: profile.label,
        endpointId: profile.endpointId,
        protocol: "unknown",
        model: profile.model,
        ready: false,
        keySource: "missing",
        isDefault: false,
        invalidReason: `Unknown endpoint '${profile.endpointId}'.`,
      };
    }
    const credential = await this.resolveCredential(profile.endpointId, profile.id, endpoint.auth);
    return {
      id: profile.id,
      label: profile.label,
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model: profile.model,
      ready: credential.ready,
      keySource: credential.keySource,
      isDefault: false,
      invalidReason: credential.invalidReason,
    };
  }

  private async resolveTtsProfile(
    profile: VoiceTtsProfileConfig,
    endpoints: Record<string, VoiceTtsEndpointConfig>,
  ): Promise<VoiceProfileState> {
    const endpoint = endpoints[profile.endpointId];
    if (!endpoint) {
      return {
        id: profile.id,
        label: profile.label,
        endpointId: profile.endpointId,
        protocol: "unknown",
        model: profile.model ?? "",
        voice: profile.voice,
        ready: false,
        keySource: "missing",
        isDefault: false,
        invalidReason: `Unknown endpoint '${profile.endpointId}'.`,
      };
    }
    const credential = await this.resolveCredential(profile.endpointId, profile.id, endpoint.auth);
    return {
      id: profile.id,
      label: profile.label,
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model: resolveTtsModel(endpoint.protocol, endpoint, profile),
      voice: profile.voice,
      ready: credential.ready,
      keySource: credential.keySource,
      isDefault: false,
      invalidReason: credential.invalidReason,
    };
  }

  private selectActive(modality: "stt" | "tts", states: VoiceProfileState[]): string | undefined {
    const selected = modality === "stt" ? this.sttSelected : this.ttsSelected;
    const defaultId =
      modality === "stt" ? this.config.stt.defaultProfileId : this.config.tts.defaultProfileId;
    if (selected && states.some((state) => state.id === selected)) {
      return selected;
    }
    if (defaultId && states.some((state) => state.id === defaultId)) {
      return defaultId;
    }
    const ready = states.find((state) => state.ready);
    return (ready ?? states[0])?.id;
  }

  private async resolveCredential(
    endpointId: string,
    profileId: string,
    auth: EndpointAuthConfig | undefined,
  ): Promise<ResolvedCredential> {
    if (!auth || auth.type === "none") {
      return { ready: true, keySource: "not_required" };
    }

    if (auth.type === "env") {
      const envKey = normalizeKey(Bun.env[auth.env]);
      if (envKey) {
        return { ready: true, keySource: "env", apiKey: envKey };
      }
    }

    const stored = await this.getStoredCredential(endpointId, profileId);
    if (stored) {
      return { ready: true, keySource: "secure_store", apiKey: stored };
    }

    return {
      ready: false,
      keySource: "missing",
      invalidReason:
        auth.type === "env"
          ? `Set ${auth.env} or store a key for endpoint '${endpointId}'.`
          : `Store a key for endpoint '${endpointId}'.`,
    };
  }

  private async getStoredCredential(endpointId: string, profileId: string): Promise<string | null> {
    const byEndpoint = await this.credentialStore.get(`${CREDENTIAL_PREFIX}${endpointId}`);
    if (byEndpoint) {
      return normalizeKey(byEndpoint) ?? null;
    }
    const byProfile = await this.credentialStore.get(`${CREDENTIAL_PREFIX}${profileId}`);
    return byProfile ? (normalizeKey(byProfile) ?? null) : null;
  }
}

function resolveTtsModel(
  protocol: TtsProtocol,
  endpoint: VoiceTtsEndpointConfig,
  profile: VoiceTtsProfileConfig,
): string {
  if (profile.model) {
    return profile.model;
  }
  if (endpoint.model) {
    return endpoint.model;
  }
  switch (protocol) {
    case "piper":
      return profile.voice;
    case "elevenlabs":
      return "eleven_multilingual_v2";
    case "openai-speech":
      return "gpt-4o-mini-tts";
  }
}

function normalizeKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

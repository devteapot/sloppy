import { createHash } from "node:crypto";

import type { EndpointAuthConfig } from "../config/schema";
import {
  type CredentialStore,
  type CredentialStoreKind,
  type CredentialStoreStatus,
  createCredentialStore,
} from "../llm/credential-store";
import { mergeSttEndpoints, mergeTtsEndpoints } from "./catalog";
import { speechRegistry } from "./register";
import type { SttProtocolAdapter, TtsProtocolAdapter } from "./types";

// Speech credentials live in the same secure store as LLM keys but under a
// dedicated `voice:` account prefix so they never collide with LLM endpoint ids.
const CREDENTIAL_PREFIX = "voice:";

const DEFAULT_STT_SAMPLE_RATE = 16000;
const DEFAULT_TTS_SAMPLE_RATE = 24000;

// Structural config types. The zod-inferred plugin config satisfies these;
// keeping them structural lets the manager (and plugin-registered protocols)
// avoid depending on the closed schema shape.
export type SpeechSttEndpointConfig = {
  label?: string;
  protocol: string;
  dialect?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: EndpointAuthConfig;
  sampleRate?: number;
  models?: Record<string, { label?: string }>;
};

export type SpeechTtsEndpointConfig = {
  label?: string;
  protocol: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: EndpointAuthConfig;
  model?: string;
  pcmSampleRate?: number;
  voices?: Record<string, { label?: string }>;
};

export type SpeechSttProfileConfig = {
  id: string;
  label?: string;
  endpointId: string;
  model: string;
  language?: string;
};

export type SpeechTtsProfileConfig = {
  id: string;
  label?: string;
  endpointId: string;
  model?: string;
  voice: string;
  speed?: number;
};

export type SpeechPluginConfig = {
  enabled: boolean;
  stt: {
    endpoints: Record<string, SpeechSttEndpointConfig>;
    profiles: SpeechSttProfileConfig[];
    defaultProfileId?: string;
  };
  tts: {
    endpoints: Record<string, SpeechTtsEndpointConfig>;
    profiles: SpeechTtsProfileConfig[];
    defaultProfileId?: string;
  };
};

export type SpeechKeySource = "env" | "secure_store" | "not_required" | "missing";

export type SpeechProfileState = {
  id: string;
  label?: string;
  endpointId: string;
  protocol: string;
  dialect?: string;
  model: string;
  voice?: string;
  ready: boolean;
  keySource: SpeechKeySource;
  isDefault: boolean;
  invalidReason?: string;
};

export type SpeechModalityStateSnapshot = {
  status: "ready" | "needs_credentials" | "not_configured";
  activeProfileId?: string;
  selectedEndpointId?: string;
  selectedProtocol?: string;
  selectedDialect?: string;
  selectedModel?: string;
  selectedVoice?: string;
  selectedSampleRate?: number;
  secureStoreKind: CredentialStoreKind;
  secureStoreStatus: CredentialStoreStatus;
  profiles: SpeechProfileState[];
};

type ResolvedCredential = {
  ready: boolean;
  keySource: SpeechKeySource;
  apiKey?: string;
  invalidReason?: string;
};

/**
 * Resolves speech STT/TTS profiles to ready-to-use streaming adapters,
 * mirroring `LlmProfileManager`: profile → endpoint → credential → adapter
 * (via the speech protocol registry). Reuses the shared `CredentialStore`;
 * reports per-modality readiness so a partial pipeline (STT-only or TTS-only)
 * is a first-class state, not an error.
 */
export class SpeechProfileManager {
  private config: SpeechPluginConfig;
  private readonly credentialStore: CredentialStore;
  private sttSelected?: string;
  private ttsSelected?: string;
  private readonly sttAdapters = new Map<
    string,
    { fingerprint: string; adapter: SttProtocolAdapter }
  >();
  private readonly ttsAdapters = new Map<
    string,
    { fingerprint: string; adapter: TtsProtocolAdapter }
  >();

  constructor(config: SpeechPluginConfig, options?: { credentialStore?: CredentialStore }) {
    this.config = config;
    this.credentialStore = options?.credentialStore ?? createCredentialStore();
  }

  updateConfig(config: SpeechPluginConfig): void {
    this.config = config;
    this.sttAdapters.clear();
    this.ttsAdapters.clear();
  }

  setSttProfile(profileId: string): void {
    this.sttSelected = profileId;
  }

  setTtsProfile(profileId: string): void {
    this.ttsSelected = profileId;
  }

  sttEndpoints(): Record<string, SpeechSttEndpointConfig> {
    return mergeSttEndpoints(this.config.stt.endpoints);
  }

  ttsEndpoints(): Record<string, SpeechTtsEndpointConfig> {
    return mergeTtsEndpoints(this.config.tts.endpoints);
  }

  async getSttState(): Promise<SpeechModalityStateSnapshot> {
    const endpoints = this.sttEndpoints();
    const profiles = this.config.stt.profiles;
    const secureStoreStatus = await this.credentialStore.getStatus();
    const states = await Promise.all(
      profiles.map((profile) => this.resolveSttProfile(profile, endpoints)),
    );
    const activeId = this.selectActive("stt", states);
    const profileStates = states.map((state) => ({ ...state, isDefault: state.id === activeId }));
    const active = profileStates.find((state) => state.id === activeId);
    const activeEndpoint = active ? endpoints[active.endpointId] : undefined;
    return {
      status:
        profiles.length === 0 ? "not_configured" : active?.ready ? "ready" : "needs_credentials",
      activeProfileId: active?.id,
      selectedEndpointId: active?.endpointId,
      selectedProtocol: active?.protocol,
      selectedDialect: active?.dialect,
      selectedModel: active?.model,
      selectedSampleRate: activeEndpoint?.sampleRate ?? DEFAULT_STT_SAMPLE_RATE,
      secureStoreKind: this.credentialStore.kind,
      secureStoreStatus,
      profiles: profileStates,
    };
  }

  async getTtsState(): Promise<SpeechModalityStateSnapshot> {
    const endpoints = this.ttsEndpoints();
    const profiles = this.config.tts.profiles;
    const secureStoreStatus = await this.credentialStore.getStatus();
    const states = await Promise.all(
      profiles.map((profile) => this.resolveTtsProfile(profile, endpoints)),
    );
    const activeId = this.selectActive("tts", states);
    const profileStates = states.map((state) => ({ ...state, isDefault: state.id === activeId }));
    const active = profileStates.find((state) => state.id === activeId);
    const activeEndpoint = active ? endpoints[active.endpointId] : undefined;
    return {
      status:
        profiles.length === 0 ? "not_configured" : active?.ready ? "ready" : "needs_credentials",
      activeProfileId: active?.id,
      selectedEndpointId: active?.endpointId,
      selectedProtocol: active?.protocol,
      selectedModel: active?.model,
      selectedVoice: active?.voice,
      selectedSampleRate: activeEndpoint?.pcmSampleRate ?? DEFAULT_TTS_SAMPLE_RATE,
      secureStoreKind: this.credentialStore.kind,
      secureStoreStatus,
      profiles: profileStates,
    };
  }

  /**
   * The endpoint the next createSttAdapter() call will hit — same selection
   * logic, exported so policy decisions can never diverge from what actually
   * runs.
   */
  async activeSttEndpoint(): Promise<{ id: string; config: SpeechSttEndpointConfig } | null> {
    const state = await this.getSttState();
    if (!state.selectedEndpointId) {
      return null;
    }
    const config = this.sttEndpoints()[state.selectedEndpointId];
    return config ? { id: state.selectedEndpointId, config } : null;
  }

  async activeTtsEndpoint(): Promise<{ id: string; config: SpeechTtsEndpointConfig } | null> {
    const state = await this.getTtsState();
    if (!state.selectedEndpointId) {
      return null;
    }
    const config = this.ttsEndpoints()[state.selectedEndpointId];
    return config ? { id: state.selectedEndpointId, config } : null;
  }

  async createSttAdapter(profileId?: string): Promise<SttProtocolAdapter> {
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
    const sampleRate = endpoint.sampleRate ?? DEFAULT_STT_SAMPLE_RATE;
    const fingerprint = fingerprintOf([
      endpoint.protocol,
      endpoint.dialect,
      endpoint.baseUrl,
      endpoint.headers,
      profile.model,
      profile.language,
      sampleRate,
      credential.apiKey,
    ]);
    const cached = this.sttAdapters.get(targetId);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.adapter;
    }
    const adapter = speechRegistry.createSttAdapter({
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      dialect: endpoint.dialect,
      model: profile.model,
      apiKey: credential.apiKey,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers,
      language: profile.language,
      sampleRate,
    });
    this.sttAdapters.set(targetId, { fingerprint, adapter });
    return adapter;
  }

  async createTtsAdapter(profileId?: string): Promise<TtsProtocolAdapter> {
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
    const pcmSampleRate = endpoint.pcmSampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
    const model = profile.model ?? endpoint.model ?? "";
    const fingerprint = fingerprintOf([
      endpoint.protocol,
      endpoint.baseUrl,
      endpoint.headers,
      model,
      profile.voice,
      profile.speed,
      pcmSampleRate,
      credential.apiKey,
    ]);
    const cached = this.ttsAdapters.get(targetId);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.adapter;
    }
    const adapter = speechRegistry.createTtsAdapter({
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model,
      apiKey: credential.apiKey,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers,
      voice: profile.voice,
      speed: profile.speed,
      pcmSampleRate,
    });
    this.ttsAdapters.set(targetId, { fingerprint, adapter });
    return adapter;
  }

  private async resolveSttProfile(
    profile: SpeechSttProfileConfig,
    endpoints: Record<string, SpeechSttEndpointConfig>,
  ): Promise<SpeechProfileState> {
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
    if (!speechRegistry.hasSttProtocol(endpoint.protocol)) {
      return {
        id: profile.id,
        label: profile.label,
        endpointId: profile.endpointId,
        protocol: endpoint.protocol,
        dialect: endpoint.dialect,
        model: profile.model,
        ready: false,
        keySource: "missing",
        isDefault: false,
        invalidReason: `Unknown STT protocol '${endpoint.protocol}'. Registered: ${speechRegistry.sttProtocols().join(", ")}.`,
      };
    }
    const credential = await this.resolveCredential(profile.endpointId, profile.id, endpoint.auth);
    return {
      id: profile.id,
      label: profile.label,
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      dialect: endpoint.dialect,
      model: profile.model,
      ready: credential.ready,
      keySource: credential.keySource,
      isDefault: false,
      invalidReason: credential.invalidReason,
    };
  }

  private async resolveTtsProfile(
    profile: SpeechTtsProfileConfig,
    endpoints: Record<string, SpeechTtsEndpointConfig>,
  ): Promise<SpeechProfileState> {
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
    if (!speechRegistry.hasTtsProtocol(endpoint.protocol)) {
      return {
        id: profile.id,
        label: profile.label,
        endpointId: profile.endpointId,
        protocol: endpoint.protocol,
        model: profile.model ?? endpoint.model ?? "",
        voice: profile.voice,
        ready: false,
        keySource: "missing",
        isDefault: false,
        invalidReason: `Unknown TTS protocol '${endpoint.protocol}'. Registered: ${speechRegistry.ttsProtocols().join(", ")}.`,
      };
    }
    const credential = await this.resolveCredential(profile.endpointId, profile.id, endpoint.auth);
    return {
      id: profile.id,
      label: profile.label,
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model: profile.model ?? endpoint.model ?? "",
      voice: profile.voice,
      ready: credential.ready,
      keySource: credential.keySource,
      isDefault: false,
      invalidReason: credential.invalidReason,
    };
  }

  private selectActive(modality: "stt" | "tts", states: SpeechProfileState[]): string | undefined {
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

function fingerprintOf(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function normalizeKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

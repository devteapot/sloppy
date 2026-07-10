import { createHash, createHmac, randomBytes } from "node:crypto";

import type { EndpointAuthConfig } from "../config/schema";
import {
  type CredentialStore,
  type CredentialStoreKind,
  type CredentialStoreStatus,
  createCredentialStore,
} from "../llm/credential-store";
import { type SpeechProtocolRegistry, speechRegistry } from "./registry";
import type { SttProtocolAdapter, TtsProtocolAdapter } from "./types";

// Speech credentials live in the same secure store as LLM keys but under a
// dedicated `voice:` account prefix so they never collide with LLM endpoint ids.
const CREDENTIAL_PREFIX = "voice:";

const DEFAULT_STT_SAMPLE_RATE = 16000;
const DEFAULT_TTS_SAMPLE_RATE = 24000;
const PUBLIC_ROUTING_FINGERPRINT_KEY = randomBytes(32);

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

export type SpeechEndpointDefaults = {
  stt?: Record<string, SpeechSttEndpointConfig>;
  tts?: Record<string, SpeechTtsEndpointConfig>;
};

export type PreparedSpeechDestination = Readonly<{
  profileId: string;
  endpointId: string;
  label: string;
  origin?: string;
  remote: boolean;
  routingFingerprint: string;
}>;

export type PreparedSpeechAdapterSet = Readonly<{
  generation: number;
  stt: Readonly<{
    destination: PreparedSpeechDestination;
    createAdapter(): SttProtocolAdapter;
  }>;
  tts?: Readonly<{
    destination: PreparedSpeechDestination;
    createAdapter(): TtsProtocolAdapter;
  }>;
}>;

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
  private readonly registry: SpeechProtocolRegistry;
  private readonly defaults: SpeechEndpointDefaults;
  private generation = 0;
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
  private readonly selectionListeners = new Set<() => void>();

  constructor(
    config: SpeechPluginConfig,
    options?: {
      credentialStore?: CredentialStore;
      /** Protocol registry to resolve adapters from; defaults to the shared singleton. */
      registry?: SpeechProtocolRegistry;
      /** Built-in endpoints overlaid under the user's configured ones. */
      defaults?: SpeechEndpointDefaults;
    },
  ) {
    this.config = structuredClone(config);
    this.credentialStore = options?.credentialStore ?? createCredentialStore();
    // The registry defaults to the shared singleton, which starts EMPTY —
    // protocols are registered by the plugin layer (see voice/protocols).
    // Construct managers through catalog.ts's speechManagerFor, or register
    // protocols / inject a registry yourself.
    this.registry = options?.registry ?? speechRegistry;
    this.defaults = structuredClone(options?.defaults ?? {});
  }

  updateConfig(config: SpeechPluginConfig): void {
    this.config = structuredClone(config);
    this.generation += 1;
    this.sttAdapters.clear();
    this.ttsAdapters.clear();
    this.emitSelectionChange();
  }

  setSttProfile(profileId: string): void {
    if (!this.config.stt.profiles.some((profile) => profile.id === profileId)) {
      throw new Error(`STT profile '${profileId}' is not configured.`);
    }
    if (this.sttSelected === profileId) {
      return;
    }
    this.sttSelected = profileId;
    this.generation += 1;
    this.emitSelectionChange();
  }

  setTtsProfile(profileId: string): void {
    if (!this.config.tts.profiles.some((profile) => profile.id === profileId)) {
      throw new Error(`TTS profile '${profileId}' is not configured.`);
    }
    if (this.ttsSelected === profileId) {
      return;
    }
    this.ttsSelected = profileId;
    this.generation += 1;
    this.emitSelectionChange();
  }

  /** Active runs subscribe so a profile change cannot silently change egress. */
  onSelectionChange(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  sttEndpoints(): Record<string, SpeechSttEndpointConfig> {
    return { ...this.defaults.stt, ...this.config.stt.endpoints };
  }

  ttsEndpoints(): Record<string, SpeechTtsEndpointConfig> {
    return { ...this.defaults.tts, ...this.config.tts.endpoints };
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

  /**
   * Capture both active modalities from one config/profile generation and bind
   * adapter factories to copied endpoint/profile inputs. If selection changes
   * while credentials are resolving, the capture retries instead of returning
   * a mixed-generation plan.
   */
  async prepareActiveAdapters(options?: {
    signal?: AbortSignal;
  }): Promise<PreparedSpeechAdapterSet> {
    for (;;) {
      throwIfSpeechPreparationAborted(options?.signal);
      const generation = this.generation;
      const config = structuredClone(this.config);
      const sttSelected = this.sttSelected;
      const ttsSelected = this.ttsSelected;
      const sttEndpoints = structuredClone({ ...this.defaults.stt, ...config.stt.endpoints });
      const ttsEndpoints = structuredClone({ ...this.defaults.tts, ...config.tts.endpoints });

      const [sttStates, ttsStates] = await abortableSpeechPreparation(
        Promise.all([
          Promise.all(
            config.stt.profiles.map((profile) =>
              this.resolveSttProfile(profile, sttEndpoints, options?.signal),
            ),
          ),
          Promise.all(
            config.tts.profiles.map((profile) =>
              this.resolveTtsProfile(profile, ttsEndpoints, options?.signal),
            ),
          ),
        ]),
        options?.signal,
      );
      if (generation !== this.generation) {
        continue;
      }

      const sttProfileId = selectCapturedProfile(
        sttSelected,
        config.stt.defaultProfileId,
        sttStates,
      );
      const sttProfile = config.stt.profiles.find((profile) => profile.id === sttProfileId);
      const sttState = sttStates.find((state) => state.id === sttProfileId);
      if (!sttProfile || !sttState?.ready) {
        throw new Error(
          sttState?.invalidReason ?? "A ready STT profile is required to start a voice run.",
        );
      }
      const sttEndpoint = sttEndpoints[sttProfile.endpointId];
      if (!sttEndpoint) {
        throw new Error(
          `STT profile '${sttProfile.id}' references unknown endpoint '${sttProfile.endpointId}'.`,
        );
      }
      const sttCredential = await abortableSpeechPreparation(
        this.resolveCredential(
          sttProfile.endpointId,
          sttProfile.id,
          sttEndpoint.auth,
          options?.signal,
        ),
        options?.signal,
      );
      if (!sttCredential.ready) {
        throw new Error(sttCredential.invalidReason ?? "STT profile is not ready.");
      }

      const ttsProfileId = selectCapturedProfile(
        ttsSelected,
        config.tts.defaultProfileId,
        ttsStates,
      );
      const ttsProfile = config.tts.profiles.find((profile) => profile.id === ttsProfileId);
      const ttsState = ttsStates.find((state) => state.id === ttsProfileId);
      let preparedTts: PreparedSpeechAdapterSet["tts"];
      if (ttsProfile && ttsState?.ready) {
        const ttsEndpoint = ttsEndpoints[ttsProfile.endpointId];
        if (!ttsEndpoint) {
          throw new Error(
            `TTS profile '${ttsProfile.id}' references unknown endpoint '${ttsProfile.endpointId}'.`,
          );
        }
        const ttsCredential = await abortableSpeechPreparation(
          this.resolveCredential(
            ttsProfile.endpointId,
            ttsProfile.id,
            ttsEndpoint.auth,
            options?.signal,
          ),
          options?.signal,
        );
        if (!ttsCredential.ready) {
          throw new Error(ttsCredential.invalidReason ?? "TTS profile is not ready.");
        }
        preparedTts = this.bindTtsAdapter(ttsProfile, ttsEndpoint, ttsCredential.apiKey);
      }

      if (generation !== this.generation) {
        continue;
      }
      return Object.freeze({
        generation,
        stt: this.bindSttAdapter(sttProfile, sttEndpoint, sttCredential.apiKey),
        ...(preparedTts && { tts: preparedTts }),
      });
    }
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
    const adapter = this.registry.createSttAdapter({
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
    const adapter = this.registry.createTtsAdapter({
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
    signal?: AbortSignal,
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
    if (!this.registry.hasSttProtocol(endpoint.protocol)) {
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
        invalidReason: `Unknown STT protocol '${endpoint.protocol}'. Registered: ${this.registry.sttProtocols().join(", ")}.`,
      };
    }
    const credential = await this.resolveCredential(
      profile.endpointId,
      profile.id,
      endpoint.auth,
      signal,
    );
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
    signal?: AbortSignal,
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
    if (!this.registry.hasTtsProtocol(endpoint.protocol)) {
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
        invalidReason: `Unknown TTS protocol '${endpoint.protocol}'. Registered: ${this.registry.ttsProtocols().join(", ")}.`,
      };
    }
    const credential = await this.resolveCredential(
      profile.endpointId,
      profile.id,
      endpoint.auth,
      signal,
    );
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

  private bindSttAdapter(
    profile: SpeechSttProfileConfig,
    endpoint: SpeechSttEndpointConfig,
    apiKey?: string,
  ): PreparedSpeechAdapterSet["stt"] {
    const sampleRate = endpoint.sampleRate ?? DEFAULT_STT_SAMPLE_RATE;
    const adapterConfig = Object.freeze({
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      dialect: endpoint.dialect,
      model: profile.model,
      apiKey,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers ? Object.freeze({ ...endpoint.headers }) : undefined,
      language: profile.language,
      sampleRate,
    });
    return Object.freeze({
      destination: buildPreparedDestination("stt", profile, endpoint, {
        protocol: endpoint.protocol,
        dialect: endpoint.dialect,
        model: profile.model,
        language: profile.language,
        sampleRate,
        headers: endpoint.headers,
      }),
      createAdapter: () => this.registry.createSttAdapter(adapterConfig),
    });
  }

  private bindTtsAdapter(
    profile: SpeechTtsProfileConfig,
    endpoint: SpeechTtsEndpointConfig,
    apiKey?: string,
  ): NonNullable<PreparedSpeechAdapterSet["tts"]> {
    const pcmSampleRate = endpoint.pcmSampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
    const model = profile.model ?? endpoint.model ?? "";
    const adapterConfig = Object.freeze({
      endpointId: profile.endpointId,
      protocol: endpoint.protocol,
      model,
      apiKey,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers ? Object.freeze({ ...endpoint.headers }) : undefined,
      voice: profile.voice,
      speed: profile.speed,
      pcmSampleRate,
    });
    return Object.freeze({
      destination: buildPreparedDestination("tts", profile, endpoint, {
        protocol: endpoint.protocol,
        model,
        voice: profile.voice,
        speed: profile.speed,
        pcmSampleRate,
        headers: endpoint.headers,
      }),
      createAdapter: () => this.registry.createTtsAdapter(adapterConfig),
    });
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
    signal?: AbortSignal,
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

    const stored = await this.getStoredCredential(endpointId, profileId, signal);
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

  private async getStoredCredential(
    endpointId: string,
    profileId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const byEndpoint = await this.credentialStore.get(`${CREDENTIAL_PREFIX}${endpointId}`, {
      signal,
    });
    if (byEndpoint) {
      return normalizeKey(byEndpoint) ?? null;
    }
    const byProfile = await this.credentialStore.get(`${CREDENTIAL_PREFIX}${profileId}`, {
      signal,
    });
    return byProfile ? (normalizeKey(byProfile) ?? null) : null;
  }

  private emitSelectionChange(): void {
    for (const listener of this.selectionListeners) {
      listener();
    }
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

function throwIfSpeechPreparationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Speech adapter preparation cancelled.");
  }
}

function abortableSpeechPreparation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  try {
    throwIfSpeechPreparationAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfSpeechPreparationAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function selectCapturedProfile(
  selected: string | undefined,
  defaultId: string | undefined,
  states: SpeechProfileState[],
): string | undefined {
  if (selected && states.some((state) => state.id === selected)) return selected;
  if (defaultId && states.some((state) => state.id === defaultId)) return defaultId;
  return (states.find((state) => state.ready) ?? states[0])?.id;
}

function buildPreparedDestination(
  modality: "stt" | "tts",
  profile: SpeechSttProfileConfig | SpeechTtsProfileConfig,
  endpoint: SpeechSttEndpointConfig | SpeechTtsEndpointConfig,
  routingInputs: Record<string, unknown>,
): PreparedSpeechDestination {
  const target = sanitizedTarget(endpoint.baseUrl);
  if (!target) {
    throw new Error(
      `${modality.toUpperCase()} endpoint '${profile.endpointId}' must declare an explicit valid baseUrl before it can be frozen into a voice run.`,
    );
  }
  const noAuth = !endpoint.auth || endpoint.auth.type === "none";
  const remote = !(noAuth && target.local);
  return Object.freeze({
    profileId: profile.id,
    endpointId: profile.endpointId,
    label: endpoint.label ?? profile.endpointId,
    origin: target.origin,
    remote,
    routingFingerprint: opaqueRoutingFingerprintOf([
      modality,
      profile.id,
      profile.endpointId,
      endpoint.baseUrl,
      endpoint.auth?.type ?? "none",
      routingInputs,
    ]),
  });
}

function sanitizedTarget(
  baseUrl: string | undefined,
): { origin: string; target: string; local: boolean } | undefined {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const supportedSpeechScheme =
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "ws:" ||
      parsed.protocol === "wss:";
    const local =
      supportedSpeechScheme &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "0.0.0.0" ||
        hostname === "[::1]" ||
        hostname === "::1");
    return {
      origin: parsed.origin,
      target: `${parsed.origin}${parsed.pathname}`,
      local,
    };
  } catch {
    return undefined;
  }
}

function opaqueRoutingFingerprintOf(parts: unknown[]): string {
  return createHmac("sha256", PUBLIC_ROUTING_FINGERPRINT_KEY)
    .update(JSON.stringify(parts))
    .digest("hex");
}

import type { LlmStateSnapshot as RuntimeLlmStateSnapshot } from "../llm/profile-manager";
import type { LlmStateSnapshot } from "./types";

export type ExternalSessionAgentState = {
  provider: string;
  model: string;
  adapterId?: string;
  profileId?: string;
  label?: string;
  message?: string;
};

export function toSessionLlmState(state: RuntimeLlmStateSnapshot): LlmStateSnapshot {
  return {
    status: state.status,
    message: state.message,
    activeProfileId: state.activeProfileId,
    selectedProvider: state.selectedProvider,
    selectedModel: state.selectedModel,
    selectedContextWindowTokens: state.selectedContextWindowTokens,
    secureStoreKind: state.secureStoreKind,
    secureStoreStatus: state.secureStoreStatus,
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      kind: profile.kind === "engine" ? "engine" : "api",
      provider: profile.kind === "engine" ? `engine:${profile.engine}` : profile.provider,
      engine: profile.kind === "engine" ? profile.engine : undefined,
      model: profile.model,
      dialect: profile.kind === "engine" ? profile.dialect : undefined,
      transport: profile.kind === "engine" ? profile.transport : undefined,
      reasoningEffort: profile.kind === "api" ? profile.reasoningEffort : undefined,
      adapterId: profile.kind === "api" ? profile.adapterId : undefined,
      apiKeyEnv: profile.kind === "api" ? profile.apiKeyEnv : undefined,
      baseUrl: profile.kind === "api" ? profile.baseUrl : undefined,
      contextWindowTokens: profile.contextWindowTokens,
      isDefault: profile.isDefault,
      hasKey: profile.hasKey,
      keySource: profile.keySource,
      ready: profile.ready,
      managed: profile.managed,
      origin: profile.origin,
      canDeleteProfile: profile.canDeleteProfile,
      canDeleteApiKey: profile.canDeleteApiKey,
    })),
  };
}

export function toExternalAgentLlmState(agent: ExternalSessionAgentState): LlmStateSnapshot {
  const profileId = agent.profileId ?? `external-${agent.provider}`;
  const label = agent.label ?? `${agent.provider} ${agent.model}`;
  return {
    status: "ready",
    message: agent.message ?? `Ready to chat with ${label}.`,
    activeProfileId: profileId,
    selectedProvider: agent.provider,
    selectedModel: agent.model,
    selectedContextWindowTokens: undefined,
    secureStoreKind: "none",
    secureStoreStatus: "unsupported",
    profiles: [
      {
        id: profileId,
        label,
        kind: "api",
        provider: agent.provider,
        model: agent.model,
        adapterId: agent.adapterId,
        contextWindowTokens: undefined,
        isDefault: true,
        hasKey: false,
        keySource: "not_required",
        ready: true,
        managed: false,
        origin: "fallback",
        canDeleteProfile: false,
        canDeleteApiKey: false,
      },
    ],
  };
}

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
    selectedEndpointId: state.selectedEndpointId,
    selectedProtocol: state.selectedProtocol,
    selectedModel: state.selectedModel,
    selectedContextWindowTokens: state.selectedContextWindowTokens,
    secureStoreKind: state.secureStoreKind,
    secureStoreStatus: state.secureStoreStatus,
    profiles: state.profiles.map((profile) => {
      const thinking = profile.thinking ?? {
        enabled: true,
        display: "visible" as const,
        effort: "medium" as const,
        effectiveEnabled: true,
        effectiveReason: "unknown" as const,
        effectiveEffort: profile.reasoningEffort ?? ("medium" as const),
      };
      return {
        kind: profile.kind,
        id: profile.id,
        label: profile.label,
        endpointId: profile.endpointId,
        protocol: profile.protocol,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        thinkingEnabled: thinking.enabled,
        thinkingDisplay: thinking.display,
        thinkingEffectiveEnabled: thinking.effectiveEnabled,
        thinkingEffectiveReason: thinking.effectiveReason,
        thinkingEffort: thinking.effectiveEffort,
        adapterId: profile.adapterId,
        authEnv: profile.authEnv,
        baseUrl: profile.baseUrl,
        contextWindowTokens: profile.contextWindowTokens,
        isDefault: profile.isDefault,
        hasKey: profile.hasKey,
        keySource: profile.keySource,
        ready: profile.ready,
        managed: profile.managed,
        origin: profile.origin,
        canDeleteProfile: profile.canDeleteProfile,
        canDeleteApiKey: profile.canDeleteApiKey,
      };
    }),
  };
}

export function toExternalAgentLlmState(agent: ExternalSessionAgentState): LlmStateSnapshot {
  const profileId = agent.profileId ?? `external-${agent.provider}`;
  const label = agent.label ?? `${agent.provider} ${agent.model}`;
  return {
    status: "ready",
    message: agent.message ?? `Ready to chat with ${label}.`,
    activeProfileId: profileId,
    selectedEndpointId: agent.provider,
    selectedProtocol: "session-agent",
    selectedModel: agent.model,
    selectedContextWindowTokens: undefined,
    secureStoreKind: "none",
    secureStoreStatus: "unsupported",
    profiles: [
      {
        kind: "session-agent",
        id: profileId,
        label,
        endpointId: agent.provider,
        protocol: "session-agent",
        model: agent.model,
        thinkingEnabled: false,
        thinkingDisplay: "hidden",
        thinkingEffectiveEnabled: false,
        thinkingEffectiveReason: "provider_unsupported",
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

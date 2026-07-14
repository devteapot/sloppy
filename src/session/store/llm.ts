import type { LlmStateSnapshot } from "../types";
import { now } from "./helpers";
import type { SessionStoreState } from "./state";

export function syncLlmState(state: SessionStoreState, llm: LlmStateSnapshot): void {
  state.snapshot.llm = {
    ...llm,
    selectedCapabilities: llm.selectedCapabilities ? { ...llm.selectedCapabilities } : undefined,
    profiles: llm.profiles.map((profile) => ({
      ...profile,
      capabilities: profile.capabilities ? { ...profile.capabilities } : undefined,
    })),
  };
  const activeProfile = llm.profiles.find((profile) => profile.id === llm.activeProfileId);
  state.snapshot.session.modelProvider =
    llm.selectedEndpointId ?? activeProfile?.adapterId ?? llm.selectedProtocol ?? "unavailable";
  state.snapshot.session.model = llm.selectedModel;
  state.snapshot.session.updatedAt = now();
  state.llmChanged = true;
  state.sessionChanged = true;
}

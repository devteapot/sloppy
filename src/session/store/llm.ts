import type { LlmStateSnapshot } from "../types";
import { now } from "./helpers";
import type { SessionStoreState } from "./state";

export function syncLlmState(state: SessionStoreState, llm: LlmStateSnapshot): void {
  const { usage: _legacyUsage, ...llmState } = llm as LlmStateSnapshot & { usage?: unknown };
  state.snapshot.llm = {
    ...llmState,
    profiles: llmState.profiles.map((profile) => ({ ...profile })),
  };
  state.snapshot.session.modelProvider = llmState.selectedProvider;
  state.snapshot.session.model = llmState.selectedModel;
  state.snapshot.session.updatedAt = now();
  state.llmChanged = true;
  state.sessionChanged = true;
}

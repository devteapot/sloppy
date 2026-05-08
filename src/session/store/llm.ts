import type { LlmStateSnapshot } from "../types";
import { now } from "./helpers";
import type { SessionStoreState } from "./state";

export function syncLlmState(state: SessionStoreState, llm: LlmStateSnapshot): void {
  state.snapshot.llm = {
    ...llm,
    profiles: llm.profiles.map((profile) => ({ ...profile })),
  };
  state.snapshot.session.modelProvider = llm.selectedProvider;
  state.snapshot.session.model = llm.selectedModel;
  state.snapshot.session.updatedAt = now();
  state.llmChanged = true;
  state.sessionChanged = true;
}

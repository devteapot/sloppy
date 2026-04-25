import type {
  AgentSessionSnapshot,
  SessionStoreChangeListener,
  SessionStoreEventType,
  SessionStoreGranularListener,
} from "../types";
import type { SessionStoreState } from "./state";

export class ListenerRegistry {
  readonly listeners = new Set<SessionStoreChangeListener>();
  readonly granularListeners = new Map<SessionStoreEventType, Set<SessionStoreGranularListener>>();

  onChange(listener: SessionStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeGranular(
    eventType: SessionStoreEventType,
    fn: SessionStoreGranularListener,
  ): () => void {
    let set = this.granularListeners.get(eventType);
    if (!set) {
      set = new Set();
      this.granularListeners.set(eventType, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit(state: SessionStoreState, snapshot: AgentSessionSnapshot): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }

    const changedTypes: SessionStoreEventType[] = [];
    if (state.turnChanged) changedTypes.push("turn");
    if (state.transcriptChanged) changedTypes.push("transcript");
    if (state.activityChanged) changedTypes.push("activity");
    if (state.approvalsChanged) changedTypes.push("approvals");
    if (state.tasksChanged) changedTypes.push("tasks");
    if (state.appsChanged) changedTypes.push("apps");
    if (state.llmChanged) changedTypes.push("llm");
    if (state.sessionChanged) changedTypes.push("session");

    for (const eventType of changedTypes) {
      const listeners = this.granularListeners.get(eventType);
      if (listeners) {
        for (const fn of listeners) {
          fn({ type: eventType, snapshot });
        }
      }
    }

    state.turnChanged = false;
    state.transcriptChanged = false;
    state.activityChanged = false;
    state.approvalsChanged = false;
    state.tasksChanged = false;
    state.appsChanged = false;
    state.llmChanged = false;
    state.sessionChanged = false;
  }
}

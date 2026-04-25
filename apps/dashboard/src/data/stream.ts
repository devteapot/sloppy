import { produce } from "solid-js/store";
import { ingestEvent } from "../model/ingest";
import type { DashboardStore } from "./store";
import type { DashboardState, DeltaMessage } from "./types";

export function connect(store: DashboardStore): () => void {
  let closed = false;
  let source: EventSource | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  async function loadSnapshot() {
    try {
      const response = await fetch("/api/state");
      const state = (await response.json()) as DashboardState;
      applySnapshot(store, state);
    } catch (err) {
      console.error("snapshot fetch failed", err);
    }
  }

  function open() {
    if (closed) return;
    source = new EventSource("/api/events");
    source.addEventListener("snapshot", (e) => {
      try {
        applySnapshot(store, JSON.parse((e as MessageEvent<string>).data));
      } catch (err) {
        console.error("snapshot parse failed", err);
      }
    });
    source.addEventListener("delta", (e) => {
      try {
        applyDelta(store, JSON.parse((e as MessageEvent<string>).data));
      } catch (err) {
        console.error("delta parse failed", err);
      }
    });
    source.onerror = () => {
      source?.close();
      source = undefined;
      if (!closed) {
        retryTimer = setTimeout(() => {
          void loadSnapshot().then(open);
        }, 1500);
      }
    };
  }

  void loadSnapshot().then(open);

  return () => {
    closed = true;
    source?.close();
    if (retryTimer) clearTimeout(retryTimer);
  };
}

function applySnapshot(store: DashboardStore, state: DashboardState) {
  store.clear();
  store.setMode(state.mode);
  store.setSource(state.source);
  store.setUpdatedAt(state.updatedAt);
  store.setPlan(state.plan);
  store.setTasks(
    produce((t) => {
      for (const task of state.tasks) t[task.id] = task;
    }),
  );
  store.setHandoffs(
    produce((h) => {
      for (const handoff of state.handoffs) h[handoff.id] = handoff;
    }),
  );
  for (const event of state.events) ingestEvent(store, event);
}

function applyDelta(store: DashboardStore, delta: DeltaMessage) {
  switch (delta.kind) {
    case "snapshot":
      applySnapshot(store, delta.state);
      return;
    case "plan":
      store.setPlan(delta.fields);
      store.setUpdatedAt(delta.updatedAt);
      return;
    case "task":
      store.setTasks(
        produce((t) => {
          if (delta.fields === null) delete t[delta.id];
          else t[delta.id] = delta.fields;
        }),
      );
      store.setUpdatedAt(delta.updatedAt);
      return;
    case "handoff":
      store.setHandoffs(
        produce((h) => {
          if (delta.fields === null) delete h[delta.id];
          else h[delta.id] = delta.fields;
        }),
      );
      store.setUpdatedAt(delta.updatedAt);
      return;
    case "event":
      ingestEvent(store, delta.event);
      return;
  }
}

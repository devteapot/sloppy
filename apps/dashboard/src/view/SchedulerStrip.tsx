import { createMemo } from "solid-js";
import type { DashboardStore } from "../data/store";
import { taskCounts } from "../model/derive";

export function SchedulerStrip(props: { store: DashboardStore }) {
  const { store } = props;
  const counts = createMemo(() => taskCounts(Object.values(store.tasks)));
  const blockedCount = createMemo(
    () => Object.values(store.tasks).filter((t) => t.unmetDependencies.length > 0).length,
  );
  const handoffPending = createMemo(
    () => Object.values(store.handoffs).filter((h) => h.status === "pending").length,
  );

  return (
    <section class="scheduler-strip">
      <span class={`scheduler-state ${store.scheduler.idle ? "idle" : "blocked"}`}>
        {store.scheduler.idle ? "idle" : "blocked"}
      </span>
      <span class="pill running">{counts().running ?? 0} running</span>
      <span class="pill scheduled">{counts().scheduled ?? 0} scheduled</span>
      <span class="pill verifying">{counts().verifying ?? 0} verifying</span>
      <span class="pill completed">{counts().completed ?? 0} done</span>
      <span class={`pill ${blockedCount() > 0 ? "failed" : ""}`}>{blockedCount()} blocked</span>
      <span class={`pill ${handoffPending() > 0 ? "pending" : ""}`}>
        {handoffPending()} handoffs
      </span>
      {store.scheduler.lastReason ? (
        <span class="scheduler-reason mono dim">{store.scheduler.lastReason}</span>
      ) : null}
    </section>
  );
}

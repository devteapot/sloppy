import type { DashboardStore } from "../data/store";

export function Header(props: { store: DashboardStore }) {
  const { store } = props;
  const pendingApprovals = () =>
    Object.values(store.agents).filter((a) => a.pendingApproval).length;
  return (
    <header class="hud hud-top">
      <div class="brand">
        <span class="brand-mark" />
        <span class="brand-text">SLOPPY</span>
      </div>
      <div class="plan">
        <span>{store.plan.query || "awaiting plan"}</span>
      </div>
      <div class="meta">
        {pendingApprovals() > 0 ? (
          <span class="pill approvals">{pendingApprovals()} approvals</span>
        ) : null}
        <span class={`pill ${store.plan.status}`}>{store.plan.status}</span>
        <span class="mono">{formatTime(store.updatedAt())}</span>
      </div>
    </header>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

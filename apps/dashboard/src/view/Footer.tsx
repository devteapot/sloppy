import type { DashboardStore } from "../data/store";

export function Footer(props: { store: DashboardStore }) {
  const { store } = props;
  return (
    <footer class="hud hud-bottom">
      <span class="mono dim">{store.source()}</span>
      <span class="mono dim">
        {Object.keys(store.agents).length} agents · {Object.keys(store.files).length} files ·{" "}
        {store.counters.tools} tools · {store.counters.fileOps} file ops
      </span>
    </footer>
  );
}

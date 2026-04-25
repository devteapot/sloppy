import type { DashboardStore } from "../data/store";
import { Canvas } from "./Canvas";
import { ControlSurface } from "./ControlSurface";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { HierarchyRail } from "./HierarchyRail";
import { Inspector } from "./Inspector";
import { Registry } from "./Registry";
import { SchedulerStrip } from "./SchedulerStrip";

export function Stage(props: { store: DashboardStore }) {
  return (
    <div class="stage">
      <Header store={props.store} />
      <div class="stage-body">
        <Canvas store={props.store} />
        <HierarchyRail store={props.store} />
        <Registry store={props.store} />
        <ControlSurface store={props.store} />
        <Inspector store={props.store} />
        <SchedulerStrip store={props.store} />
      </div>
      <Footer store={props.store} />
    </div>
  );
}

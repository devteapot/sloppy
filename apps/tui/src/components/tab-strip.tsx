import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { COLORS } from "../lib/theme";
import type { SessionViewSnapshot, TuiRoute } from "../slop/types";

type TabDef = {
  route: TuiRoute;
  label: string;
  fkey: string;
};

const TABS: TabDef[] = [
  { route: "chat", label: "Chat", fkey: "F1" },
  { route: "setup", label: "Setup", fkey: "F2" },
  { route: "approvals", label: "Approvals", fkey: "F3" },
  { route: "tasks", label: "Tasks", fkey: "F4" },
  { route: "apps", label: "Apps", fkey: "F5" },
  { route: "inspect", label: "Inspect", fkey: "F6" },
  { route: "settings", label: "Settings", fkey: "" },
];

export function TabStrip(props: { snapshot: SessionViewSnapshot; route: TuiRoute }) {
  const counts = () => ({
    approvals: props.snapshot.approvals.filter((a) => a.status === "pending").length,
    tasks: props.snapshot.tasks.filter((t) => t.status === "running").length,
    apps: props.snapshot.apps.length,
  });

  return (
    <box height={1} flexDirection="row" backgroundColor={COLORS.panel}>
      <For each={TABS}>
        {(tab) => {
          const active = () => tab.route === props.route;
          const badge = () => {
            const c = counts();
            if (tab.route === "approvals" && c.approvals > 0) return ` ${c.approvals}`;
            if (tab.route === "tasks" && c.tasks > 0) return ` ${c.tasks}`;
            if (tab.route === "apps" && c.apps > 0) return ` ${c.apps}`;
            return "";
          };
          return (
            <text
              fg={active() ? COLORS.green : COLORS.dim}
              bg={active() ? COLORS.panelHigh : COLORS.panel}
              attributes={active() ? TextAttributes.BOLD : TextAttributes.NONE}
              content={` ${tab.label}${badge()} `}
            />
          );
        }}
      </For>
    </box>
  );
}

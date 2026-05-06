import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { COLORS } from "../lib/theme";
import type { SupervisorSessionItem } from "../slop/supervisor-client";

export function SessionStrip(props: { sessions: SupervisorSessionItem[] }) {
  return (
    <box height={1} flexDirection="row" backgroundColor={COLORS.panel} paddingX={1}>
      <For each={props.sessions}>
        {(session) => {
          const active = session.selected;
          const glyph = active ? "●" : "○";
          const pending = session.pendingApprovalCount;
          const tasks = session.runningTaskCount;
          const badge = pending > 0 || tasks > 0 ? ` (${pending}!${tasks})` : "";
          return (
            <text
              fg={active ? COLORS.green : COLORS.dim}
              attributes={active ? TextAttributes.BOLD : TextAttributes.NONE}
              content={` ${glyph} ${session.title ?? session.id}${badge} `}
            />
          );
        }}
      </For>
    </box>
  );
}

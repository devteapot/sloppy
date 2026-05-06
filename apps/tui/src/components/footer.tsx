import { COLORS } from "../lib/theme";
import type { AgentMode } from "./mode-chip";

export function Footer(props: { mouseEnabled: boolean; mode?: AgentMode }) {
  return (
    <box height={1} paddingX={1} backgroundColor={COLORS.base} flexDirection="row">
      <text
        fg={COLORS.dim}
        truncate
        content={`/help · Ctrl+K palette · ⇧⇥ mode · /verbosity · /mouse · Esc close · mouse ${props.mouseEnabled ? "on" : "off"}`}
      />
    </box>
  );
}

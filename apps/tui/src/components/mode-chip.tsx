import { TextAttributes } from "@opentui/core";
import { COLORS } from "../lib/theme";

export type AgentMode = "default" | "auto-approve" | "plan";

export const AGENT_MODES: AgentMode[] = ["default", "auto-approve", "plan"];

export function nextMode(mode: AgentMode): AgentMode {
  const index = AGENT_MODES.indexOf(mode);
  return AGENT_MODES[(index + 1) % AGENT_MODES.length] ?? "default";
}

const LABEL: Record<AgentMode, string> = {
  default: "DEFAULT",
  "auto-approve": "AUTO",
  plan: "PLAN",
};

const COLOR: Record<AgentMode, string> = {
  default: COLORS.dim,
  "auto-approve": COLORS.yellow,
  plan: COLORS.cyan,
};

export function ModeChip(props: { mode: AgentMode }) {
  return (
    <text
      fg={COLOR[props.mode]}
      attributes={TextAttributes.BOLD}
      content={` ⇧⇥ ${LABEL[props.mode]} `}
    />
  );
}

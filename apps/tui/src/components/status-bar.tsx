import { formatGoalLine } from "../lib/format";
import { COLORS, NO_COLOR_MODE } from "../lib/theme";
import type { InspectorMode, SessionViewSnapshot, TuiRoute } from "../slop/types";
import { type Verbosity, verbosityLabel } from "../state/verbosity";
import { type AgentMode, ModeChip } from "./mode-chip";

export function StatusBar(props: {
  snapshot: SessionViewSnapshot;
  route?: TuiRoute;
  inspector?: InspectorMode;
  mouseEnabled: boolean;
  mode: AgentMode;
  verbosity: Verbosity;
}) {
  const turn = () => props.snapshot.turn;
  const session = () => props.snapshot.session;
  const llm = () => props.snapshot.llm;
  const connection = () => props.snapshot.connection;
  const goal = () => props.snapshot.goal;

  const turnColor = () => {
    const state = turn().state;
    return state === "error" ? COLORS.red : state === "idle" ? COLORS.green : COLORS.cyan;
  };

  const scope = () => {
    const s = session();
    return s.workspaceId && s.projectId
      ? `${s.workspaceId}/${s.projectId}`
      : (s.workspaceId ?? s.workspaceRoot ?? "workspace");
  };
  const model = () => {
    const s = session();
    const l = llm();
    return (
      [l.selectedProvider ?? s.modelProvider, l.selectedModel ?? s.model]
        .filter(Boolean)
        .join("/") || "no model"
    );
  };

  const leftContent = () => {
    const left = ` Sloppy · ${connection().status} · ${scope()} · ${model()}`;
    const g = goal();
    const goalSegment = g.exists ? ` · goal ${formatGoalLine(g)}` : "";
    return `${left}${goalSegment}`;
  };

  const turnSegment = () => `${turn().state}${turn().phase ? `:${turn().phase}` : ""}`;
  const secureGlyph = NO_COLOR_MODE ? "[K]" : "🔒";
  const secureContent = () => `${secureGlyph} ${llm().secureStoreStatus ?? "unknown"} `;
  const secureColor = () => secureStoreColor(llm().secureStoreStatus);
  const mouseBadge = () => (props.mouseEnabled ? (NO_COLOR_MODE ? "[M]" : "🖱") : " ");

  // Right side has a fixed width budget so phase string changes during a
  // running turn (model_call → tool_use → awaiting_result) don't reflow the
  // status bar every tick — that reflow is what flickers the whole UI.
  return (
    <box height={1} flexDirection="row" backgroundColor={COLORS.panelHigh}>
      <box flexGrow={1} flexShrink={1} flexBasis={0} flexDirection="row">
        <text truncate fg={COLORS.text} content={leftContent()} />
      </box>
      <box width={32} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <text truncate fg={turnColor()} content={` ${turnSegment()} `} />
      </box>
      <box width={20} flexShrink={0} flexDirection="row">
        <text truncate fg={secureColor()} content={secureContent()} />
      </box>
      <box width={4} flexShrink={0} flexDirection="row">
        <ModeChip mode={props.mode} />
      </box>
      <box width={9} flexShrink={0} flexDirection="row">
        <text truncate fg={COLORS.dim} content={` ${verbosityLabel(props.verbosity)} `} />
      </box>
      <box width={3} flexShrink={0} flexDirection="row">
        <text fg={COLORS.yellow} content={mouseBadge()} />
      </box>
    </box>
  );
}

function secureStoreColor(status: string | undefined): string {
  switch (status) {
    case "available":
      return COLORS.green;
    case "unsupported":
      return COLORS.yellow;
    case "unavailable":
      return COLORS.red;
    default:
      return COLORS.dim;
  }
}

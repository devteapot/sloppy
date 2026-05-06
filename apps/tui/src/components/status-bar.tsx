import { COLORS, NO_COLOR_MODE } from "../lib/theme";
import type { InspectorMode, SessionViewSnapshot, TuiRoute } from "../slop/types";

export function StatusBar(props: {
  snapshot: SessionViewSnapshot;
  route: TuiRoute;
  inspector: InspectorMode;
  mouseEnabled: boolean;
}) {
  const session = props.snapshot.session;
  const turn = props.snapshot.turn;
  const llm = props.snapshot.llm;
  const statusColor =
    turn.state === "error" ? COLORS.red : turn.state === "idle" ? COLORS.green : COLORS.cyan;
  const workspace = session.workspaceRoot ?? "workspace";
  const model = [llm.selectedProvider ?? session.modelProvider, llm.selectedModel ?? session.model]
    .filter(Boolean)
    .join("/");
  const secureBadge = formatSecureBadge(props.snapshot);
  const secureColor = secureStoreColor(props.snapshot.llm.secureStoreStatus);
  const mouseBadge = props.mouseEnabled ? (NO_COLOR_MODE ? "[M]" : "🖱") : "";
  return (
    <box height={1} backgroundColor={COLORS.panelHigh}>
      <text
        truncate
        fg={COLORS.text}
        content={` Sloppy ${props.snapshot.connection.status} · ${workspace} · ${model || "no model"} `}
      />
      <text fg={secureColor} content={`${secureBadge} `} />
      <text truncate fg={statusColor} content={`${turn.state}:${turn.phase} ${turn.message}`} />
      <text fg={COLORS.yellow} content={mouseBadge ? ` ${mouseBadge}` : ""} />
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

function formatSecureBadge(snapshot: SessionViewSnapshot): string {
  const kind = snapshot.llm.secureStoreKind ?? "unknown";
  const status = snapshot.llm.secureStoreStatus ?? "unknown";
  const glyph = NO_COLOR_MODE ? "[K]" : "🔒";
  return `${glyph} ${kind}/${status}`;
}

import { TextAttributes } from "@opentui/core";
import type { JSX } from "solid-js";
import { COLORS } from "../lib/theme";

export function RouteOverlay(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <box
      position="absolute"
      top={2}
      left={2}
      right={2}
      bottom={6}
      flexDirection="column"
      backgroundColor={COLORS.panelHigh}
      border
      borderColor={COLORS.cyan}
      padding={1}
      zIndex={15}
    >
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD} content={props.title} />
        <text fg={COLORS.dim} content={`  ${props.hint ?? "Esc to close"}`} />
      </box>
      <box flexGrow={1} flexDirection="column">
        {props.children}
      </box>
    </box>
  );
}

export function InspectorOverlay(props: { mode: string; lines: string[] }) {
  return (
    <box
      position="absolute"
      top={2}
      left={2}
      right={2}
      bottom={6}
      flexDirection="column"
      backgroundColor={COLORS.panel}
      border
      borderColor={COLORS.cyan}
      padding={1}
      zIndex={16}
    >
      <text
        fg={COLORS.cyan}
        attributes={TextAttributes.BOLD}
        content={`Inspector · ${props.mode}  (Esc to close, /inspector to switch mode)`}
      />
      {props.lines.length === 0 ? (
        <text fg={COLORS.dim} content="No state yet. Use /query or /inspector activity." />
      ) : (
        props.lines
          .slice(-200)
          .map((line) => <text fg={COLORS.dim} wrapMode="word" content={line} />)
      )}
    </box>
  );
}

import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import { COLORS } from "../lib/theme";
import type { InspectorMode } from "../slop/types";

export function InspectorPanel(props: { mode: InspectorMode; lines: string[] }) {
  return (
    <box width="34%" flexDirection="column" padding={1} backgroundColor={COLORS.panel}>
      <text
        fg={COLORS.cyan}
        attributes={TextAttributes.BOLD}
        content={`Inspector · ${props.mode}`}
      />
      <For each={props.lines.slice(-20)}>
        {(line) => <text fg={COLORS.dim} wrapMode="word" content={line} />}
      </For>
      <Show when={props.lines.length === 0}>
        <text fg={COLORS.dim} content="No state yet." />
      </Show>
    </box>
  );
}

export function CompactInspector(props: { mode: InspectorMode; lines: string[] }) {
  return (
    <box height={4} flexDirection="column" paddingX={1} backgroundColor={COLORS.panel}>
      <text fg={COLORS.cyan} content={`Inspector · ${props.mode}`} />
      <For each={props.lines.slice(-2)}>
        {(line) => <text fg={COLORS.dim} truncate content={line} />}
      </For>
    </box>
  );
}

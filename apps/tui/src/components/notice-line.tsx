import { For, Show } from "solid-js";

import { COLORS } from "../lib/theme";

export type Notice = {
  kind: "info" | "ok" | "warn" | "error";
  message: string;
  at?: string;
};

function colorFor(kind: Notice["kind"]): string {
  switch (kind) {
    case "ok":
      return COLORS.green;
    case "warn":
      return COLORS.yellow;
    case "error":
      return COLORS.red;
    default:
      return COLORS.cyan;
  }
}

export function NoticeLine(props: { notice: Notice; history: Notice[]; expanded: boolean }) {
  return (
    <box flexDirection="column" backgroundColor={COLORS.panel}>
      <box height={1} paddingX={1}>
        <text fg={colorFor(props.notice.kind)} truncate content={props.notice.message} />
        <text fg={COLORS.dim} content={props.expanded ? " · ?=hide" : " · ?=expand"} />
      </box>
      <Show when={props.expanded}>
        <box height={6} flexDirection="column" paddingX={1} backgroundColor={COLORS.panelHigh}>
          <For each={props.history.slice(-20)}>
            {(entry) => (
              <text
                fg={colorFor(entry.kind)}
                truncate
                content={`${entry.at ? `${entry.at} ` : ""}${entry.message}`}
              />
            )}
          </For>
          <Show when={props.history.length === 0}>
            <text fg={COLORS.dim} content="No notices yet." />
          </Show>
        </box>
      </Show>
    </box>
  );
}

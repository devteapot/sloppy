import { For, Show } from "solid-js";
import { COLORS } from "../lib/theme";
import type { QueuedItem } from "../slop/types";

export function QueuePreview(props: { items: QueuedItem[] }) {
  return (
    <Show when={props.items.length > 0}>
      <box
        height={Math.min(4, props.items.length + 1)}
        flexDirection="column"
        paddingX={1}
        backgroundColor={COLORS.panel}
      >
        <text
          fg={COLORS.cyan}
          content={`Queued (${props.items.length}) — /queue-cancel <id|position> to remove`}
        />
        <For each={props.items.slice(0, 3)}>
          {(item) => (
            <text
              fg={COLORS.dim}
              truncate
              content={`  ${item.position}. ${item.summary || item.text}`}
            />
          )}
        </For>
      </box>
    </Show>
  );
}

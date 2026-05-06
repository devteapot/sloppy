import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { formatAppLine } from "../lib/format";
import { COLORS } from "../lib/theme";
import type { AppItem } from "../slop/types";

export function AppsRoute(props: {
  apps: AppItem[];
  composerDraft: string;
  onInspectApp: (app: AppItem) => void;
}) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const visible = createMemo(() => props.apps);

  useKeyboard((key) => {
    if (props.composerDraft.trim().length > 0) {
      return;
    }
    const items = visible();
    if (items.length === 0) {
      return;
    }

    if (key.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      const current = items[Math.min(selectedIndex(), items.length - 1)];
      if (current?.status === "connected") {
        props.onInspectApp(current);
      }
    }
  });

  return (
    <scrollbox flexGrow={1} padding={1} backgroundColor={COLORS.base}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="External Apps" />
      <text
        fg={COLORS.dim}
        content="↑/↓ select · Enter inspects the selected connected app · /query app-id:/ 2"
      />
      <For each={visible()}>
        {(app, index) => {
          const isSelected = () => index() === selectedIndex();
          return (
            <box
              flexDirection="column"
              padding={1}
              marginTop={1}
              backgroundColor={isSelected() ? COLORS.panelHigh : COLORS.panel}
            >
              <text
                fg={app.status === "connected" ? COLORS.green : COLORS.yellow}
                content={`${isSelected() ? "▸ " : "  "}${formatAppLine(app)}`}
              />
              <Show when={app.lastError}>
                <text fg={COLORS.red} wrapMode="word" content={app.lastError} />
              </Show>
            </box>
          );
        }}
      </For>
      <Show when={visible().length === 0}>
        <text fg={COLORS.dim} content="No external providers attached." />
      </Show>
    </scrollbox>
  );
}

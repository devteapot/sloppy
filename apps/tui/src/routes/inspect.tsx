import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { formatStateTreeLines } from "../components/state-tree";
import { copyToClipboard } from "../lib/osc52";
import { COLORS, label } from "../lib/theme";
import type { SessionViewSnapshot } from "../slop/types";

export function InspectRoute(props: {
  snapshot: SessionViewSnapshot;
  composerDraft: string;
  onCopyResult: (result: "copied" | "unsupported" | "error", text: string) => void;
}) {
  const renderer = useRenderer();
  const inspect = props.snapshot.inspect;
  const lines = createMemo(() => formatStateTreeLines(inspect.tree));
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  useKeyboard((key) => {
    if (props.composerDraft.trim().length > 0) {
      return;
    }
    const items = lines();
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
    if (key.name === "y") {
      const text = items[Math.min(selectedIndex(), items.length - 1)];
      if (text) {
        const result = copyToClipboard(renderer, text.trimStart());
        props.onCopyResult(result, text.trimStart());
      }
    }
  });
  return (
    <scrollbox flexGrow={1} padding={1} backgroundColor={COLORS.base}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="SLOP Inspector" />
      <text fg={COLORS.dim} attributes={TextAttributes.DIM} content={label("inspect")} />
      <text
        fg={COLORS.dim}
        wrapMode="word"
        content="↑/↓ select line · y yanks via OSC 52 · /query /path depth --window 0:20 --max-nodes 100 · /invoke app-id:/path action {json}"
      />
      <text
        fg={COLORS.cyan}
        content={`target=${inspect.targetId} (${inspect.targetName}) path=${inspect.path} depth=${inspect.depth}${inspect.window ? ` window=${inspect.window.join(":")}` : ""}${inspect.maxNodes ? ` max=${inspect.maxNodes}` : ""}`}
      />
      <Show when={inspect.targetTransport}>
        <text fg={COLORS.dim} content={inspect.targetTransport} />
      </Show>
      <Show when={inspect.error}>
        <text fg={COLORS.red} content={inspect.error} />
      </Show>
      <For each={lines()}>
        {(line, index) => {
          const isSelected = () => index() === selectedIndex();
          return (
            <text
              fg={isSelected() ? COLORS.green : line.startsWith("/") ? COLORS.cyan : COLORS.text}
              bg={isSelected() ? COLORS.panelHigh : COLORS.base}
              content={`${isSelected() ? "▸ " : "  "}${line}`}
            />
          );
        }}
      </For>
      <Show when={inspect.result}>
        {(result) => (
          <box flexDirection="column" marginTop={1} padding={1} backgroundColor={COLORS.panel}>
            <text
              fg={result().status === "error" ? COLORS.red : COLORS.green}
              content={`result: ${result().status}`}
            />
            <text
              fg={COLORS.dim}
              wrapMode="word"
              content={JSON.stringify(result().data ?? result().error ?? {}, null, 2)}
            />
          </box>
        )}
      </Show>
    </scrollbox>
  );
}

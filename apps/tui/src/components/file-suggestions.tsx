import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";

import { COLORS } from "../lib/theme";
import type { FileSuggestion } from "../state/file-catalog";
import { highlightSegments } from "./slash-suggestions";

export function FileSuggestions(props: {
  suggestions: FileSuggestion[];
  selectedIndex: number;
  query: string;
}) {
  return (
    <Show when={props.suggestions.length > 0}>
      <box
        flexDirection="column"
        flexShrink={0}
        paddingX={1}
        backgroundColor={COLORS.panel}
        borderColor={COLORS.cyan}
      >
        <For each={props.suggestions}>
          {(suggestion, index) => {
            const isSelected = () => index() === props.selectedIndex;
            const baseFg = () => (isSelected() ? COLORS.green : COLORS.cyan);
            const segments = () =>
              highlightSegments(suggestion.path, props.query, baseFg(), COLORS.yellow);
            return (
              <box
                flexDirection="row"
                backgroundColor={isSelected() ? COLORS.panelHigh : COLORS.panel}
              >
                <text
                  fg={baseFg()}
                  attributes={isSelected() ? TextAttributes.BOLD : TextAttributes.NONE}
                  content={`${isSelected() ? "▸ " : "  "}@`}
                />
                <For each={segments()}>
                  {(seg) => (
                    <text
                      fg={seg.fg}
                      attributes={
                        seg.match
                          ? TextAttributes.BOLD | TextAttributes.UNDERLINE
                          : isSelected()
                            ? TextAttributes.BOLD
                            : TextAttributes.NONE
                      }
                      content={seg.text}
                    />
                  )}
                </For>
              </box>
            );
          }}
        </For>
        <text fg={COLORS.dim} content="  Tab insert · Esc dismiss" />
      </box>
    </Show>
  );
}

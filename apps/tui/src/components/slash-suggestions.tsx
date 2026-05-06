import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";

import { COLORS } from "../lib/theme";
import type { SlashSuggestion } from "../state/slash-catalog";

export function SlashSuggestions(props: {
  suggestions: SlashSuggestion[];
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
              highlightSegments(suggestion.insertion, props.query, baseFg(), COLORS.yellow);
            return (
              <box
                flexDirection="row"
                backgroundColor={isSelected() ? COLORS.panelHigh : COLORS.panel}
              >
                <text
                  fg={baseFg()}
                  attributes={isSelected() ? TextAttributes.BOLD : TextAttributes.NONE}
                  content={`${isSelected() ? "▸ " : "  "}/`}
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
                <Show when={suggestion.entry.signature}>
                  <text
                    fg={baseFg()}
                    attributes={isSelected() ? TextAttributes.BOLD : TextAttributes.NONE}
                    content={` ${suggestion.entry.signature}`}
                  />
                </Show>
                <text fg={COLORS.dim} content={`  ${suggestion.entry.description}`} />
              </box>
            );
          }}
        </For>
        <text fg={COLORS.dim} content="  Tab insert · Enter run · Esc dismiss" />
      </box>
    </Show>
  );
}

type Segment = { text: string; match: boolean; fg: string };

// Splits `text` into match/non-match segments for the highlighted needle.
// Case-insensitive single-occurrence highlight (first hit). When the
// needle is empty or absent, returns one plain segment.
export function highlightSegments(
  text: string,
  needle: string,
  baseFg: string,
  matchFg: string,
): Segment[] {
  if (!needle) return [{ text, match: false, fg: baseFg }];
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return [{ text, match: false, fg: baseFg }];
  const out: Segment[] = [];
  if (idx > 0) out.push({ text: text.slice(0, idx), match: false, fg: baseFg });
  out.push({ text: text.slice(idx, idx + needle.length), match: true, fg: matchFg });
  if (idx + needle.length < text.length) {
    out.push({ text: text.slice(idx + needle.length), match: false, fg: baseFg });
  }
  return out;
}

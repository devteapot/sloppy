import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import { isControlKey } from "../lib/format";
import { COLORS } from "../lib/theme";
import type { PaletteCommand } from "../state/command-palette";

const MAX_VISIBLE_COMMANDS = 10;

function matches(entry: PaletteCommand, query: string): boolean {
  const haystack = [entry.label, entry.description, entry.shortcut, entry.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part));
}

export function CommandPalette(props: {
  entries: PaletteCommand[];
  onRun: (entry: PaletteCommand) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const filtered = createMemo(() => {
    const text = query().trim();
    const entries = text ? props.entries.filter((entry) => matches(entry, text)) : props.entries;
    return entries.slice(0, MAX_VISIBLE_COMMANDS);
  });

  createEffect(() => {
    query();
    setSelectedIndex(0);
  });

  useKeyboard((key) => {
    key.preventDefault();
    key.stopPropagation();

    if (key.name === "escape" || isControlKey(key, "k", 11)) {
      props.onClose();
      return;
    }

    if (key.name === "up") {
      setSelectedIndex((index) =>
        filtered().length === 0 ? 0 : (index - 1 + filtered().length) % filtered().length,
      );
      return;
    }

    if (key.name === "down") {
      setSelectedIndex((index) => (filtered().length === 0 ? 0 : (index + 1) % filtered().length));
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      const selected = filtered()[selectedIndex()];
      if (selected) {
        props.onRun(selected);
      }
      return;
    }

    if (key.name === "backspace") {
      setQuery((text) => text.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) {
      const char = key.sequence;
      if (char >= " " && char !== "\u007f") {
        setQuery((text) => `${text}${char}`);
      }
    }
  });

  return (
    <box
      position="absolute"
      top={3}
      left={4}
      right={4}
      flexDirection="column"
      backgroundColor={COLORS.panelHigh}
      border
      borderColor={COLORS.green}
      padding={1}
      zIndex={30}
    >
      <box height={1} flexDirection="row">
        <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Command" />
        <text fg={COLORS.dim} content="  Esc/Ctrl+K close · Enter run" />
      </box>
      <text fg={COLORS.text} content={`> ${query()}`} />
      <box marginTop={1} flexDirection="column">
        <Show
          when={filtered().length > 0}
          fallback={<text fg={COLORS.dim} content="  No commands match." />}
        >
          <For each={filtered()}>
            {(entry, index) => {
              const selected = () => index() === selectedIndex();
              const shortcut = () => (entry.shortcut ? ` ${entry.shortcut}` : "");
              return (
                <text
                  fg={selected() ? COLORS.base : COLORS.text}
                  bg={selected() ? COLORS.green : COLORS.panelHigh}
                  attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                  truncate
                  content={`${selected() ? ">" : " "} ${entry.label}${shortcut()} · ${entry.description}`}
                />
              );
            }}
          </For>
        </Show>
      </box>
    </box>
  );
}

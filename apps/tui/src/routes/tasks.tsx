import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { formatTaskLine } from "../lib/format";
import { COLORS } from "../lib/theme";
import type { TaskItem } from "../slop/types";

export function TasksRoute(props: {
  tasks: TaskItem[];
  composerDraft: string;
  onCancelTask: (id: string) => void;
}) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const visible = createMemo(() => props.tasks);

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

    if (key.name === "x") {
      const current = items[Math.min(selectedIndex(), items.length - 1)];
      if (current?.canCancel) {
        props.onCancelTask(current.id);
      }
    }
  });

  return (
    <scrollbox flexGrow={1} padding={1} backgroundColor={COLORS.base}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Tasks" />
      <text fg={COLORS.dim} content="↑/↓ select · x cancels the selected task." />
      <For each={visible()}>
        {(task, index) => {
          const isSelected = () => index() === selectedIndex();
          return (
            <box
              flexDirection="column"
              padding={1}
              marginTop={1}
              backgroundColor={isSelected() ? COLORS.panelHigh : COLORS.panel}
            >
              <text
                fg={task.status === "running" ? COLORS.cyan : COLORS.dim}
                content={`${isSelected() ? "▸ " : "  "}${formatTaskLine(task)}`}
              />
              <Show when={task.error}>
                <text fg={COLORS.red} content={task.error} />
              </Show>
            </box>
          );
        }}
      </For>
      <Show when={visible().length === 0}>
        <text fg={COLORS.dim} content="No tasks." />
      </Show>
    </scrollbox>
  );
}

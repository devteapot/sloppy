import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { COLORS } from "../lib/theme";
import type { ApprovalItem } from "../slop/types";

export function ApprovalsRoute(props: {
  approvals: ApprovalItem[];
  composerDraft: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDangerousNeedsConfirm: (approval: ApprovalItem) => void;
}) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const visible = createMemo(() => {
    // Pending first (so the list reads well), then resolved.
    const pending = props.approvals.filter((a) => a.status === "pending");
    const others = props.approvals.filter((a) => a.status !== "pending");
    return [...pending, ...others];
  });

  useKeyboard((key) => {
    // Don't intercept while user is composing text.
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

    const current = items[Math.min(selectedIndex(), items.length - 1)];
    if (!current || current.status !== "pending") {
      return;
    }

    if (key.name === "a" || key.name === "o" || key.name === "return" || key.name === "enter") {
      if (current.dangerous && !key.shift) {
        props.onDangerousNeedsConfirm(current);
        return;
      }
      props.onApprove(current.id);
      return;
    }
    if (key.name === "d" || key.name === "escape") {
      props.onReject(current.id);
      return;
    }
  });

  return (
    <scrollbox flexGrow={1} padding={1} backgroundColor={COLORS.base}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Approvals" />
      <text
        fg={COLORS.dim}
        content="↑/↓ select · Enter or a/o approve · d/Esc reject · Shift+a confirms a dangerous action"
      />
      <For each={visible()}>
        {(approval, index) => {
          const isSelected = () => index() === selectedIndex();
          return (
            <box
              flexDirection="column"
              padding={1}
              marginTop={1}
              backgroundColor={isSelected() ? COLORS.panelHigh : COLORS.panel}
            >
              <text
                fg={
                  approval.status === "pending"
                    ? approval.dangerous
                      ? COLORS.red
                      : COLORS.yellow
                    : COLORS.dim
                }
                attributes={
                  approval.status === "pending" ? TextAttributes.BOLD : TextAttributes.NONE
                }
                content={`${isSelected() ? "▸ " : "  "}${approval.status} · ${approval.provider}.${approval.action} ${approval.path}${approval.dangerous ? "  ▲ DANGER" : ""}`}
              />
              <text fg={COLORS.text} wrapMode="word" content={approval.reason} />
              <Show when={approval.paramsPreview}>
                <text fg={COLORS.dim} wrapMode="word" content={approval.paramsPreview} />
              </Show>
            </box>
          );
        }}
      </For>
      <Show when={visible().length === 0}>
        <text fg={COLORS.dim} content="No approvals." />
      </Show>
    </scrollbox>
  );
}

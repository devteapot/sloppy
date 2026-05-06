import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { COLORS } from "../lib/theme";
import type { ApprovalItem } from "../slop/types";

// Presentational only. Approval key dispatch lives in App's single global
// useKeyboard handler so propagation order can't drop hotkeys.
export function PendingApprovalPrompt(props: { approval: ApprovalItem }) {
  return (
    <box
      position="absolute"
      top="40%"
      left="15%"
      width="70%"
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      backgroundColor={COLORS.panelHigh}
      border
      borderColor={props.approval.dangerous ? COLORS.red : COLORS.ghostBorder}
      zIndex={15}
    >
      <text
        fg={props.approval.dangerous ? COLORS.red : COLORS.yellow}
        attributes={TextAttributes.BOLD}
        content={`Approve ${props.approval.provider}.${props.approval.action} at ${props.approval.path}?`}
      />
      <text fg={COLORS.text} wrapMode="word" content={props.approval.reason} />
      <Show when={props.approval.paramsPreview}>
        <text fg={COLORS.dim} wrapMode="word" content={props.approval.paramsPreview} />
      </Show>
      <text
        fg={COLORS.cyan}
        content={
          props.approval.dangerous
            ? "[Shift+o/Shift+a] approve once · [d/esc] deny · DANGEROUS"
            : "[o/a] approve once · [d/esc] deny"
        }
      />
    </box>
  );
}

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { COLORS } from "../lib/theme";
import type { PluginItem } from "../slop/types";
import { buildSlashEntries } from "../state/slash-catalog";

const HOTKEYS: Array<{ key: string; description: string }> = [
  { key: "Ctrl+K", description: "Open command palette (primary nav)" },
  { key: "Shift+Tab", description: "Cycle mode: default → auto-approve → plan" },
  { key: "Esc", description: "Close topmost overlay (palette · help · route · inspector)" },
  { key: "Ctrl+C", description: "Cancel turn · clear draft · or exit" },
  { key: "Ctrl+D", description: "Exit when idle" },
  { key: "↑ / ↓", description: "Navigate composer history (when draft empty)" },
  { key: "Enter", description: "Submit composer · activate selected list row" },
  { key: "Alt+Enter", description: "Newline in composer" },
  { key: "?", description: "Toggle notice drawer" },
  { key: "a / o", description: "Approve pending approval (Shift+A for dangerous)" },
  { key: "d / Esc", description: "Reject pending approval" },
];

export function HelpOverlay(props: { plugins?: PluginItem[]; onClose: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "?") {
      props.onClose();
    }
  });

  return (
    <box
      position="absolute"
      top={2}
      left={2}
      right={2}
      bottom={2}
      flexDirection="column"
      backgroundColor={COLORS.panelHigh}
      border
      borderColor={COLORS.ghostBorder}
      padding={1}
      zIndex={20}
    >
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Sloppy TUI · Help" />
      <text fg={COLORS.dim} content="Press Esc or ? to close." />
      <box marginTop={1} flexDirection="column">
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD} content="Hotkeys" />
        {HOTKEYS.map((entry) => (
          <text fg={COLORS.text} content={`  ${entry.key.padEnd(16)} ${entry.description}`} />
        ))}
      </box>
      <box marginTop={1} flexDirection="column">
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD} content="Slash commands" />
        {buildSlashEntries(props.plugins ?? []).map((entry) => (
          <text
            fg={COLORS.text}
            wrapMode="word"
            content={`  /${entry.name}${entry.signature ? ` ${entry.signature}` : ""} — ${entry.description}`}
          />
        ))}
      </box>
    </box>
  );
}

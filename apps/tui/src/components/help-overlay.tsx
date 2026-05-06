import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { COLORS } from "../lib/theme";

const HOTKEYS: Array<{ key: string; description: string }> = [
  { key: "F1", description: "Toggle this help / focus chat" },
  { key: "F2 – F6", description: "Setup · Approvals · Tasks · Apps · Inspect" },
  { key: "F7", description: "Toggle mouse mode" },
  { key: "Ctrl+C", description: "Cancel turn · clear draft · or exit" },
  { key: "↑ / ↓", description: "Navigate selected route list (when composer empty)" },
  { key: "Enter", description: "Submit composer · activate selected list row" },
  { key: "Alt+Enter", description: "Newline in composer" },
  { key: "?", description: "Toggle notice drawer" },
  { key: "a / o", description: "Approve selected pending approval (Shift for dangerous)" },
  { key: "d / Esc", description: "Reject selected pending approval" },
  { key: "x", description: "Cancel selected task" },
  { key: "d / Shift+D", description: "Setup: queue then confirm profile delete" },
  { key: "k / Shift+K", description: "Setup: queue then confirm API key delete" },
];

const COMMANDS: Array<{ name: string; description: string }> = [
  { name: "/help", description: "Open this overlay" },
  { name: "/setup /approvals /tasks /apps /inspect /settings", description: "Switch route" },
  { name: "/queue-cancel <id|position>", description: "Cancel a runtime-queued submitted message" },
  { name: "/mouse [on|off|toggle]", description: "Mouse reporting (or F7)" },
  {
    name: "/profile <provider> [model] [--reasoning-effort high] [--adapter id] [--base-url url]",
    description: "Save a profile (no key — API keys must use /profile-secret, masked)",
  },
  {
    name: "/profile-secret <provider> [model] [--reasoning-effort high]",
    description: "Save profile with masked API-key entry",
  },
  { name: "/default <id>", description: "Set default profile" },
  { name: "/delete-profile <id>", description: "Delete profile" },
  { name: "/delete-key <id>", description: "Delete stored API key" },
  {
    name: "/query [app-id:]path depth [--window 0:N] [--max-nodes N]",
    description: "Inspect a state path",
  },
  { name: "/invoke [app-id:]path action {json}", description: "Invoke an affordance" },
  {
    name: "/inspector [activity|approvals|tasks|apps|state]",
    description: "Switch inspector pane",
  },
  { name: "/quit", description: "Exit the TUI" },
];

export function HelpOverlay(props: { onClose: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "f1" || key.sequence === "?") {
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
      <text fg={COLORS.dim} content="Press Esc, F1, or ? to close." />
      <box marginTop={1} flexDirection="column">
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD} content="Hotkeys" />
        {HOTKEYS.map((entry) => (
          <text fg={COLORS.text} content={`  ${entry.key.padEnd(16)} ${entry.description}`} />
        ))}
      </box>
      <box marginTop={1} flexDirection="column">
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD} content="Slash commands" />
        {COMMANDS.map((entry) => (
          <text
            fg={COLORS.text}
            wrapMode="word"
            content={`  ${entry.name} — ${entry.description}`}
          />
        ))}
      </box>
    </box>
  );
}

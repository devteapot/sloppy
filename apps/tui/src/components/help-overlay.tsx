import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { COLORS } from "../lib/theme";

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

const COMMANDS: Array<{ name: string; description: string }> = [
  { name: "/help", description: "Open this overlay" },
  {
    name: "/setup /approvals /tasks /apps /runtime /inspect /settings",
    description: "Open route as overlay",
  },
  {
    name: "/goal [objective|pause|resume|complete|clear] [--token-budget N]",
    description: "Start or control a persistent runtime goal",
  },
  { name: "/queue-cancel <id|position>", description: "Cancel a runtime-queued submitted message" },
  {
    name: "/session-new [--workspace-id id] [--project-id id]",
    description: "Start a scoped session through the supervisor",
  },
  { name: "/session-switch <id>", description: "Switch to another supervised session" },
  { name: "/session-stop <id>", description: "Stop a supervised session" },
  { name: "/mouse [on|off|toggle]", description: "Mouse reporting" },
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
    description: "Inspect a state path (opens inspector overlay)",
  },
  { name: "/invoke [app-id:]path action {json}", description: "Invoke an affordance" },
  {
    name: "/runtime refresh|export|inspect|apply|revert [proposal-id]",
    description: "Review proposals and export a portable meta-runtime bundle",
  },
  {
    name: "/inspector [activity|approvals|tasks|apps|sessions|state]",
    description: "Open inspector overlay in selected mode",
  },
  { name: "/quit", description: "Exit the TUI" },
];

export function HelpOverlay(props: { onClose: () => void }) {
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

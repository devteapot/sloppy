// Catalog of slash commands surfaced in the autocomplete popover.
// Keep entries terse — `name` is the canonical form (no leading slash);
// `signature` shows arguments hint; `description` is one short line.

export type SlashEntry = {
  name: string;
  aliases?: string[];
  signature?: string;
  description: string;
};

export const SLASH_ENTRIES: SlashEntry[] = [
  { name: "help", description: "Show hotkeys and slash commands" },
  { name: "quit", aliases: ["q", "exit"], description: "Exit the TUI" },
  { name: "clear", aliases: ["new"], description: "Discard the queued message buffer" },

  { name: "chat", description: "Open the chat route" },
  { name: "setup", description: "Manage LLM profiles and credentials" },
  { name: "approvals", description: "Review pending approvals" },
  { name: "tasks", description: "Inspect provider tasks" },
  { name: "apps", description: "List attached external providers" },
  { name: "inspect", aliases: ["tree"], description: "Open the SLOP state inspector" },

  {
    name: "goal",
    signature: "<objective>|pause|resume|complete|clear",
    description: "Persistent session goal controls",
  },
  {
    name: "verbosity",
    aliases: ["verbose", "compact", "normal"],
    signature: "[compact|normal|verbose]",
    description: "Cycle or set chat verbosity",
  },
  {
    name: "mouse",
    signature: "[on|off|toggle]",
    description: "Toggle mouse capture inside the TUI",
  },

  {
    name: "query",
    signature: "[app-id:]path depth [--window a:b] [--max-nodes n]",
    description: "Query a SLOP state tree into the inspector",
  },
  {
    name: "invoke",
    signature: "[app-id:]path action {json}",
    description: "Invoke an affordance on a SLOP node",
  },

  {
    name: "profile",
    signature: "<provider> <model> [--reasoning-effort high]",
    description: "Save an LLM profile (env-keyed)",
  },
  {
    name: "profile-secret",
    aliases: ["secret-profile"],
    signature: "<provider> <model>",
    description: "Save an LLM profile with masked API key entry",
  },

  {
    name: "queue-cancel",
    signature: "<id|position>",
    description: "Cancel a queued user message",
  },

  {
    name: "session-new",
    aliases: ["new-session"],
    signature: "--workspace-id <id> --project-id <id>",
    description: "Create a new supervised session",
  },
  {
    name: "session-switch",
    aliases: ["switch-session"],
    signature: "<session-id>",
    description: "Switch the TUI to another supervised session",
  },
  {
    name: "session-stop",
    aliases: ["stop-session"],
    signature: "<session-id>",
    description: "Stop a supervised session",
  },
];

export type SlashSuggestion = {
  entry: SlashEntry;
  // The canonical form to insert — `name` for primary, alias name otherwise.
  insertion: string;
};

// Match draft like "/qu" against entries. Prefix match on names + aliases,
// then fuzzy-substring for everything else, capped at `limit`.
export function matchSlashEntries(input: string, limit = 8): SlashSuggestion[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];
  const head = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (head.length === 0) {
    return SLASH_ENTRIES.slice(0, limit).map((entry) => ({ entry, insertion: entry.name }));
  }

  const seen = new Set<string>();
  const exact: SlashSuggestion[] = [];
  const prefix: SlashSuggestion[] = [];
  const fuzzy: SlashSuggestion[] = [];
  for (const entry of SLASH_ENTRIES) {
    const candidates = [entry.name, ...(entry.aliases ?? [])];
    for (const candidate of candidates) {
      if (seen.has(entry.name)) continue;
      if (candidate === head) {
        exact.push({ entry, insertion: candidate });
        seen.add(entry.name);
        break;
      }
      if (candidate.startsWith(head)) {
        prefix.push({ entry, insertion: candidate });
        seen.add(entry.name);
        break;
      }
      if (candidate.includes(head)) {
        fuzzy.push({ entry, insertion: candidate });
        seen.add(entry.name);
        break;
      }
    }
  }
  return [...exact, ...prefix, ...fuzzy].slice(0, limit);
}

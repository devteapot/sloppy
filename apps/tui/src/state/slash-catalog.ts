import type { PluginItem } from "../backend/slop-types";

// Catalog of built-in slash commands surfaced in the autocomplete popover.
// Keep entries terse — `name` is the canonical form (no leading slash);
// `signature` shows arguments hint; `description` is one short line.

export type SlashEntry = {
  name: string;
  aliases?: string[];
  signature?: string;
  description: string;
};

export type SlashCatalogOptions = {
  actionsByPath?: Record<string, string[]>;
};

export const BUILTIN_SLASH_ENTRIES: SlashEntry[] = [
  { name: "help", description: "Show hotkeys and slash commands" },
  { name: "quit", aliases: ["q", "exit"], description: "Exit the TUI" },
  { name: "clear", aliases: ["new"], description: "Discard the queued message buffer" },

  { name: "chat", description: "Open the chat route" },
  { name: "setup", description: "Manage LLM profiles and credentials" },
  { name: "approvals", description: "Review pending approvals" },
  { name: "tasks", description: "Inspect provider tasks" },
  { name: "apps", description: "List attached external providers" },
  { name: "inspect", aliases: ["tree"], description: "Open the SLOP state inspector" },
  { name: "runtime", description: "Open runtime status and supervised sessions" },

  {
    name: "verbosity",
    signature: "[compact|verbose]",
    description: "Show or set chat verbosity",
  },
  {
    name: "approval",
    aliases: ["approval-mode"],
    signature: "[normal|auto]",
    description: "Show or set the local approval posture",
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
    signature: "<provider> <model> [--reasoning-effort high] [--thinking-display hidden]",
    description: "Save an LLM profile (env-keyed)",
  },
  {
    name: "profile-secret",
    aliases: ["secret-profile"],
    signature: "<provider> <model>",
    description: "Deferred: masked profile entry is not available in the inline TUI",
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

export function buildSlashEntries(
  plugins: PluginItem[] = [],
  options: SlashCatalogOptions = {},
): SlashEntry[] {
  const seenPluginNames = new Set<string>();
  const pluginEntries = plugins.flatMap((plugin) =>
    (plugin.ui.actions ?? []).flatMap((action): SlashEntry[] => {
      const tui = action.presentation?.tui;
      const slash =
        tui && typeof tui === "object" && !Array.isArray(tui)
          ? (tui as Record<string, unknown>).slash
          : undefined;
      if (!slash || typeof slash !== "object" || Array.isArray(slash)) {
        return [];
      }
      const slashRecord = slash as Record<string, unknown>;
      const name = slashRecord.name;
      const aliases = Array.isArray(slashRecord.aliases)
        ? slashRecord.aliases.filter((alias): alias is string => typeof alias === "string")
        : undefined;
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        !validPluginSlashNamespace(plugin.id) ||
        !slashActionAvailable(
          options,
          action.invoke.path,
          action.whenAvailable ?? action.invoke.action,
        )
      ) {
        return [];
      }

      const qualifiedName = qualifyPluginSlashName(plugin.id, name);
      const qualifiedAliases = aliases?.map((alias) => qualifyPluginSlashName(plugin.id, alias));
      const candidateNames = [qualifiedName, ...(qualifiedAliases ?? [])].map((candidate) =>
        candidate.toLowerCase(),
      );
      if (candidateNames.some((candidate) => seenPluginNames.has(candidate))) {
        return [];
      }
      for (const candidate of candidateNames) {
        seenPluginNames.add(candidate);
      }

      return [
        {
          name: qualifiedName,
          aliases: qualifiedAliases,
          signature: typeof slashRecord.signature === "string" ? slashRecord.signature : undefined,
          description: action.description,
        },
      ];
    }),
  );
  return [...BUILTIN_SLASH_ENTRIES, ...pluginEntries];
}

function qualifyPluginSlashName(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

function validPluginSlashNamespace(pluginId: string): boolean {
  return pluginId.length > 0 && !/[\s:]/.test(pluginId);
}

function slashActionAvailable(options: SlashCatalogOptions, path: string, action: string): boolean {
  return !options.actionsByPath || (options.actionsByPath[path] ?? []).includes(action);
}

export type SlashSuggestion = {
  entry: SlashEntry;
  // The canonical form to insert.
  insertion: string;
  matched: string;
};

// Match draft like "/qu" against entries. Prefix match on names + aliases,
// then substring/ordered-character partial matches, capped at `limit`.
export function matchSlashEntries(
  input: string,
  limit = 8,
  plugins: PluginItem[] = [],
  options: SlashCatalogOptions = {},
): SlashSuggestion[] {
  return matchSlashEntryList(input, buildSlashEntries(plugins, options), limit);
}

export function matchSlashEntryList(
  input: string,
  entries: SlashEntry[] = BUILTIN_SLASH_ENTRIES,
  limit = 8,
): SlashSuggestion[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];
  const head = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (head.length === 0)
    return entries
      .slice(0, limit)
      .map((entry) => ({ entry, insertion: entry.name, matched: entry.name }));

  const seen = new Set<string>();
  const exact: SlashSuggestion[] = [];
  const prefix: SlashSuggestion[] = [];
  const fuzzy: SlashSuggestion[] = [];
  for (const entry of entries) {
    const candidates = [entry.name, ...(entry.aliases ?? [])];
    for (const candidate of candidates) {
      if (seen.has(entry.name)) continue;
      const normalizedCandidate = candidate.toLowerCase();
      if (normalizedCandidate === head) {
        exact.push({ entry, insertion: entry.name, matched: candidate });
        seen.add(entry.name);
        break;
      }
      if (normalizedCandidate.startsWith(head)) {
        prefix.push({ entry, insertion: entry.name, matched: candidate });
        seen.add(entry.name);
        break;
      }
      if (normalizedCandidate.includes(head) || isOrderedPartialMatch(head, normalizedCandidate)) {
        fuzzy.push({ entry, insertion: entry.name, matched: candidate });
        seen.add(entry.name);
        break;
      }
    }
  }
  return [...exact, ...prefix, ...fuzzy].slice(0, limit);
}

function isOrderedPartialMatch(query: string, candidate: string): boolean {
  let queryIndex = 0;
  for (const char of candidate) {
    if (char === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === query.length) {
        return true;
      }
    }
  }
  return query.length === 0;
}

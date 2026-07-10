import type { PluginItem } from "../backend/slop-types";
import { readActionSlash } from "./action-slash";
import { BUILTIN_COMMAND_SPECS } from "./builtin-commands";

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

export const BUILTIN_SLASH_ENTRIES: SlashEntry[] = BUILTIN_COMMAND_SPECS.filter(
  (spec) => spec.discoverable !== false,
).map(({ name, aliases, signature, description }) => ({
  name,
  aliases,
  signature,
  description,
}));

export function buildSlashEntries(
  plugins: PluginItem[] = [],
  options: SlashCatalogOptions = {},
): SlashEntry[] {
  const seenPluginNames = new Set<string>();
  const pluginEntries = plugins.flatMap((plugin) =>
    (plugin.ui.actions ?? []).flatMap((action): SlashEntry[] => {
      const slash = readActionSlash(action);
      if (
        !slash ||
        !validPluginSlashNamespace(plugin.id) ||
        !slashActionAvailable(
          options,
          action.invoke.path,
          action.whenAvailable ?? action.invoke.action,
        )
      ) {
        return [];
      }

      const qualifiedName = qualifyPluginSlashName(plugin.id, slash.name);
      const qualifiedAliases = slash.aliases?.map((alias) =>
        qualifyPluginSlashName(plugin.id, alias),
      );
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
          signature: slash.signature,
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

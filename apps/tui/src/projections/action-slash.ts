import type { PluginActionContribution } from "../backend/slop-types";

export type ActionSlashPresentation = {
  name: string;
  aliases?: string[];
  signature?: string;
};

// Single source for extracting a plugin action's `.presentation.tui.slash`
// contribution; both the slash catalog and the command parser must agree on
// what counts as a valid slash presentation.
export function readActionSlash(action: PluginActionContribution): ActionSlashPresentation | null {
  const tui = action.presentation?.tui;
  const slash =
    tui && typeof tui === "object" && !Array.isArray(tui)
      ? (tui as Record<string, unknown>).slash
      : undefined;
  if (!slash || typeof slash !== "object" || Array.isArray(slash)) {
    return null;
  }

  const slashRecord = slash as Record<string, unknown>;
  const name = slashRecord.name;
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }

  return {
    name,
    aliases: Array.isArray(slashRecord.aliases)
      ? slashRecord.aliases.filter((alias): alias is string => typeof alias === "string")
      : undefined,
    signature: typeof slashRecord.signature === "string" ? slashRecord.signature : undefined,
  };
}

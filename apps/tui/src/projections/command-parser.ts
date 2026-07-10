import type { SessionViewSnapshot } from "../backend/slop-types";
import { readActionSlash } from "./action-slash";
import { parseBuiltinCommand } from "./builtin-commands";
import type { LocalCommand } from "./command-types";

export function parsePluginSlashCommand(
  input: string,
  snapshot: Pick<SessionViewSnapshot, "plugins" | "actionsByPath">,
): LocalCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawName = "", ...args] = trimmed.slice(1).split(/\s+/);
  const parsedName = parsePluginSlashName(rawName);
  if (!parsedName) {
    return null;
  }

  for (const plugin of snapshot.plugins) {
    if (plugin.id.toLowerCase() !== parsedName.pluginId) {
      continue;
    }
    for (const action of plugin.ui.actions ?? []) {
      const slash = readActionSlash(action);
      if (!slash) {
        continue;
      }

      const names = [slash.name, ...(slash.aliases ?? [])].map((candidate) =>
        candidate.toLowerCase(),
      );
      if (!names.includes(parsedName.command)) {
        continue;
      }

      const requiredAction = action.whenAvailable ?? action.invoke.action;
      if (!(snapshot.actionsByPath[action.invoke.path] ?? []).includes(requiredAction)) {
        return {
          type: "rejected",
          reason: `/${plugin.id}:${slash.name} is not available right now.`,
        };
      }

      const argumentText = args.join(" ").trim();
      const params = { ...(action.invoke.params ?? {}) };
      if (action.argument) {
        if (!argumentText && action.argument.required) {
          const signature = slash.signature ? ` ${slash.signature}` : "";
          return { type: "rejected", reason: `Usage: /${plugin.id}:${slash.name}${signature}` };
        }
        if (argumentText) {
          params[action.argument.param ?? action.argument.name] = argumentText;
        }
      } else if (argumentText) {
        return { type: "rejected", reason: `Usage: /${plugin.id}:${slash.name}` };
      }

      return {
        type: "plugin_action",
        pluginId: plugin.id,
        actionId: action.id,
        label: action.label,
        path: action.invoke.path,
        action: action.invoke.action,
        params: Object.keys(params).length > 0 ? params : undefined,
      };
    }
  }

  return null;
}

export function parseLocalCommand(input: string): LocalCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawName = "", ...args] = trimmed.slice(1).split(/\s+/);
  return parseBuiltinCommand(rawName, args, trimmed) ?? { type: "unknown", name: trimmed };
}

type ParsedPluginSlashName = {
  pluginId: string;
  command: string;
};

function parsePluginSlashName(rawName: string): ParsedPluginSlashName | null {
  const separator = rawName.indexOf(":");
  if (separator <= 0 || separator === rawName.length - 1) {
    return null;
  }
  return {
    pluginId: rawName.slice(0, separator).toLowerCase(),
    command: rawName.slice(separator + 1).toLowerCase(),
  };
}

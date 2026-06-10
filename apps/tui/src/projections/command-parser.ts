import type { SessionViewSnapshot, TuiRoute } from "../backend/slop-types";
import { readActionSlash } from "./action-slash";
import {
  parseCommandOptions,
  parseParams,
  parsePositiveInteger,
  parseProfileKind,
  parseTargetPath,
  parseThinkingDisplay,
  parseThinkingEnabled,
  parseWindow,
} from "./command-options";
import type { LocalCommand } from "./command-types";
import { detectInlineSecret } from "./secret-detection";

const ROUTE_NAMES = new Set<TuiRoute>(["chat", "setup", "approvals", "tasks", "apps"]);

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
  const name = rawName.toLowerCase();

  if (name === "q" || name === "quit" || name === "exit") {
    return { type: "quit" };
  }

  if (name === "help") {
    return { type: "help" };
  }

  if (name === "clear" || name === "new" || name === "queue-clear" || name === "discard-queue") {
    return { type: "clear" };
  }

  if (name === "verbosity") {
    const mode = args[0]?.toLowerCase();
    if (!mode) {
      return { type: "verbosity", mode: "show" };
    }
    if (mode === "compact" || mode === "verbose") {
      return { type: "verbosity", mode };
    }
    return { type: "rejected", reason: "Usage: /verbosity [compact|verbose]" };
  }

  if (name === "approval" || name === "approval-mode") {
    const mode = args[0]?.toLowerCase();
    if (!mode) {
      return { type: "approval_mode", mode: "show" };
    }
    if (mode === "normal" || mode === "auto") {
      return { type: "approval_mode", mode };
    }
    if (mode === "toggle") {
      return { type: "approval_mode", mode: "toggle" };
    }
    return { type: "rejected", reason: "Usage: /approval [normal|auto|toggle]" };
  }

  if (name === "inspect" || name === "tree" || name === "inspector") {
    return { type: "inspect_open" };
  }

  if (name === "goal") {
    if (args.length === 0) {
      return { type: "goal", action: "show" };
    }
    const subcommand = args[0]?.toLowerCase();
    if (subcommand === "pause") {
      return { type: "goal", action: "pause", message: args.slice(1).join(" ") || undefined };
    }
    if (subcommand === "resume") {
      return { type: "goal", action: "resume", message: args.slice(1).join(" ") || undefined };
    }
    if (subcommand === "complete" || subcommand === "done") {
      return {
        type: "goal",
        action: "complete",
        message: args.slice(1).join(" ") || undefined,
      };
    }
    if (subcommand === "clear") {
      return { type: "goal", action: "clear" };
    }
    const parsed = parseCommandOptions(
      subcommand === "set" || subcommand === "create" ? args.slice(1) : args,
    );
    const objective = parsed.positionals.join(" ").trim();
    if (!objective) {
      return { type: "unknown", name: trimmed };
    }
    return {
      type: "goal",
      action: "create",
      objective,
      tokenBudget: parsePositiveInteger(
        parsed.values["token-budget"] ?? parsed.values.budget ?? parsed.values.tokens,
      ),
    };
  }

  if (name === "runtime") {
    const action = args[0]?.toLowerCase();
    if (!action) {
      return { type: "route", route: "runtime" };
    }
    if (action === "refresh" || action === "export") {
      return { type: "runtime", action };
    }
    if (action === "inspect") {
      return { type: "runtime", action, proposalId: args[1] };
    }
    if (action === "apply" || action === "revert") {
      const proposalId = args[1];
      return proposalId
        ? { type: "runtime", action, proposalId }
        : { type: "unknown", name: trimmed };
    }
    return { type: "unknown", name: trimmed };
  }

  if (ROUTE_NAMES.has(name as TuiRoute)) {
    return { type: "route", route: name as TuiRoute };
  }

  if (name === "query") {
    const parsed = parseCommandOptions(args);
    const [rawPath = "/", depthArg] = parsed.positionals;
    const targetPath = parseTargetPath(rawPath, parsed.values.target);
    return {
      type: "query",
      path: targetPath.path,
      targetId: targetPath.targetId,
      depth: Number.isFinite(Number(depthArg)) ? Number(depthArg) : 2,
      window: parseWindow(parsed.values.window),
      maxNodes: parsePositiveInteger(parsed.values["max-nodes"]),
    };
  }

  if (name === "invoke") {
    const parsed = parseCommandOptions(args);
    const [rawPath = "/", action = "", ...jsonParts] = parsed.positionals;
    if (!action) {
      return { type: "unknown", name: trimmed };
    }

    const json = jsonParts.join(" ").trim();
    const targetPath = parseTargetPath(rawPath, parsed.values.target);
    return {
      type: "invoke",
      path: targetPath.path,
      action,
      params: parseParams(json),
      targetId: targetPath.targetId,
    };
  }

  if (name === "profile") {
    const inlineSecret = detectInlineSecret(args);
    if (inlineSecret) {
      return { type: "rejected", reason: inlineSecret };
    }
    const parsed = parseCommandOptions(args);
    const [endpointId = "", model] = parsed.positionals;
    if (!endpointId) {
      return { type: "unknown", name: trimmed };
    }
    const adapterId = parsed.values.adapter ?? parsed.values["adapter-id"];

    return {
      type: "profile",
      profileId: parsed.values.id ?? parsed.values["profile-id"],
      label: parsed.values.label,
      kind: parseProfileKind(parsed.values.kind, adapterId),
      endpointId,
      model,
      reasoningEffort:
        parsed.values["reasoning-effort"] ?? parsed.values.reasoning ?? parsed.values.effort,
      thinkingEnabled: parseThinkingEnabled(parsed),
      thinkingDisplay: parseThinkingDisplay(parsed),
      adapterId,
      makeDefault: !parsed.flags.has("no-default"),
    };
  }

  if (name === "profile-secret" || name === "secret-profile") {
    const parsed = parseCommandOptions(args);
    const [endpointId = "", model] = parsed.positionals;
    if (!endpointId) {
      return { type: "unknown", name: trimmed };
    }
    const adapterId = parsed.values.adapter ?? parsed.values["adapter-id"];

    return {
      type: "profile_secret",
      profileId: parsed.values.id ?? parsed.values["profile-id"],
      label: parsed.values.label,
      kind: parseProfileKind(parsed.values.kind, adapterId),
      endpointId,
      model,
      reasoningEffort:
        parsed.values["reasoning-effort"] ?? parsed.values.reasoning ?? parsed.values.effort,
      thinkingEnabled: parseThinkingEnabled(parsed),
      thinkingDisplay: parseThinkingDisplay(parsed),
      adapterId,
      makeDefault: !parsed.flags.has("no-default"),
    };
  }

  if (name === "queue-cancel") {
    const raw = args[0];
    if (!raw) {
      return { type: "unknown", name: trimmed };
    }
    const asNumber = Number(raw);
    const isPosition = Number.isInteger(asNumber) && asNumber >= 1 && /^\d+$/.test(raw);
    return { type: "queue_cancel", target: isPosition ? asNumber : raw };
  }

  if (name === "reload-config" || name === "config-reload") {
    const target = args[0];
    if (!target || target === "session") {
      return { type: "config_reload", target: "session" };
    }
    if (target === "supervisor") {
      return { type: "config_reload", target: "supervisor" };
    }
    return { type: "unknown", name: trimmed };
  }

  if (name === "session-new" || name === "new-session") {
    const parsed = parseCommandOptions(args);
    return {
      type: "session_new",
      workspaceId: parsed.values["workspace-id"] ?? parsed.values.workspace,
      projectId: parsed.values["project-id"] ?? parsed.values.project,
      title: parsed.values.title,
      sessionId: parsed.values["session-id"] ?? parsed.values.id,
    };
  }

  if (name === "session-switch" || name === "switch-session") {
    const sessionId = args[0];
    return sessionId ? { type: "session_switch", sessionId } : { type: "unknown", name: trimmed };
  }

  if (name === "session-stop" || name === "stop-session") {
    const sessionId = args[0];
    return sessionId ? { type: "session_stop", sessionId } : { type: "unknown", name: trimmed };
  }

  return { type: "unknown", name: trimmed };
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

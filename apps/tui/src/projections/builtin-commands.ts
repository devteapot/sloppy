import type { TuiRoute } from "../backend/slop-types";
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

type CommandParser = (args: string[], input: string) => LocalCommand;

export type BuiltinPaletteCommand = {
  id: string;
  label: string;
  description?: string;
  command: LocalCommand;
  requiresSupervisor?: boolean;
};

export type BuiltinCommandSpec = {
  name: string;
  aliases?: string[];
  hiddenAliases?: string[];
  signature?: string;
  description: string;
  discoverable?: boolean;
  parse: CommandParser;
  palette?: BuiltinPaletteCommand[];
};

const routeSpec = (route: TuiRoute, description: string): BuiltinCommandSpec => ({
  name: route,
  description,
  parse: () => ({ type: "route", route }),
  palette: [
    {
      id: `route:${route}`,
      label: `Open ${route}`,
      command: { type: "route", route },
    },
  ],
});

export const BUILTIN_COMMAND_SPECS: BuiltinCommandSpec[] = [
  {
    name: "help",
    description: "Show hotkeys and slash commands",
    parse: () => ({ type: "help" }),
  },
  {
    name: "quit",
    aliases: ["q", "exit"],
    description: "Exit the TUI",
    parse: () => ({ type: "quit" }),
  },
  {
    name: "clear",
    aliases: ["new"],
    hiddenAliases: ["queue-clear", "discard-queue"],
    description: "Discard the queued message buffer",
    parse: () => ({ type: "clear" }),
  },
  routeSpec("chat", "Open the chat route"),
  routeSpec("setup", "Manage LLM profiles and credentials"),
  routeSpec("approvals", "Review pending approvals"),
  routeSpec("tasks", "Inspect provider tasks"),
  routeSpec("apps", "List attached external providers"),
  {
    name: "inspect",
    aliases: ["tree"],
    hiddenAliases: ["inspector"],
    description: "Open the SLOP state inspector",
    parse: () => ({ type: "inspect_open" }),
    palette: [
      {
        id: "route:inspect",
        label: "Open inspect",
        command: { type: "inspect_open" },
      },
    ],
  },
  {
    name: "runtime",
    signature: "[refresh|export|inspect|apply|revert] [proposal-id]",
    description: "Open runtime status and supervised sessions",
    parse: parseRuntimeCommand,
    palette: [
      {
        id: "route:runtime",
        label: "Open runtime",
        command: { type: "route", route: "runtime" },
      },
    ],
  },
  {
    name: "verbosity",
    signature: "[compact|verbose]",
    description: "Show or set chat verbosity",
    parse: parseVerbosityCommand,
  },
  {
    name: "approval",
    aliases: ["approval-mode"],
    signature: "[normal|auto|toggle]",
    description: "Show or set the session approval mode",
    parse: parseApprovalCommand,
    palette: [
      {
        id: "approval-mode:toggle",
        label: "Toggle approval mode",
        description: "Switch the session between normal and auto approvals",
        command: { type: "approval_mode", mode: "toggle" },
      },
    ],
  },
  {
    name: "goal",
    signature: "<objective>|pause|resume|complete|clear [--token-budget n]",
    description: "Manage the persistent session goal compatibility command",
    discoverable: false,
    parse: parseGoalCommand,
  },
  {
    name: "query",
    signature: "[app-id:]path depth [--window a:b] [--max-nodes n]",
    description: "Query a SLOP state tree into the inspector",
    parse: parseQueryCommand,
  },
  {
    name: "invoke",
    signature: "[app-id:]path action {json}",
    description: "Invoke an affordance on a SLOP node",
    parse: parseInvokeCommand,
  },
  {
    name: "profile",
    signature: "<provider> <model> [--reasoning-effort high] [--thinking-display hidden]",
    description: "Save an LLM profile (env-keyed)",
    parse: (args, input) => parseProfileCommand(args, input, false),
  },
  {
    name: "profile-secret",
    aliases: ["secret-profile"],
    signature: "<provider> <model>",
    description: "Deferred: masked profile entry is not available in the inline TUI",
    parse: (args, input) => parseProfileCommand(args, input, true),
  },
  {
    name: "queue-cancel",
    signature: "<id|position>",
    description: "Cancel a queued user message",
    parse: parseQueueCancelCommand,
  },
  {
    name: "reload-config",
    aliases: ["config-reload"],
    signature: "[session|supervisor]",
    description: "Reload session or supervisor config",
    parse: parseConfigReloadCommand,
    palette: [
      {
        id: "config:reload-session",
        label: "Reload session config",
        description: "Reload config for the selected session",
        command: { type: "config_reload", target: "session" },
      },
      {
        id: "config:reload-supervisor",
        label: "Reload supervisor config",
        description: "Refresh supervisor config and available scopes",
        command: { type: "config_reload", target: "supervisor" },
        requiresSupervisor: true,
      },
    ],
  },
  {
    name: "session-new",
    aliases: ["new-session"],
    signature: "--workspace-id <id> --project-id <id>",
    description: "Create a new supervised session",
    parse: parseSessionNewCommand,
  },
  {
    name: "session-switch",
    aliases: ["switch-session"],
    signature: "<session-id>",
    description: "Switch the TUI to another supervised session",
    parse: (args, input) => requiredSessionCommand("session_switch", args, input),
  },
  {
    name: "session-stop",
    aliases: ["stop-session"],
    signature: "<session-id>",
    description: "Stop a supervised session",
    parse: (args, input) => requiredSessionCommand("session_stop", args, input),
  },
];

const BUILTIN_COMMAND_BY_NAME = new Map<string, BuiltinCommandSpec>();
for (const spec of BUILTIN_COMMAND_SPECS) {
  for (const name of [spec.name, ...(spec.aliases ?? []), ...(spec.hiddenAliases ?? [])]) {
    BUILTIN_COMMAND_BY_NAME.set(name, spec);
  }
}

export function parseBuiltinCommand(
  rawName: string,
  args: string[],
  input: string,
): LocalCommand | null {
  return BUILTIN_COMMAND_BY_NAME.get(rawName.toLowerCase())?.parse(args, input) ?? null;
}

export function builtinPaletteCommands(hasSupervisor: boolean): BuiltinPaletteCommand[] {
  return BUILTIN_COMMAND_SPECS.flatMap((spec) => spec.palette ?? []).filter(
    (item) => !item.requiresSupervisor || hasSupervisor,
  );
}

function parseVerbosityCommand(args: string[]): LocalCommand {
  const mode = args[0]?.toLowerCase();
  if (!mode) {
    return { type: "verbosity", mode: "show" };
  }
  if (mode === "compact" || mode === "verbose") {
    return { type: "verbosity", mode };
  }
  return { type: "rejected", reason: "Usage: /verbosity [compact|verbose]" };
}

function parseApprovalCommand(args: string[]): LocalCommand {
  const mode = args[0]?.toLowerCase();
  if (!mode) {
    return { type: "approval_mode", mode: "show" };
  }
  if (mode === "normal" || mode === "auto" || mode === "toggle") {
    return { type: "approval_mode", mode };
  }
  return { type: "rejected", reason: "Usage: /approval [normal|auto|toggle]" };
}

function parseGoalCommand(args: string[], input: string): LocalCommand {
  if (args.length === 0) {
    return { type: "goal", action: "show" };
  }
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === "pause" || subcommand === "resume") {
    return { type: "goal", action: subcommand, message: args.slice(1).join(" ") || undefined };
  }
  if (subcommand === "complete" || subcommand === "done") {
    return { type: "goal", action: "complete", message: args.slice(1).join(" ") || undefined };
  }
  if (subcommand === "clear") {
    return { type: "goal", action: "clear" };
  }
  const parsed = parseCommandOptions(
    subcommand === "set" || subcommand === "create" ? args.slice(1) : args,
  );
  const objective = parsed.positionals.join(" ").trim();
  if (!objective) {
    return { type: "unknown", name: input };
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

function parseRuntimeCommand(args: string[], input: string): LocalCommand {
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
    return args[1]
      ? { type: "runtime", action, proposalId: args[1] }
      : { type: "unknown", name: input };
  }
  return { type: "unknown", name: input };
}

function parseQueryCommand(args: string[]): LocalCommand {
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

function parseInvokeCommand(args: string[], input: string): LocalCommand {
  const parsed = parseCommandOptions(args);
  const [rawPath = "/", action = "", ...jsonParts] = parsed.positionals;
  if (!action) {
    return { type: "unknown", name: input };
  }
  const targetPath = parseTargetPath(rawPath, parsed.values.target);
  return {
    type: "invoke",
    path: targetPath.path,
    action,
    params: parseParams(jsonParts.join(" ").trim()),
    targetId: targetPath.targetId,
  };
}

function parseProfileCommand(args: string[], input: string, withSecret: boolean): LocalCommand {
  if (!withSecret) {
    const inlineSecret = detectInlineSecret(args);
    if (inlineSecret) {
      return { type: "rejected", reason: inlineSecret };
    }
  }
  const parsed = parseCommandOptions(args);
  const [endpointId = "", model] = parsed.positionals;
  if (!endpointId) {
    return { type: "unknown", name: input };
  }
  const adapterId = parsed.values.adapter ?? parsed.values["adapter-id"];
  const profile = {
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
  return withSecret ? { type: "profile_secret", ...profile } : { type: "profile", ...profile };
}

function parseQueueCancelCommand(args: string[], input: string): LocalCommand {
  const raw = args[0];
  if (!raw) {
    return { type: "unknown", name: input };
  }
  const asNumber = Number(raw);
  const isPosition = Number.isInteger(asNumber) && asNumber >= 1 && /^\d+$/.test(raw);
  return { type: "queue_cancel", target: isPosition ? asNumber : raw };
}

function parseConfigReloadCommand(args: string[], input: string): LocalCommand {
  const target = args[0];
  if (!target || target === "session") {
    return { type: "config_reload", target: "session" };
  }
  if (target === "supervisor") {
    return { type: "config_reload", target: "supervisor" };
  }
  return { type: "unknown", name: input };
}

function parseSessionNewCommand(args: string[]): LocalCommand {
  const parsed = parseCommandOptions(args);
  return {
    type: "session_new",
    workspaceId: parsed.values["workspace-id"] ?? parsed.values.workspace,
    projectId: parsed.values["project-id"] ?? parsed.values.project,
    title: parsed.values.title,
    sessionId: parsed.values["session-id"] ?? parsed.values.id,
  };
}

function requiredSessionCommand(
  type: "session_switch" | "session_stop",
  args: string[],
  input: string,
): LocalCommand {
  const sessionId = args[0];
  return sessionId ? { type, sessionId } : { type: "unknown", name: input };
}

import type { InspectorMode, TuiRoute } from "../slop/types";

export type LocalCommand =
  | { type: "route"; route: TuiRoute }
  | { type: "inspector"; mode: InspectorMode }
  | { type: "help" }
  | { type: "clear" }
  | { type: "quit" }
  | { type: "mouse"; mode: "on" | "off" | "toggle" }
  | {
      type: "query";
      path: string;
      depth: number;
      targetId: string;
      window?: [number, number];
      maxNodes?: number;
    }
  | {
      type: "invoke";
      path: string;
      action: string;
      params?: Record<string, unknown>;
      targetId: string;
    }
  | {
      type: "profile";
      profileId?: string;
      label?: string;
      provider: string;
      model?: string;
      reasoningEffort?: string;
      adapterId?: string;
      baseUrl?: string;
      makeDefault: boolean;
    }
  | { type: "rejected"; reason: string }
  | {
      type: "profile_secret";
      profileId?: string;
      label?: string;
      provider: string;
      model?: string;
      reasoningEffort?: string;
      adapterId?: string;
      baseUrl?: string;
      makeDefault: boolean;
    }
  | { type: "set_default_profile"; profileId: string }
  | { type: "delete_profile"; profileId: string }
  | { type: "delete_api_key"; profileId: string }
  | { type: "queue_cancel"; target: string | number }
  | { type: "unknown"; name: string };

const ROUTE_NAMES = new Set<TuiRoute>([
  "chat",
  "setup",
  "approvals",
  "tasks",
  "apps",
  "inspect",
  "settings",
]);

const INSPECTOR_NAMES = new Set<InspectorMode>(["activity", "approvals", "tasks", "apps", "state"]);

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

  if (name === "mouse") {
    const mode = args[0]?.toLowerCase();
    if (mode === "on" || mode === "off" || mode === "toggle" || mode === undefined) {
      return { type: "mouse", mode: mode ?? "toggle" };
    }
    return { type: "unknown", name: trimmed };
  }

  if (ROUTE_NAMES.has(name as TuiRoute)) {
    return { type: "route", route: name as TuiRoute };
  }

  if (name === "inspector" || name === "pane") {
    const mode = args[0]?.toLowerCase();
    if (INSPECTOR_NAMES.has(mode as InspectorMode)) {
      return { type: "inspector", mode: mode as InspectorMode };
    }
    return { type: "unknown", name: trimmed };
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
    const [provider = "", model, positionalBaseUrl] = parsed.positionals;
    if (!provider) {
      return { type: "unknown", name: trimmed };
    }

    return {
      type: "profile",
      profileId: parsed.values.id ?? parsed.values["profile-id"],
      label: parsed.values.label,
      provider,
      model,
      reasoningEffort:
        parsed.values["reasoning-effort"] ?? parsed.values.reasoning ?? parsed.values.effort,
      adapterId: parsed.values.adapter ?? parsed.values["adapter-id"],
      baseUrl: parsed.values["base-url"] ?? parsed.values.baseUrl ?? positionalBaseUrl,
      makeDefault: !parsed.flags.has("no-default"),
    };
  }

  if (name === "profile-secret" || name === "secret-profile") {
    const parsed = parseCommandOptions(args);
    const [provider = "", model, positionalBaseUrl] = parsed.positionals;
    if (!provider) {
      return { type: "unknown", name: trimmed };
    }

    return {
      type: "profile_secret",
      profileId: parsed.values.id ?? parsed.values["profile-id"],
      label: parsed.values.label,
      provider,
      model,
      reasoningEffort:
        parsed.values["reasoning-effort"] ?? parsed.values.reasoning ?? parsed.values.effort,
      adapterId: parsed.values.adapter ?? parsed.values["adapter-id"],
      baseUrl: parsed.values["base-url"] ?? parsed.values.baseUrl ?? positionalBaseUrl,
      makeDefault: !parsed.flags.has("no-default"),
    };
  }

  if (name === "default" || name === "set-default") {
    const profileId = args[0];
    return profileId
      ? { type: "set_default_profile", profileId }
      : { type: "unknown", name: trimmed };
  }

  if (name === "delete-profile" || name === "remove-profile") {
    const profileId = args[0];
    return profileId ? { type: "delete_profile", profileId } : { type: "unknown", name: trimmed };
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

  if (name === "delete-key" || name === "remove-key") {
    const profileId = args[0];
    return profileId ? { type: "delete_api_key", profileId } : { type: "unknown", name: trimmed };
  }

  return { type: "unknown", name: trimmed };
}

const SECRET_KEY_NAMES = new Set([
  "api-key",
  "api_key",
  "apikey",
  "key",
  "secret",
  "token",
  "auth",
  "authorization",
  "bearer",
  "password",
]);

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk[-_][A-Za-z0-9_-]{8,}$/i,
  /^pk[-_][A-Za-z0-9_-]{8,}$/i,
  /^rk[-_][A-Za-z0-9_-]{8,}$/i,
  /^sess[-_][A-Za-z0-9_-]{8,}$/i,
  /^ghp_[A-Za-z0-9]{16,}$/,
  /^gho_[A-Za-z0-9]{16,}$/,
  /^ghs_[A-Za-z0-9]{16,}$/,
  /^ghr_[A-Za-z0-9]{16,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/i,
  /^aws_/i,
  /^AKIA[0-9A-Z]{8,}$/,
  /^Bearer\s+\S{8,}$/i,
];

function looksLikeSecretValue(value: string): boolean {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Catches every shape that could persist a secret through the /profile parser:
 * `--api-key=…`, `--key foo`, secret-shaped positionals (sk-…, ghp_…, …), or
 * a recognized key flag with a high-entropy value. Returns a reason if rejected,
 * otherwise undefined. Conservative on false positives: prefix-matched only.
 */
export function detectInlineSecret(args: string[]): string | undefined {
  const REJECT =
    "Use /profile-secret <provider> [model] for API keys — secrets must not be passed inline.";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flagName = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

      if (SECRET_KEY_NAMES.has(flagName)) {
        // `--api-key=foo` or `--api-key foo` — both are inline secret carriers.
        if (inlineValue !== undefined && inlineValue.length > 0) {
          return REJECT;
        }
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          return REJECT;
        }
      }

      if (inlineValue !== undefined && looksLikeSecretValue(inlineValue)) {
        return REJECT;
      }
      continue;
    }

    if (looksLikeSecretValue(arg)) {
      return REJECT;
    }
  }

  return undefined;
}

function parseCommandOptions(args: string[]): {
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
} {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }

    values[key] = next;
    index += 1;
  }

  return { positionals, values, flags };
}

function parseTargetPath(
  rawPath: string,
  explicitTarget?: string,
): { targetId: string; path: string } {
  if (explicitTarget) {
    return {
      targetId: explicitTarget,
      path: rawPath,
    };
  }

  if (rawPath.startsWith("/")) {
    return {
      targetId: "session",
      path: rawPath,
    };
  }

  const separator = rawPath.indexOf(":/");
  if (separator === -1) {
    return {
      targetId: "session",
      path: rawPath,
    };
  }

  return {
    targetId: rawPath.slice(0, separator),
    path: rawPath.slice(separator + 1),
  };
}

function parseWindow(raw: string | undefined): [number, number] | undefined {
  if (!raw) {
    return undefined;
  }

  const [startRaw, endRaw] = raw.split(":");
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error("Window must use start:end with non-negative integer bounds.");
  }

  return [start, end];
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Expected a positive integer.");
  }

  return value;
}

function parseParams(json: string): Record<string, unknown> | undefined {
  if (!json) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invoke params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

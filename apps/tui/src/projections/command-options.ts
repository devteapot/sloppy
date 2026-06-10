export type ParsedCommandOptions = {
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
};

export function parseCommandOptions(args: string[]): ParsedCommandOptions {
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

export function parseTargetPath(
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

export function parseWindow(raw: string | undefined): [number, number] | undefined {
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

export function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Expected a positive integer.");
  }

  return value;
}

export function parseProfileKind(
  raw: string | undefined,
  adapterId: string | undefined,
): "native" | "session-agent" | undefined {
  if (!raw) {
    return adapterId ? "session-agent" : undefined;
  }
  if (raw === "native" || raw === "session-agent") {
    return raw;
  }
  throw new Error("profile kind must be native or session-agent.");
}

export function parseThinkingEnabled(parsed: {
  values: Record<string, string>;
  flags: Set<string>;
}): boolean | undefined {
  if (parsed.flags.has("thinking")) {
    return true;
  }
  if (parsed.flags.has("no-thinking")) {
    return false;
  }
  const raw = parsed.values.thinking ?? parsed.values["thinking-enabled"];
  if (!raw) {
    return undefined;
  }
  if (raw === "true" || raw === "on" || raw === "enabled") {
    return true;
  }
  if (raw === "false" || raw === "off" || raw === "disabled") {
    return false;
  }
  throw new Error("thinking must be true/false, on/off, or enabled/disabled.");
}

export function parseThinkingDisplay(parsed: {
  values: Record<string, string>;
}): "visible" | "hidden" | undefined {
  const raw = parsed.values["thinking-display"] ?? parsed.values.display;
  if (!raw) {
    return undefined;
  }
  if (raw === "visible" || raw === "hidden") {
    return raw;
  }
  throw new Error("thinking display must be visible or hidden.");
}

export function parseParams(json: string): Record<string, unknown> | undefined {
  if (!json) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invoke params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

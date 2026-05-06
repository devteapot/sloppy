export type Verbosity = "compact" | "normal" | "verbose";

export const VERBOSITY_ORDER: Verbosity[] = ["compact", "normal", "verbose"];

export function nextVerbosity(current: Verbosity): Verbosity {
  const index = VERBOSITY_ORDER.indexOf(current);
  return VERBOSITY_ORDER[(index + 1) % VERBOSITY_ORDER.length] ?? "normal";
}

export function verbosityLabel(value: Verbosity): string {
  return value.toUpperCase();
}

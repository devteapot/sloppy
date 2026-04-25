export type DebugScope =
  | "sub-agent"
  | "orchestration"
  | "filesystem"
  | "delegation"
  | "hub"
  | "loop";

const ALL_SCOPES: ReadonlySet<DebugScope> = new Set([
  "sub-agent",
  "orchestration",
  "filesystem",
  "delegation",
  "hub",
  "loop",
]);

function parseEnabled(): Set<DebugScope> {
  const raw = (process.env.SLOPPY_DEBUG ?? "").trim();
  if (!raw) return new Set();
  if (raw === "1" || raw === "all" || raw === "*") return new Set(ALL_SCOPES);
  const out = new Set<DebugScope>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (ALL_SCOPES.has(token as DebugScope)) {
      out.add(token as DebugScope);
    }
  }
  return out;
}

let enabled = parseEnabled();

export function reloadDebugFromEnv(): void {
  enabled = parseEnabled();
}

export function isDebugEnabled(scope: DebugScope): boolean {
  return enabled.has(scope);
}

export function debug(scope: DebugScope, event: string, data?: Record<string, unknown>): void {
  if (!enabled.has(scope)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope,
    event,
    ...(data ?? {}),
  });
  process.stderr.write(`${line}\n`);
}

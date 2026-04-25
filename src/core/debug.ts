export type DebugScope = string;

let allEnabled = false;

function parseEnabled(): Set<DebugScope> {
  const raw = (process.env.SLOPPY_DEBUG ?? "").trim();
  allEnabled = false;
  if (!raw) return new Set();
  if (raw === "1" || raw === "all" || raw === "*") {
    allEnabled = true;
    return new Set();
  }
  const out = new Set<DebugScope>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length > 0) {
      out.add(token);
    }
  }
  return out;
}

let enabled = parseEnabled();

export function reloadDebugFromEnv(): void {
  enabled = parseEnabled();
}

export function isDebugEnabled(scope: DebugScope): boolean {
  return allEnabled || enabled.has(scope);
}

export function debug(scope: DebugScope, event: string, data?: Record<string, unknown>): void {
  if (!allEnabled && !enabled.has(scope)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope,
    event,
    ...(data ?? {}),
  });
  process.stderr.write(`${line}\n`);
}

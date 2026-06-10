// Small helpers shared by first-party providers so each plugin does not
// re-declare the same timestamp/error/id boilerplate.

export function now(): string {
  return new Date().toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prefixedId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

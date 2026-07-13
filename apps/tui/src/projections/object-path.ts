// Superset key matching: snake_case and kebab-case keys both camelize, so a
// manifest key like "total_tokens" or "last-error" resolves the camelCase
// snapshot field as well as a literal match.
function toCamelCase(value: string): string {
  return value.replace(/[-_]([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function readObjectProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  return record[key] ?? record[toCamelCase(key)];
}

export function readObjectPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(/[/.]/).filter(Boolean)) {
    current = readObjectProperty(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

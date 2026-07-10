export type JsonObject = Record<string, unknown>;

export function asJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export function asString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed || undefined;
}

export function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function definedFields(fields: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function stripKeys<T extends readonly string[]>(source: JsonObject, keys: T): JsonObject {
  const stripped = { ...source };
  for (const key of keys) delete stripped[key];
  return stripped;
}

export function hasAnyKey(source: JsonObject, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(source, key));
}

export function deepMerge(base: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = deepMerge(merged[key] as JsonObject, value as JsonObject);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

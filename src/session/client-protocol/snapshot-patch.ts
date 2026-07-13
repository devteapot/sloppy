export type SnapshotPatchPath = Array<string | number>;

export type SnapshotPatchOperation =
  | { op: "set"; path: SnapshotPatchPath; value: unknown }
  | { op: "delete"; path: SnapshotPatchPath }
  | { op: "append"; path: SnapshotPatchPath; value: string };

function jsonValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

export function createSnapshotPatch(
  previous: unknown,
  next: unknown,
  path: SnapshotPatchPath = [],
): SnapshotPatchOperation[] {
  if (Object.is(previous, next)) return [];
  if (typeof previous === "string" && typeof next === "string" && next.startsWith(previous)) {
    const suffix = next.slice(previous.length);
    return suffix ? [{ op: "append", path, value: suffix }] : [];
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    const operations: SnapshotPatchOperation[] = [];
    const sharedLength = Math.min(previous.length, next.length);
    for (let index = 0; index < sharedLength; index += 1) {
      operations.push(...createSnapshotPatch(previous[index], next[index], [...path, index]));
    }
    for (let index = previous.length - 1; index >= next.length; index -= 1) {
      operations.push({ op: "delete", path: [...path, index] });
    }
    for (let index = sharedLength; index < next.length; index += 1) {
      operations.push({ op: "set", path: [...path, index], value: jsonValue(next[index]) });
    }
    return operations;
  }
  if (isRecord(previous) && isRecord(next)) {
    const operations: SnapshotPatchOperation[] = [];
    const previousKeys = new Set(definedKeys(previous));
    const nextKeys = new Set(definedKeys(next));
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) operations.push({ op: "delete", path: [...path, key] });
    }
    for (const key of nextKeys) {
      if (!previousKeys.has(key)) {
        operations.push({ op: "set", path: [...path, key], value: jsonValue(next[key]) });
      } else {
        operations.push(...createSnapshotPatch(previous[key], next[key], [...path, key]));
      }
    }
    return operations;
  }
  return [{ op: "set", path, value: jsonValue(next) }];
}

function safeSegment(segment: string | number): void {
  if (typeof segment === "string" && ["__proto__", "prototype", "constructor"].includes(segment)) {
    throw new Error(`Unsafe snapshot patch path segment: ${segment}`);
  }
}

export function applySnapshotPatch<T>(snapshot: T, operations: SnapshotPatchOperation[]): T {
  let result = structuredClone(snapshot) as unknown;
  for (const operation of operations) {
    for (const segment of operation.path) safeSegment(segment);
    if (operation.path.length === 0) {
      if (operation.op !== "set") throw new Error(`Invalid root snapshot patch: ${operation.op}`);
      result = structuredClone(operation.value);
      continue;
    }
    let parent = result;
    for (const segment of operation.path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") {
        throw new Error("Snapshot patch traversed a non-container value.");
      }
      parent = (parent as Record<string | number, unknown>)[segment];
    }
    if (parent === null || typeof parent !== "object") {
      throw new Error("Snapshot patch targeted a non-container value.");
    }
    const key = operation.path.at(-1);
    if (key === undefined) throw new Error("Snapshot patch path was empty.");
    if (operation.op === "delete") {
      if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
      else delete (parent as Record<string | number, unknown>)[key];
    } else if (operation.op === "append") {
      const current = (parent as Record<string | number, unknown>)[key];
      if (typeof current !== "string") throw new Error("Snapshot append targeted a non-string.");
      (parent as Record<string | number, unknown>)[key] = current + operation.value;
    } else {
      (parent as Record<string | number, unknown>)[key] = structuredClone(operation.value);
    }
  }
  return result as T;
}

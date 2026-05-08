import type {
  JsonObject,
  JsonValue,
  SessionExtensionOwner,
  SessionExtensionRecord,
} from "../types";
import { buildId, now } from "./helpers";
import type { SessionStoreState } from "./state";

export type ExtensionPatchOptions = {
  expectedRevision?: number;
  instanceId?: string;
  touchSession?: boolean;
};

export type CreateExtensionOptions = {
  namespace: string;
  instanceId?: string;
  schemaVersion: number;
  owner: SessionExtensionOwner;
  state: JsonObject;
  cleanupPolicy?: SessionExtensionRecord["cleanupPolicy"];
  lifecycle?: SessionExtensionRecord["lifecycle"];
  retainUntil?: string;
};

export type PatchExtensionResult = {
  record: SessionExtensionRecord;
  previousRevision: number;
};

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneExtensionRecord(record: SessionExtensionRecord): SessionExtensionRecord {
  return {
    ...record,
    owner: { ...record.owner },
    state: cloneJsonValue(record.state),
    cleanupPolicy: record.cleanupPolicy ? { ...record.cleanupPolicy } : undefined,
  };
}

export function cloneExtensions(
  extensions: Record<string, SessionExtensionRecord> | undefined,
): Record<string, SessionExtensionRecord> {
  return Object.fromEntries(
    Object.entries(extensions ?? {}).map(([namespace, record]) => [
      namespace,
      cloneExtensionRecord(record),
    ]),
  );
}

export function createExtensionRecord(options: CreateExtensionOptions): SessionExtensionRecord {
  const time = now();
  return {
    namespace: options.namespace,
    instanceId: options.instanceId ?? buildId(`extension-${options.namespace}`),
    schemaVersion: options.schemaVersion,
    revision: 1,
    owner: { ...options.owner },
    state: cloneJsonValue(options.state),
    lifecycle: options.lifecycle ?? "active",
    cleanupPolicy: options.cleanupPolicy ? { ...options.cleanupPolicy } : undefined,
    retainUntil: options.retainUntil,
    createdAt: time,
    updatedAt: time,
    lastUsedAt: time,
  };
}

export function getExtension(
  snapshot: { extensions?: Record<string, SessionExtensionRecord> },
  namespace: string,
): SessionExtensionRecord | null {
  const record = snapshot.extensions?.[namespace];
  return record ? cloneExtensionRecord(record) : null;
}

export function upsertExtension(
  state: SessionStoreState,
  record: SessionExtensionRecord,
  options?: { touchSession?: boolean },
): void {
  const time = now();
  state.snapshot.extensions[record.namespace] = {
    ...cloneExtensionRecord(record),
    updatedAt: record.updatedAt || time,
    lastUsedAt: record.lastUsedAt || time,
  };
  markExtensionChanged(state, options?.touchSession ?? true, time);
}

export function patchExtension(
  state: SessionStoreState,
  namespace: string,
  patch: (record: SessionExtensionRecord) => SessionExtensionRecord,
  options?: ExtensionPatchOptions,
): PatchExtensionResult {
  const current = state.snapshot.extensions[namespace];
  if (!current) {
    throw new Error(`Unknown session extension: ${namespace}.`);
  }
  if (options?.instanceId && current.instanceId !== options.instanceId) {
    throw new Error(`Session extension ${namespace} instance mismatch.`);
  }
  if (options?.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
    throw new Error(`Session extension ${namespace} revision mismatch.`);
  }

  const time = now();
  const previousRevision = current.revision;
  const updated = patch(cloneExtensionRecord(current));
  state.snapshot.extensions[namespace] = {
    ...updated,
    namespace,
    instanceId: current.instanceId,
    revision: previousRevision + 1,
    createdAt: current.createdAt,
    updatedAt: time,
    lastUsedAt: time,
  };
  markExtensionChanged(state, options?.touchSession ?? true, time);
  return {
    record: cloneExtensionRecord(state.snapshot.extensions[namespace]),
    previousRevision,
  };
}

export function clearExtension(state: SessionStoreState, namespace: string): boolean {
  if (!state.snapshot.extensions[namespace]) {
    return false;
  }
  const time = now();
  delete state.snapshot.extensions[namespace];
  markExtensionChanged(state, true, time);
  return true;
}

export function sweepExtensions(
  state: SessionStoreState,
  options?: { now?: string },
): { removed: string[] } {
  const reference = Date.parse(options?.now ?? now());
  const removed: string[] = [];
  for (const [namespace, record] of Object.entries(state.snapshot.extensions)) {
    if (!record.retainUntil) {
      continue;
    }
    const retainUntil = Date.parse(record.retainUntil);
    if (!Number.isFinite(retainUntil) || retainUntil > reference) {
      continue;
    }
    delete state.snapshot.extensions[namespace];
    removed.push(namespace);
  }
  if (removed.length > 0) {
    markExtensionChanged(state, true, options?.now ?? now());
  }
  return { removed };
}

function markExtensionChanged(state: SessionStoreState, touchSession: boolean, time: string): void {
  state.extensionsChanged = true;
  if (touchSession) {
    state.snapshot.session.lastActivityAt = time;
    state.sessionChanged = true;
  }
}

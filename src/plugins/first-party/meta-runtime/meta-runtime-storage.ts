import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  MetaEvent,
  MetaScope,
  MetaStateMaps,
  PersistedState,
  Proposal,
  TopologyPattern,
} from "./meta-runtime-model";
import { listById, listByName, snapshotStateMaps } from "./meta-runtime-model";

const META_RUNTIME_STATE_KIND = "sloppy.meta-runtime.state";
const META_RUNTIME_STATE_SCHEMA_VERSION = 1;

type PersistedMetaStateEnvelope = {
  kind: typeof META_RUNTIME_STATE_KIND;
  schema_version: typeof META_RUNTIME_STATE_SCHEMA_VERSION;
  saved_at: string;
  state: PersistedState;
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapPersistedMetaState(parsed: unknown, path: string): PersistedState {
  if (!isRecord(parsed)) {
    throw new Error(`Meta-runtime state at ${path} must be an object.`);
  }
  if (
    parsed.kind === undefined &&
    parsed.schema_version === undefined &&
    parsed.state === undefined
  ) {
    return parsed as PersistedState;
  }
  if (parsed.kind !== META_RUNTIME_STATE_KIND) {
    throw new Error(`Meta-runtime state at ${path} has unsupported kind.`);
  }
  if (parsed.schema_version !== META_RUNTIME_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Meta-runtime state at ${path} has unsupported schema_version ${String(
        parsed.schema_version,
      )}.`,
    );
  }
  if (!isRecord(parsed.state)) {
    throw new Error(`Meta-runtime state at ${path} has malformed state payload.`);
  }
  return parsed.state as PersistedState;
}

export function resolveMetaRuntimeRoot(path: string): string {
  return resolve(expandHome(path));
}

export function readPersistedMetaState(root: string): PersistedState {
  const path = join(root, "state.json");
  if (!existsSync(path)) return {};
  try {
    return unwrapPersistedMetaState(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  } catch (error) {
    throw new Error(
      `Could not read meta-runtime state at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function writePersistedMetaState(root: string, state: PersistedState): void {
  mkdirSync(root, { recursive: true });
  const envelope: PersistedMetaStateEnvelope = {
    kind: META_RUNTIME_STATE_KIND,
    schema_version: META_RUNTIME_STATE_SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    state,
  };
  writeFileSync(join(root, "state.json"), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

export function snapshotMetaScope(
  layers: Record<MetaScope, MetaStateMaps>,
  proposals: Map<string, Proposal>,
  patterns: Map<string, TopologyPattern>,
  events: MetaEvent[],
  scope: Exclude<MetaScope, "session">,
): PersistedState {
  return {
    ...snapshotStateMaps(layers[scope]),
    proposals: listById(proposals).filter((proposal) => proposal.scope === scope),
    patterns: listByName(patterns).filter((pattern) => pattern.scope === scope),
    events: events.filter((event) => event.scope === scope).slice(-200),
  };
}

export function snapshotMergedMetaState(
  state: MetaStateMaps,
  proposals: Map<string, Proposal>,
  patterns: Map<string, TopologyPattern>,
  events: MetaEvent[],
): PersistedState {
  return {
    profiles: listByName(state.profiles),
    agents: listById(state.agents),
    channels: listById(state.channels),
    routes: listById(state.routes),
    capabilities: listById(state.capabilities),
    executorBindings: listById(state.executorBindings),
    skillVersions: listById(state.skillVersions),
    experiments: listById(state.experiments),
    evaluations: listById(state.evaluations),
    proposals: listById(proposals),
    patterns: listByName(patterns),
    events: events.slice(-200),
  };
}

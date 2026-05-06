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

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveMetaRuntimeRoot(path: string): string {
  return resolve(expandHome(path));
}

export function readPersistedMetaState(root: string): PersistedState {
  const path = join(root, "state.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedState;
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
  writeFileSync(join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

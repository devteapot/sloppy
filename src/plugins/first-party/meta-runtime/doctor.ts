import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RuntimeDoctorCheck, RuntimeDoctorContext } from "../../../runtime/doctor-types";
import { readPersistedMetaState } from "./meta-runtime-storage";

export async function checkMetaRuntimePersistence({
  config,
}: RuntimeDoctorContext): Promise<RuntimeDoctorCheck> {
  const paths = [
    join(config.plugins["meta-runtime"].globalRoot, "state.json"),
    join(config.plugins["meta-runtime"].workspaceRoot, "state.json"),
  ];
  const existingPaths = paths.filter((path) => existsSync(path));
  if (existingPaths.length === 0) {
    return {
      id: "meta-runtime-persistence",
      status: config.plugins["meta-runtime"].enabled ? "ok" : "skipped",
      summary: config.plugins["meta-runtime"].enabled
        ? "No persisted meta-runtime state files found; they will be created on first write."
        : "Meta-runtime is disabled and no persisted state files were found.",
    };
  }

  const errors: string[] = [];
  for (const path of existingPaths) {
    try {
      readPersistedMetaState(dirname(path));
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length > 0) {
    return {
      id: "meta-runtime-persistence",
      status: "error",
      summary: `${errors.length} persisted meta-runtime state file(s) could not be loaded.`,
      detail: errors.join("\n"),
    };
  }

  return {
    id: "meta-runtime-persistence",
    status: "ok",
    summary: `${existingPaths.length} persisted meta-runtime state file(s) use the current schema envelope.`,
  };
}

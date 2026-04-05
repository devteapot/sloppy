import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";

import { type SloppyConfig, sloppyConfigSchema } from "./schema";

type JsonObject = Record<string, unknown>;

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

function deepMerge(base: JsonObject, incoming: JsonObject): JsonObject {
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
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function readConfigFile(filePath: string): JsonObject {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${filePath}: expected a YAML object.`);
  }

  return parsed as JsonObject;
}

function applyEnvironmentOverrides(config: JsonObject): JsonObject {
  const overrides: JsonObject = {};

  if (process.env.SLOPPY_MODEL) {
    overrides.llm = { model: process.env.SLOPPY_MODEL };
  }

  if (process.env.SLOPPY_CONTEXT_BUDGET_TOKENS) {
    overrides.agent = {
      ...(overrides.agent as JsonObject | undefined),
      contextBudgetTokens: Number.parseInt(process.env.SLOPPY_CONTEXT_BUDGET_TOKENS, 10),
    };
  }

  return deepMerge(config, overrides);
}

function normalizeConfig(config: SloppyConfig): SloppyConfig {
  const terminalCwd = resolve(expandHomePath(config.providers.terminal.cwd));
  const filesystemRoot = resolve(expandHomePath(config.providers.filesystem.root));
  const filesystemFocus = config.providers.filesystem.focus
    ? resolve(filesystemRoot, expandHomePath(config.providers.filesystem.focus))
    : filesystemRoot;

  return {
    ...config,
    providers: {
      ...config.providers,
      discovery: {
        ...config.providers.discovery,
        paths: config.providers.discovery.paths.map((path) => resolve(expandHomePath(path))),
      },
      terminal: {
        ...config.providers.terminal,
        cwd: terminalCwd,
      },
      filesystem: {
        ...config.providers.filesystem,
        root: filesystemRoot,
        focus: filesystemFocus,
      },
    },
  };
}

export function loadConfig(): SloppyConfig {
  const homeConfigPath = resolve(homedir(), ".sloppy/config.yaml");
  const workspaceConfigPath = resolve(process.cwd(), ".sloppy/config.yaml");

  const merged = deepMerge(
    deepMerge({}, readConfigFile(homeConfigPath)),
    readConfigFile(workspaceConfigPath),
  );

  const withEnv = applyEnvironmentOverrides(merged);
  const parsed = sloppyConfigSchema.parse(withEnv);

  return normalizeConfig(parsed);
}

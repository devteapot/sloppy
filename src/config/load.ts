import { resolve } from "node:path";

import YAML from "yaml";

import { getDefaultEndpointModel, mergeLlmEndpoints } from "../llm/catalog";
import { normalizeThinkingConfig } from "../llm/thinking";
import { applyEnvironmentOverrides } from "./environment";
import { asJsonObject, deepMerge, type JsonObject } from "./json";
import { normalizeConfigInput } from "./llm-migrations";
import {
  type AnyLlmProfileConfig,
  type LlmConfig,
  type RawSloppyConfig,
  type SloppyConfig,
  sloppyConfigSchema,
} from "./schema";

export { applyEnvironmentOverrides } from "./environment";
export type { JsonObject } from "./json";
export { deepMerge } from "./json";

function getHomeDirectory(): string {
  const home = Bun.env.HOME;
  if (!home) {
    throw new Error("HOME is not set. Sloppy requires a home directory to resolve config paths.");
  }
  return home;
}

export function getHomeConfigPath(): string {
  return resolve(getHomeDirectory(), ".sloppy/config.yaml");
}

export function getWorkspaceConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, ".sloppy/config.yaml");
}

export function expandHomePath(path: string): string {
  if (path === "~") return getHomeDirectory();
  if (path.startsWith("~/")) return resolve(getHomeDirectory(), path.slice(2));
  return path;
}

export async function readConfigFile(filePath: string): Promise<JsonObject> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return {};
  const parsed = YAML.parse(await file.text());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${filePath}: expected a YAML object.`);
  }
  return parsed as JsonObject;
}

function normalizeLlmConfig(config: RawSloppyConfig["llm"]): LlmConfig {
  const endpoints = mergeLlmEndpoints(config.endpoints);
  for (const [endpointId, endpoint] of Object.entries(endpoints)) {
    if (!endpoint.baseUrl) continue;
    const carriesCredentials = endpoint.auth.type !== "none" || endpoint.headerEnv !== undefined;
    if (carriesCredentials && new URL(endpoint.baseUrl).protocol !== "https:") {
      throw new Error(`Credential-bearing LLM endpoint '${endpointId}' must use https.`);
    }
  }
  const profiles = config.profiles.map((profile): AnyLlmProfileConfig => {
    if (profile.kind === "session-agent") return profile;
    return {
      ...profile,
      model: profile.model ?? getDefaultEndpointModel(profile.endpointId) ?? profile.model,
    };
  });
  return {
    reasoningEffort: config.reasoningEffort,
    thinking: normalizeThinkingConfig(config.thinking),
    endpoints,
    defaultProfileId: config.defaultProfileId,
    profiles,
    maxTokens: config.maxTokens,
    requestPolicy: config.requestPolicy,
  };
}

function normalizeMcpServers(
  servers: RawSloppyConfig["plugins"]["mcp"]["servers"],
  filesystemRoot: string,
): RawSloppyConfig["plugins"]["mcp"]["servers"] {
  return Object.fromEntries(
    Object.entries(servers).map(([id, server]) => {
      if (server.transport !== "stdio" || !server.cwd) return [id, server];
      return [id, { ...server, cwd: resolve(filesystemRoot, expandHomePath(server.cwd)) }];
    }),
  ) as RawSloppyConfig["plugins"]["mcp"]["servers"];
}

function resolveConfigPath(root: string, configPath: string): string {
  return resolve(root, expandHomePath(configPath));
}

function normalizeWorkspaces(
  workspaces: RawSloppyConfig["workspaces"],
  cwd = process.cwd(),
): RawSloppyConfig["workspaces"] {
  return {
    ...workspaces,
    items: Object.fromEntries(
      Object.entries(workspaces.items).map(([workspaceId, workspace]) => {
        const workspaceRoot = resolve(cwd, expandHomePath(workspace.root));
        return [
          workspaceId,
          {
            ...workspace,
            root: workspaceRoot,
            configPath: resolveConfigPath(workspaceRoot, workspace.configPath),
            projects: Object.fromEntries(
              Object.entries(workspace.projects).map(([projectId, project]) => {
                const projectRoot = resolve(workspaceRoot, expandHomePath(project.root));
                return [
                  projectId,
                  {
                    ...project,
                    root: projectRoot,
                    configPath: resolveConfigPath(projectRoot, project.configPath),
                  },
                ];
              }),
            ),
          },
        ];
      }),
    ),
  };
}

export function normalizeConfig(config: RawSloppyConfig, cwd = process.cwd()): SloppyConfig {
  const terminalCwd = resolve(cwd, expandHomePath(config.plugins.terminal.cwd));
  const filesystemRoot = resolve(cwd, expandHomePath(config.plugins.filesystem.root));
  const filesystemFocus = config.plugins.filesystem.focus
    ? resolve(filesystemRoot, expandHomePath(config.plugins.filesystem.focus))
    : filesystemRoot;
  const metaRuntimeGlobalRoot = resolve(
    cwd,
    expandHomePath(config.plugins["meta-runtime"].globalRoot),
  );
  const metaRuntimeWorkspaceRoot = resolve(
    filesystemRoot,
    expandHomePath(config.plugins["meta-runtime"].workspaceRoot),
  );

  return {
    ...config,
    llm: normalizeLlmConfig(config.llm),
    workspaces: normalizeWorkspaces(config.workspaces, cwd),
    plugins: {
      ...config.plugins,
      terminal: { ...config.plugins.terminal, cwd: terminalCwd },
      filesystem: { ...config.plugins.filesystem, root: filesystemRoot, focus: filesystemFocus },
      skills: {
        ...config.plugins.skills,
        builtinSkillsDir: resolve(
          filesystemRoot,
          expandHomePath(config.plugins.skills.builtinSkillsDir ?? "skills"),
        ),
        skillsDir: resolve(expandHomePath(config.plugins.skills.skillsDir)),
        externalDirs: (config.plugins.skills.externalDirs ?? []).map((path) =>
          resolve(expandHomePath(path)),
        ),
      },
      "meta-runtime": {
        ...config.plugins["meta-runtime"],
        globalRoot: metaRuntimeGlobalRoot,
        workspaceRoot: metaRuntimeWorkspaceRoot,
      },
      mcp: {
        ...config.plugins.mcp,
        servers: normalizeMcpServers(config.plugins.mcp.servers, filesystemRoot),
      },
    },
    providers: {
      discovery: {
        ...config.providers.discovery,
        paths: config.providers.discovery.paths.map((path) => resolve(expandHomePath(path))),
      },
    },
  };
}

export async function loadConfigFromPaths(
  homeConfigPath: string,
  workspaceConfigPath: string,
  options: { cwd?: string } = {},
): Promise<SloppyConfig> {
  return loadConfigFromLayerPaths([homeConfigPath, workspaceConfigPath], options);
}

export async function loadConfigFromLayerPaths(
  configPaths: string[],
  options: { cwd?: string } = {},
): Promise<SloppyConfig> {
  const merged = await mergeConfigPaths(configPaths);
  return parseConfig(merged, options.cwd ?? process.cwd());
}

export type ScopedConfigOptions = {
  workspaceId?: string;
  projectId?: string;
  cwd?: string;
  homeConfigPath?: string;
  workspaceConfigPath?: string;
};

export async function loadScopedConfig(options: ScopedConfigOptions = {}): Promise<SloppyConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeConfigPath = options.homeConfigPath ?? getHomeConfigPath();
  const workspaceConfigPath = options.workspaceConfigPath ?? getWorkspaceConfigPath(cwd);
  const baseConfig = await loadConfigFromPaths(homeConfigPath, workspaceConfigPath, { cwd });
  const registry = baseConfig.workspaces;
  const workspaceId =
    options.workspaceId ?? registry?.activeWorkspaceId ?? firstKey(registry?.items ?? {});
  if (!workspaceId) return baseConfig;

  const workspace = registry?.items[workspaceId];
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  const projectId = options.projectId ?? registry?.activeProjectId;
  const project = projectId ? workspace.projects[projectId] : undefined;
  if (projectId && !project) {
    throw new Error(`Unknown project for workspace ${workspaceId}: ${projectId}`);
  }

  const scopeRoot = project?.root ?? workspace.root;
  const merged = await mergeConfigPaths([
    homeConfigPath,
    workspace.configPath,
    ...(project ? [project.configPath] : []),
  ]);
  const scoped = deepMerge(merged, {
    workspaces: {
      activeWorkspaceId: workspaceId,
      activeProjectId: project ? projectId : undefined,
      items: registry?.items ?? {},
    },
    plugins: {
      terminal: { cwd: scopeRoot },
      filesystem: { root: scopeRoot, focus: scopeRoot },
    },
  });
  return parseConfig(scoped, scopeRoot);
}

export async function loadConfig(): Promise<SloppyConfig> {
  return loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath());
}

export function createDefaultConfig(cwd = process.cwd()): SloppyConfig {
  return normalizeConfig(sloppyConfigSchema.parse({}), cwd);
}

async function mergeConfigPaths(paths: string[]): Promise<JsonObject> {
  let merged: JsonObject = {};
  for (const [index, configPath] of uniquePaths(paths).entries()) {
    const layer = await readConfigFile(configPath);
    if (index > 0) {
      assertUntrustedLayerHasNoLlmEndpointConfig(layer, configPath);
    }
    merged = deepMerge(merged, layer);
  }
  return merged;
}

function assertUntrustedLayerHasNoLlmEndpointConfig(layer: JsonObject, configPath: string): void {
  const llm = asJsonObject(layer.llm);
  if (!llm) return;

  if (Object.hasOwn(llm, "endpoints")) {
    throw new Error(
      `Untrusted config layer ${configPath} may not configure llm.endpoints. Move endpoint routing and credentials to the first trusted config layer.`,
    );
  }

  for (const field of ["baseUrl", "apiKeyEnv"] as const) {
    if (Object.hasOwn(llm, field)) {
      throw new Error(
        `Untrusted config layer ${configPath} may not configure legacy llm.${field}. Move endpoint routing and credentials to the first trusted config layer.`,
      );
    }
  }

  if (!Array.isArray(llm.profiles)) return;
  for (const [index, value] of llm.profiles.entries()) {
    const profile = asJsonObject(value);
    if (!profile) continue;
    for (const field of ["baseUrl", "apiKeyEnv"] as const) {
      if (Object.hasOwn(profile, field)) {
        throw new Error(
          `Untrusted config layer ${configPath} may not configure legacy llm.profiles[${index}].${field}. Move endpoint routing and credentials to the first trusted config layer.`,
        );
      }
    }
  }
}

function parseConfig(config: JsonObject, cwd: string): SloppyConfig {
  const migrated = normalizeConfigInput(config);
  const withEnvironment = applyEnvironmentOverrides(migrated);
  return normalizeConfig(sloppyConfigSchema.parse(withEnvironment), cwd);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function firstKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record).sort()[0];
}

export const defaultConfigPromise = loadConfig();
defaultConfigPromise.catch(() => undefined);

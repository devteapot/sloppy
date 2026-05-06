import { resolve } from "node:path";
import YAML from "yaml";
import { getProviderDefaults } from "../llm/provider-defaults";
import {
  type LlmConfig,
  type LlmProfileConfig,
  type RawSloppyConfig,
  type SloppyConfig,
  sloppyConfigSchema,
} from "./schema";

export type JsonObject = Record<string, unknown>;

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
  if (path === "~") {
    return getHomeDirectory();
  }

  if (path.startsWith("~/")) {
    return resolve(getHomeDirectory(), path.slice(2));
  }

  return path;
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
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export async function readConfigFile(filePath: string): Promise<JsonObject> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {};
  }

  const raw = await file.text();
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${filePath}: expected a YAML object.`);
  }

  return parsed as JsonObject;
}

export function applyEnvironmentOverrides(config: JsonObject): JsonObject {
  const overrides: JsonObject = {};

  if (Bun.env.SLOPPY_LLM_PROVIDER) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      provider: Bun.env.SLOPPY_LLM_PROVIDER,
    };
  }

  if (Bun.env.SLOPPY_MODEL) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      model: Bun.env.SLOPPY_MODEL,
    };
  }

  if (Bun.env.SLOPPY_LLM_REASONING_EFFORT) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      reasoningEffort: Bun.env.SLOPPY_LLM_REASONING_EFFORT,
    };
  }

  if (Bun.env.SLOPPY_LLM_ADAPTER_ID) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      adapterId: Bun.env.SLOPPY_LLM_ADAPTER_ID,
    };
  }

  if (Bun.env.SLOPPY_LLM_BASE_URL) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      baseUrl: Bun.env.SLOPPY_LLM_BASE_URL,
    };
  }

  if (Bun.env.SLOPPY_LLM_API_KEY_ENV) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      apiKeyEnv: Bun.env.SLOPPY_LLM_API_KEY_ENV,
    };
  }

  if (Bun.env.SLOPPY_CONTEXT_BUDGET_TOKENS) {
    overrides.agent = {
      ...(overrides.agent as JsonObject | undefined),
      contextBudgetTokens: Number.parseInt(Bun.env.SLOPPY_CONTEXT_BUDGET_TOKENS, 10),
    };
  }

  if (Bun.env.SLOPPY_MAX_ITERATIONS) {
    overrides.agent = {
      ...(overrides.agent as JsonObject | undefined),
      maxIterations: Number.parseInt(Bun.env.SLOPPY_MAX_ITERATIONS, 10),
    };
  }

  return deepMerge(config, overrides);
}

function normalizeProfile(profile: RawSloppyConfig["llm"]["profiles"][number]): LlmProfileConfig {
  const defaults = getProviderDefaults(profile.provider);

  return {
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model ?? defaults.model,
    reasoningEffort: profile.reasoningEffort,
    adapterId: profile.adapterId ?? defaults.adapterId,
    apiKeyEnv: profile.apiKeyEnv ?? defaults.apiKeyEnv,
    baseUrl: profile.baseUrl ?? defaults.baseUrl,
  };
}

function normalizeLlmConfig(config: RawSloppyConfig["llm"]): LlmConfig {
  const defaults = getProviderDefaults(config.provider);

  return {
    provider: config.provider,
    model: config.model ?? defaults.model,
    reasoningEffort: config.reasoningEffort,
    adapterId: config.adapterId ?? defaults.adapterId,
    apiKeyEnv: config.apiKeyEnv ?? defaults.apiKeyEnv,
    baseUrl: config.baseUrl ?? defaults.baseUrl,
    defaultProfileId: config.defaultProfileId,
    profiles: config.profiles.map((profile) => normalizeProfile(profile)),
    maxTokens: config.maxTokens,
  };
}

function normalizeMcpServers(
  servers: RawSloppyConfig["providers"]["mcp"]["servers"],
  filesystemRoot: string,
): RawSloppyConfig["providers"]["mcp"]["servers"] {
  return Object.fromEntries(
    Object.entries(servers).map(([id, server]) => {
      if (server.transport !== "stdio" || !server.cwd) {
        return [id, server];
      }

      return [
        id,
        {
          ...server,
          cwd: resolve(filesystemRoot, expandHomePath(server.cwd)),
        },
      ];
    }),
  ) as RawSloppyConfig["providers"]["mcp"]["servers"];
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
  const terminalCwd = resolve(cwd, expandHomePath(config.providers.terminal.cwd));
  const filesystemRoot = resolve(cwd, expandHomePath(config.providers.filesystem.root));
  const filesystemFocus = config.providers.filesystem.focus
    ? resolve(filesystemRoot, expandHomePath(config.providers.filesystem.focus))
    : filesystemRoot;
  const metaRuntimeGlobalRoot = resolve(
    cwd,
    expandHomePath(config.providers.metaRuntime.globalRoot),
  );
  const metaRuntimeWorkspaceRoot = resolve(
    filesystemRoot,
    expandHomePath(config.providers.metaRuntime.workspaceRoot),
  );

  return {
    ...config,
    llm: normalizeLlmConfig(config.llm),
    workspaces: normalizeWorkspaces(config.workspaces, cwd),
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
      skills: {
        ...config.providers.skills,
        builtinSkillsDir: resolve(
          filesystemRoot,
          expandHomePath(config.providers.skills.builtinSkillsDir ?? "skills"),
        ),
        skillsDir: resolve(expandHomePath(config.providers.skills.skillsDir)),
        externalDirs: (config.providers.skills.externalDirs ?? []).map((path) =>
          resolve(expandHomePath(path)),
        ),
      },
      metaRuntime: {
        ...config.providers.metaRuntime,
        globalRoot: metaRuntimeGlobalRoot,
        workspaceRoot: metaRuntimeWorkspaceRoot,
      },
      mcp: {
        ...config.providers.mcp,
        servers: normalizeMcpServers(config.providers.mcp.servers, filesystemRoot),
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

export async function loadConfigFromLayerPaths(
  configPaths: string[],
  options: { cwd?: string } = {},
): Promise<SloppyConfig> {
  let merged: JsonObject = {};
  for (const configPath of uniquePaths(configPaths)) {
    merged = deepMerge(merged, await readConfigFile(configPath));
  }

  const withEnv = applyEnvironmentOverrides(merged);
  const parsed = sloppyConfigSchema.parse(withEnv);

  return normalizeConfig(parsed, options.cwd ?? process.cwd());
}

function firstKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record).sort()[0];
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

  if (!workspaceId) {
    return baseConfig;
  }

  const workspace = registry?.items[workspaceId];
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }

  const projectId = options.projectId ?? registry?.activeProjectId;
  const project = projectId ? workspace.projects[projectId] : undefined;
  if (projectId && !project) {
    throw new Error(`Unknown project for workspace ${workspaceId}: ${projectId}`);
  }

  const scopeRoot = project?.root ?? workspace.root;
  let merged: JsonObject = {};
  for (const configPath of uniquePaths([
    homeConfigPath,
    workspace.configPath,
    ...(project ? [project.configPath] : []),
  ])) {
    merged = deepMerge(merged, await readConfigFile(configPath));
  }

  const scoped = deepMerge(merged, {
    workspaces: {
      activeWorkspaceId: workspaceId,
      activeProjectId: project ? projectId : undefined,
      items: registry?.items ?? {},
    },
    providers: {
      terminal: {
        cwd: scopeRoot,
      },
      filesystem: {
        root: scopeRoot,
        focus: scopeRoot,
      },
    },
  });
  const withEnv = applyEnvironmentOverrides(scoped);
  const parsed = sloppyConfigSchema.parse(withEnv);

  return normalizeConfig(parsed, scopeRoot);
}

export async function loadConfig(): Promise<SloppyConfig> {
  return loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath());
}

export const defaultConfigPromise = loadConfig();

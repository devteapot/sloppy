import { resolve } from "node:path";
import YAML from "yaml";
import {
  DEFAULT_LLM_ENDPOINTS,
  getDefaultEndpointModel,
  getDefaultEndpointProtocol,
  mergeLlmEndpoints,
} from "../llm/catalog";
import { normalizeThinkingConfig } from "../llm/thinking";
import {
  type AnyLlmProfileConfig,
  type LlmConfig,
  type RawSloppyConfig,
  type SloppyConfig,
  sloppyConfigSchema,
} from "./schema";

export type JsonObject = Record<string, unknown>;

const LEGACY_LLM_ROOT_KEYS = [
  "provider",
  "model",
  "adapterId",
  "apiKeyEnv",
  "baseUrl",
  "contextWindowTokens",
] as const;

const LEGACY_LLM_PROFILE_KEYS = [
  "provider",
  "apiKeyEnv",
  "baseUrl",
  "contextWindowTokens",
] as const;

const LEGACY_NATIVE_LLM_PROFILE_KEYS = [...LEGACY_LLM_PROFILE_KEYS, "adapterId"] as const;

function asJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function definedFields(fields: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function stripKeys<T extends readonly string[]>(source: JsonObject, keys: T): JsonObject {
  const stripped = { ...source };
  for (const key of keys) {
    delete stripped[key];
  }
  return stripped;
}

function hasAnyKey(source: JsonObject, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(source, key));
}

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

function normalizeEndpointForSchema(endpoint: JsonObject): JsonObject {
  const normalized = { ...endpoint };
  delete normalized.defaultModel;
  return normalized;
}

function normalizeEndpointsForSchema(value: unknown): JsonObject {
  const endpoints = asJsonObject(value);
  if (!endpoints) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(endpoints).map(([endpointId, endpoint]) => [
      endpointId,
      asJsonObject(endpoint) ? normalizeEndpointForSchema(endpoint as JsonObject) : endpoint,
    ]),
  );
}

function mergeEndpointOverride(
  endpoints: JsonObject,
  endpointId: string,
  endpoint: JsonObject | undefined,
): void {
  if (!endpoint) {
    return;
  }

  const existing = asJsonObject(endpoints[endpointId]);
  if (!existing) {
    endpoints[endpointId] = endpoint;
    return;
  }

  const merged = deepMerge(existing, endpoint);
  if (endpoint.auth) {
    merged.auth = endpoint.auth;
  }
  endpoints[endpointId] = merged;
}

function buildLegacyEndpointOverride(
  provider: string,
  source: JsonObject,
  model: string,
  endpointId: string,
): JsonObject | undefined {
  const baseUrl = asString(source.baseUrl);
  const apiKeyEnv = asString(source.apiKeyEnv);
  const contextWindowTokens = asPositiveNumber(source.contextWindowTokens);
  if (!baseUrl && !apiKeyEnv && !contextWindowTokens && endpointId === provider) {
    return undefined;
  }

  const defaultEndpoint = DEFAULT_LLM_ENDPOINTS[provider];
  const defaultModel = defaultEndpoint?.models[model];
  return {
    ...(defaultEndpoint?.label ? { label: defaultEndpoint.label } : {}),
    protocol: getDefaultEndpointProtocol(provider) ?? "openai-chat",
    ...((baseUrl ?? defaultEndpoint?.baseUrl)
      ? { baseUrl: baseUrl ?? defaultEndpoint?.baseUrl }
      : {}),
    auth: apiKeyEnv ? { type: "env", env: apiKeyEnv } : (defaultEndpoint?.auth ?? { type: "none" }),
    models: {
      ...(defaultEndpoint?.models ?? {}),
      [model]: definedFields({
        ...(defaultModel ?? {}),
        contextWindowTokens: contextWindowTokens ?? defaultModel?.contextWindowTokens,
      }),
    },
  };
}

function legacyEndpointId(provider: string, profile: JsonObject, profileId: string): string {
  if (!asString(profile.baseUrl) && !asString(profile.apiKeyEnv)) {
    return provider;
  }

  return profileId === provider ? `${provider}-legacy` : profileId;
}

function normalizeLegacyLlmProfile(profile: JsonObject, endpoints: JsonObject): JsonObject {
  const provider = asString(profile.provider);
  if (provider === "acp") {
    const id = asString(profile.id) ?? "acp";
    const model = asString(profile.model) ?? "default";
    return definedFields({
      ...stripKeys(profile, LEGACY_LLM_PROFILE_KEYS),
      kind: "session-agent",
      id,
      adapterId: asString(profile.adapterId) ?? model,
      model,
    });
  }

  if (provider) {
    const id = asString(profile.id) ?? provider;
    const model = asString(profile.model) ?? getDefaultEndpointModel(provider) ?? "default";
    const endpointId = legacyEndpointId(provider, profile, id);
    mergeEndpointOverride(
      endpoints,
      endpointId,
      buildLegacyEndpointOverride(provider, profile, model, endpointId),
    );

    return definedFields({
      ...stripKeys(profile, LEGACY_NATIVE_LLM_PROFILE_KEYS),
      kind: "native",
      id,
      endpointId,
      model,
    });
  }

  const kind = asString(profile.kind);
  const endpointId = asString(profile.endpointId);
  const model = asString(profile.model);
  if ((kind === "native" || (!kind && endpointId)) && endpointId && model) {
    mergeEndpointOverride(
      endpoints,
      endpointId,
      buildLegacyEndpointOverride(endpointId, profile, model, endpointId),
    );
    return stripKeys(profile, ["apiKeyEnv", "baseUrl", "contextWindowTokens"] as const);
  }

  return profile;
}

function normalizeLegacyRootLlmProfile(llm: JsonObject, endpoints: JsonObject): JsonObject {
  const provider = asString(llm.provider) ?? "anthropic";
  const id = asString(llm.defaultProfileId) ?? "default";
  const model = asString(llm.model) ?? getDefaultEndpointModel(provider) ?? "default";

  if (provider === "acp") {
    return definedFields({
      kind: "session-agent",
      id,
      adapterId: asString(llm.adapterId) ?? model,
      model,
      reasoningEffort: llm.reasoningEffort,
      thinking: llm.thinking,
    });
  }

  mergeEndpointOverride(
    endpoints,
    provider,
    buildLegacyEndpointOverride(provider, llm, model, provider),
  );
  return definedFields({
    kind: "native",
    id,
    endpointId: provider,
    model,
    reasoningEffort: llm.reasoningEffort,
    thinking: llm.thinking,
  });
}

function normalizeLegacyLlmConfig(config: JsonObject): JsonObject {
  const llm = asJsonObject(config.llm);
  if (!llm) {
    return config;
  }

  const endpoints = normalizeEndpointsForSchema(llm.endpoints);
  const rawProfiles = Array.isArray(llm.profiles) ? llm.profiles : [];
  let profiles = rawProfiles.map((profile) => {
    const profileObject = asJsonObject(profile);
    return profileObject ? normalizeLegacyLlmProfile(profileObject, endpoints) : profile;
  });

  let defaultProfileId = asString(llm.defaultProfileId);
  if (profiles.length === 0 && hasAnyKey(llm, LEGACY_LLM_ROOT_KEYS)) {
    const rootProfile = normalizeLegacyRootLlmProfile(llm, endpoints);
    profiles = [rootProfile];
    defaultProfileId = asString(rootProfile.id) ?? "default";
  }

  const nextLlm: JsonObject = {
    ...stripKeys(llm, LEGACY_LLM_ROOT_KEYS),
    endpoints,
    profiles,
  };
  if (defaultProfileId) {
    nextLlm.defaultProfileId = defaultProfileId;
  }

  return {
    ...config,
    llm: nextLlm,
  };
}

function rawLlmProfiles(config: JsonObject): JsonObject[] {
  const llm = asJsonObject(config.llm);
  const profiles = Array.isArray(llm?.profiles) ? llm.profiles : [];
  return profiles.flatMap((profile) => {
    const profileObject = asJsonObject(profile);
    return profileObject ? [profileObject] : [];
  });
}

function rawProfileId(profile: JsonObject): string | undefined {
  return asString(profile.id);
}

function isRawNativeProfile(profile: JsonObject): boolean {
  const kind = asString(profile.kind);
  return kind === undefined || kind === "native";
}

function selectRawNativeProfile(
  config: JsonObject,
  preferredProfileId?: string,
): JsonObject | undefined {
  const profiles = rawLlmProfiles(config).filter(isRawNativeProfile);
  const preferredProfile = preferredProfileId
    ? profiles.find((profile) => rawProfileId(profile) === preferredProfileId)
    : undefined;
  if (preferredProfile) {
    return preferredProfile;
  }

  const defaultProfileId = asString(asJsonObject(config.llm)?.defaultProfileId);
  const defaultProfile = defaultProfileId
    ? profiles.find((profile) => rawProfileId(profile) === defaultProfileId)
    : undefined;
  return defaultProfile ?? profiles[0];
}

function firstRawEndpointModel(config: JsonObject, endpointId: string): string | undefined {
  const llm = asJsonObject(config.llm);
  const endpoints = asJsonObject(llm?.endpoints);
  const endpoint = asJsonObject(endpoints?.[endpointId]);
  const models = asJsonObject(endpoint?.models);
  return models ? Object.keys(models)[0] : undefined;
}

function normalizeConfigInput(config: JsonObject): JsonObject {
  return normalizeLegacyLlmConfig(config);
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

  const endpointId = Bun.env.SLOPPY_LLM_ENDPOINT?.trim();
  const model = Bun.env.SLOPPY_MODEL?.trim();
  const profileId = Bun.env.SLOPPY_LLM_PROFILE?.trim();

  if (profileId) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      defaultProfileId: profileId,
    };
  }

  if (endpointId || model) {
    const runtimeProfileId = profileId ?? "runtime";
    const activeProfile = selectRawNativeProfile(config, profileId);
    const runtimeEndpointId = endpointId ?? asString(activeProfile?.endpointId) ?? "anthropic";
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      defaultProfileId: runtimeProfileId,
      profiles: [
        {
          kind: "native",
          id: runtimeProfileId,
          label: "Runtime Override",
          endpointId: runtimeEndpointId,
          model:
            model ??
            getDefaultEndpointModel(runtimeEndpointId) ??
            firstRawEndpointModel(config, runtimeEndpointId) ??
            "default",
        },
      ],
    };
  }

  if (Bun.env.SLOPPY_LLM_REASONING_EFFORT) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      reasoningEffort: Bun.env.SLOPPY_LLM_REASONING_EFFORT,
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

function normalizeLlmConfig(config: RawSloppyConfig["llm"]): LlmConfig {
  const endpoints = mergeLlmEndpoints(config.endpoints);
  const profiles = config.profiles.map((profile): AnyLlmProfileConfig => {
    if (profile.kind === "session-agent") {
      return profile;
    }

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
  };
}

function normalizeMcpServers(
  servers: RawSloppyConfig["plugins"]["mcp"]["servers"],
  filesystemRoot: string,
): RawSloppyConfig["plugins"]["mcp"]["servers"] {
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
      terminal: {
        ...config.plugins.terminal,
        cwd: terminalCwd,
      },
      filesystem: {
        ...config.plugins.filesystem,
        root: filesystemRoot,
        focus: filesystemFocus,
      },
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

  const normalizedInput = normalizeConfigInput(merged);
  const withEnv = applyEnvironmentOverrides(normalizedInput);
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
    plugins: {
      terminal: {
        cwd: scopeRoot,
      },
      filesystem: {
        root: scopeRoot,
        focus: scopeRoot,
      },
    },
  });
  const normalizedInput = normalizeConfigInput(scoped);
  const withEnv = applyEnvironmentOverrides(normalizedInput);
  const parsed = sloppyConfigSchema.parse(withEnv);

  return normalizeConfig(parsed, scopeRoot);
}

export async function loadConfig(): Promise<SloppyConfig> {
  return loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath());
}

export function createDefaultConfig(cwd = process.cwd()): SloppyConfig {
  return normalizeConfig(sloppyConfigSchema.parse({}), cwd);
}

export const defaultConfigPromise = loadConfig();
defaultConfigPromise.catch(() => undefined);

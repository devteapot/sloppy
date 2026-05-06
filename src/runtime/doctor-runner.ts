import { constants, type Dirent, existsSync, readFileSync } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { getHomeConfigPath, getWorkspaceConfigPath, loadConfigFromPaths } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import type { CredentialStore } from "../llm/credential-store";
import { LlmProfileManager } from "../llm/profile-manager";
import {
  readPersistedMetaState,
  writePersistedMetaState,
} from "../providers/builtin/meta-runtime-storage";
import { isWithinRoot, safeRealpath } from "../providers/builtin/path-containment";
import { loadPersistedSessionSnapshot, persistSessionSnapshot } from "../session/store/persistence";
import { AcpSessionAgent } from "./acp";

export type RuntimeDoctorCheck = {
  id: string;
  status: "ok" | "warning" | "error" | "skipped";
  summary: string;
  detail?: string;
};

export type RuntimeDoctorOptions = {
  workspaceRoot?: string;
  config?: SloppyConfig;
  litellmUrl?: string;
  acpAdapterId?: string;
  timeoutMs?: number;
  credentialStore?: CredentialStore;
  eventLogPath?: string;
  socketPath?: string;
  migratePersistence?: boolean;
};

export type RuntimeDoctorResult = {
  workspaceRoot: string;
  checks: RuntimeDoctorCheck[];
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isOpenAiCompatibleDoctorProvider(provider: SloppyConfig["llm"]["provider"]): boolean {
  return provider === "openai" || provider === "openrouter" || provider === "ollama";
}

async function loadDoctorConfig(
  workspaceRoot: string,
  config?: SloppyConfig,
): Promise<SloppyConfig> {
  if (config) {
    return config;
  }
  return loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath(workspaceRoot), {
    cwd: workspaceRoot,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function persistedSessionFormat(path: string): "current" | "legacy" {
  const parsed = readJson(path);
  if (isRecord(parsed) && parsed.kind === "sloppy.session.snapshot") {
    return "current";
  }
  return "legacy";
}

function persistedMetaStateFormat(path: string): "current" | "legacy" {
  const parsed = readJson(path);
  if (isRecord(parsed) && parsed.kind === "sloppy.meta-runtime.state") {
    return "current";
  }
  return "legacy";
}

function buildBackupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.legacy-${stamp}.bak`;
}

async function checkAuditLogPath(eventLogPath: string | undefined): Promise<RuntimeDoctorCheck> {
  const configuredPath = eventLogPath ?? process.env.SLOPPY_EVENT_LOG;
  if (!configuredPath) {
    return {
      id: "audit-log",
      status: "skipped",
      summary: "No runtime audit log path configured.",
    };
  }

  const path = resolve(configuredPath);
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    await handle.close();
    return {
      id: "audit-log",
      status: "ok",
      summary: `Runtime audit log is writable at ${path}.`,
    };
  } catch (error) {
    return {
      id: "audit-log",
      status: "error",
      summary: `Runtime audit log is not writable at ${path}.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkSocketPath(socketPath: string | undefined): Promise<RuntimeDoctorCheck> {
  if (!socketPath) {
    return {
      id: "session-socket",
      status: "skipped",
      summary: "No session or supervisor socket path provided.",
    };
  }

  const path = resolve(socketPath);
  const dir = dirname(path);
  try {
    try {
      const stats = await lstat(path);
      if (!stats.isSocket()) {
        return {
          id: "session-socket",
          status: "error",
          summary: `Socket path is blocked by a non-socket file at ${path}.`,
        };
      }
      return {
        id: "session-socket",
        status: "warning",
        summary: `Socket path already exists at ${path}.`,
        detail:
          "If this is a live session, choose another path. If it is stale, stop/start cleanup can remove it.",
      };
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(dir, { recursive: true });
    const probePath = join(dir, `.${basename(path)}.doctor-${crypto.randomUUID()}.tmp`);
    const handle = await open(probePath, "wx");
    await handle.close();
    await unlink(probePath);
    return {
      id: "session-socket",
      status: "ok",
      summary: `Session socket directory is writable for ${path}.`,
    };
  } catch (error) {
    return {
      id: "session-socket",
      status: "error",
      summary: `Session socket path is not usable at ${path}.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function assertDirectory(path: string, label: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return `${label} is not a directory: ${path}`;
    }
    return null;
  } catch (error) {
    return `${label} is not readable as a directory at ${path}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function expandDoctorCommandTemplate(value: string): string {
  return value.replaceAll("{model}", "");
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function resolveCommandPath(command: string, cwd: string): string {
  return isAbsolute(command) ? command : resolve(cwd, command);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command: string, cwd: string): Promise<string | null> {
  if (commandHasPathSeparator(command)) {
    const path = resolveCommandPath(command, cwd);
    return (await isExecutable(path)) ? path : null;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = resolve(pathEntry, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function checkWorkspacePaths(
  config: SloppyConfig,
  workspaceRoot: string,
): Promise<RuntimeDoctorCheck> {
  const filesystemRoot = resolve(workspaceRoot, config.providers.filesystem.root);
  const terminalCwd = resolve(workspaceRoot, config.providers.terminal.cwd);
  const errors: string[] = [];

  const filesystemError = await assertDirectory(filesystemRoot, "Filesystem root");
  if (filesystemError) {
    errors.push(filesystemError);
  }

  if (config.providers.builtin.terminal) {
    const terminalError = await assertDirectory(terminalCwd, "Terminal cwd");
    if (terminalError) {
      errors.push(terminalError);
    }

    const realFilesystemRoot = safeRealpath(filesystemRoot);
    if (!filesystemError && !terminalError && realFilesystemRoot) {
      if (!isWithinRoot(realFilesystemRoot, terminalCwd)) {
        errors.push(
          `Terminal cwd must stay inside the filesystem root. cwd=${terminalCwd} root=${filesystemRoot}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return {
      id: "workspace-paths",
      status: "error",
      summary: `${errors.length} workspace path check(s) failed.`,
      detail: errors.join("\n"),
    };
  }

  return {
    id: "workspace-paths",
    status: "ok",
    summary: config.providers.builtin.terminal
      ? `Filesystem root and terminal cwd are usable at ${filesystemRoot}.`
      : `Filesystem root is usable at ${filesystemRoot}.`,
    detail: config.providers.builtin.terminal ? `terminal_cwd=${terminalCwd}` : undefined,
  };
}

type SubprocessCommandProbe = {
  label: string;
  command: string;
  cwd: string;
};

function shouldMcpServerConnectOnStart(
  serverConnectOnStart: boolean | undefined,
  providerConnectOnStart: boolean,
): boolean {
  return serverConnectOnStart ?? providerConnectOnStart;
}

function collectSubprocessCommandProbes(
  config: SloppyConfig,
  workspaceRoot: string,
  adapterId: string | undefined,
): SubprocessCommandProbe[] {
  const probes: SubprocessCommandProbe[] = [];
  if (adapterId) {
    const acpConfig = config.providers.delegation.acp;
    const adapter = acpConfig?.enabled ? acpConfig.adapters[adapterId] : undefined;
    const rawCommand = adapter?.command[0];
    if (rawCommand) {
      probes.push({
        label: `acp:${adapterId}`,
        command: expandDoctorCommandTemplate(rawCommand),
        cwd: resolve(expandDoctorCommandTemplate(adapter.cwd ?? workspaceRoot)),
      });
    }
  }

  const mcpConfig = config.providers.mcp;
  if (config.providers.builtin.mcp && mcpConfig) {
    const providerConnectOnStart = mcpConfig.connectOnStart ?? true;
    const filesystemRoot = resolve(workspaceRoot, config.providers.filesystem.root);
    for (const [serverId, server] of Object.entries(mcpConfig.servers)) {
      if (server.transport !== "stdio") {
        continue;
      }
      if (!shouldMcpServerConnectOnStart(server.connectOnStart, providerConnectOnStart)) {
        continue;
      }

      const rawCommand = server.command[0];
      if (rawCommand) {
        probes.push({
          label: `mcp:${serverId}`,
          command: rawCommand,
          cwd: resolve(filesystemRoot, server.cwd ?? "."),
        });
      }
    }
  }

  return probes;
}

async function checkSubprocessCommands(
  config: SloppyConfig,
  workspaceRoot: string,
  adapterId: string | undefined,
): Promise<RuntimeDoctorCheck> {
  const probes = collectSubprocessCommandProbes(config, workspaceRoot, adapterId);
  if (probes.length === 0) {
    return {
      id: "subprocess-commands",
      status: "skipped",
      summary: "No startup subprocess commands are configured.",
    };
  }

  const errors: string[] = [];
  const details: string[] = [];
  for (const probe of probes) {
    const command = probe.command.trim();
    if (!command) {
      errors.push(`${probe.label}: command is empty after template expansion.`);
      continue;
    }

    const executable = await findExecutable(command, probe.cwd);
    if (!executable) {
      errors.push(`${probe.label}: command '${command}' is not executable from cwd ${probe.cwd}.`);
      continue;
    }

    details.push(`${probe.label} -> ${executable}`);
  }

  if (errors.length > 0) {
    return {
      id: "subprocess-commands",
      status: "error",
      summary: `${errors.length} startup subprocess command(s) are missing or not executable.`,
      detail: [...errors, ...details].join("\n"),
    };
  }

  return {
    id: "subprocess-commands",
    status: "ok",
    summary: `${details.length} startup subprocess command(s) are executable.`,
    detail: details.join("\n"),
  };
}

function describeProfileSource(keySource: string | undefined): string {
  switch (keySource) {
    case "secure_store":
      return "stored credentials";
    case "env":
      return "process environment credentials";
    case "not_required":
      return "no API key";
    case "external_auth":
      return "external auth";
    case "missing":
      return "missing credentials";
    default:
      return "unknown credentials";
  }
}

async function checkLlmProfile(
  config: SloppyConfig,
  credentialStore?: CredentialStore,
): Promise<RuntimeDoctorCheck> {
  const manager = new LlmProfileManager({
    config,
    credentialStore,
    writeConfig: async () => undefined,
  });
  const state = await manager.getState();
  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);
  const profileDetails = state.profiles.map((profile) =>
    [
      profile.isDefault ? "*" : "-",
      profile.id,
      `${profile.provider}/${profile.model}`,
      `origin=${profile.origin}`,
      `source=${profile.keySource}`,
      `ready=${profile.ready}`,
      profile.invalidReason ? `invalid=${profile.invalidReason}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  const detail = [
    `secure_store=${state.secureStoreKind}/${state.secureStoreStatus}`,
    ...profileDetails,
  ].join("\n");

  if (!activeProfile || state.status !== "ready") {
    return {
      id: "llm-profile",
      status: "error",
      summary: `No ready LLM profile is available. ${state.message}`,
      detail,
    };
  }

  const source = describeProfileSource(activeProfile.keySource);
  if (activeProfile.keySource === "env") {
    return {
      id: "llm-profile",
      status: "warning",
      summary: `Active LLM profile '${activeProfile.id}' is ready using ${source}.`,
      detail: [
        detail,
        "Environment credentials are process-scoped; use managed profiles with secure storage for long-running services when practical.",
      ].join("\n"),
    };
  }

  return {
    id: "llm-profile",
    status: "ok",
    summary: `Active LLM profile '${activeProfile.id}' is ready using ${source}.`,
    detail,
  };
}

async function checkSessionPersistence(
  config: SloppyConfig,
  workspaceRoot: string,
  migratePersistence: boolean,
): Promise<RuntimeDoctorCheck> {
  if (config.session?.persistSnapshots !== true) {
    return {
      id: "session-persistence",
      status: "skipped",
      summary: "Session snapshot persistence is disabled.",
    };
  }

  const dir = resolve(
    workspaceRoot,
    config.providers.filesystem.root,
    config.session.persistenceDir ?? ".sloppy/sessions",
  );
  if (!existsSync(dir)) {
    return {
      id: "session-persistence",
      status: "ok",
      summary: `No session snapshots found at ${dir}; the directory will be created on first write.`,
    };
  }

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return {
      id: "session-persistence",
      status: "error",
      summary: `Could not read session snapshot directory at ${dir}.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const snapshotPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
  if (snapshotPaths.length === 0) {
    return {
      id: "session-persistence",
      status: "ok",
      summary: `No session snapshot files found at ${dir}.`,
    };
  }

  const errors: string[] = [];
  const legacyPaths: string[] = [];
  for (const path of snapshotPaths) {
    try {
      loadPersistedSessionSnapshot(path);
      if (persistedSessionFormat(path) === "legacy") {
        legacyPaths.push(path);
      }
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length > 0) {
    return {
      id: "session-persistence",
      status: "error",
      summary: `${errors.length} persisted session snapshot file(s) could not be loaded.`,
      detail: errors.join("\n"),
    };
  }
  if (legacyPaths.length > 0 && migratePersistence) {
    const backups: string[] = [];
    try {
      for (const path of legacyPaths) {
        const snapshot = loadPersistedSessionSnapshot(path);
        if (!snapshot) {
          throw new Error(`Snapshot disappeared before migration: ${path}`);
        }
        const backupPath = buildBackupPath(path);
        await copyFile(path, backupPath);
        persistSessionSnapshot(path, snapshot);
        backups.push(`${path} backup=${backupPath}`);
      }
    } catch (error) {
      return {
        id: "session-persistence",
        status: "error",
        summary: "Could not migrate legacy session snapshot files.",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      id: "session-persistence",
      status: "ok",
      summary: `${legacyPaths.length} legacy session snapshot file(s) were migrated to the current schema envelope.`,
      detail: backups.join("\n"),
    };
  }

  if (legacyPaths.length > 0) {
    return {
      id: "session-persistence",
      status: "warning",
      summary: `${legacyPaths.length} of ${snapshotPaths.length} session snapshot file(s) use the legacy raw format.`,
      detail:
        "They are still accepted. Run runtime:doctor with --migrate-persistence to rewrite them with backups.",
    };
  }

  return {
    id: "session-persistence",
    status: "ok",
    summary: `${snapshotPaths.length} persisted session snapshot file(s) use the current schema envelope.`,
  };
}

async function checkMetaRuntimePersistence(
  config: SloppyConfig,
  migratePersistence: boolean,
): Promise<RuntimeDoctorCheck> {
  const paths = [
    join(config.providers.metaRuntime.globalRoot, "state.json"),
    join(config.providers.metaRuntime.workspaceRoot, "state.json"),
  ];
  const existingPaths = paths.filter((path) => existsSync(path));
  if (existingPaths.length === 0) {
    return {
      id: "meta-runtime-persistence",
      status: config.providers.builtin.metaRuntime ? "ok" : "skipped",
      summary: config.providers.builtin.metaRuntime
        ? "No persisted meta-runtime state files found; they will be created on first write."
        : "Meta-runtime is disabled and no persisted state files were found.",
    };
  }

  const errors: string[] = [];
  const legacyPaths: string[] = [];
  for (const path of existingPaths) {
    try {
      readPersistedMetaState(dirname(path));
      if (persistedMetaStateFormat(path) === "legacy") {
        legacyPaths.push(path);
      }
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
  if (legacyPaths.length > 0 && migratePersistence) {
    const backups: string[] = [];
    try {
      for (const path of legacyPaths) {
        const root = dirname(path);
        const state = readPersistedMetaState(root);
        const backupPath = buildBackupPath(path);
        await copyFile(path, backupPath);
        writePersistedMetaState(root, state);
        backups.push(`${path} backup=${backupPath}`);
      }
    } catch (error) {
      return {
        id: "meta-runtime-persistence",
        status: "error",
        summary: "Could not migrate legacy meta-runtime state files.",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      id: "meta-runtime-persistence",
      status: "ok",
      summary: `${legacyPaths.length} legacy meta-runtime state file(s) were migrated to the current schema envelope.`,
      detail: backups.join("\n"),
    };
  }

  if (legacyPaths.length > 0) {
    return {
      id: "meta-runtime-persistence",
      status: "warning",
      summary: `${legacyPaths.length} of ${existingPaths.length} meta-runtime state file(s) use the legacy raw format.`,
      detail:
        "They are still accepted. Run runtime:doctor with --migrate-persistence to rewrite them with backups.",
    };
  }

  return {
    id: "meta-runtime-persistence",
    status: "ok",
    summary: `${existingPaths.length} persisted meta-runtime state file(s) use the current schema envelope.`,
  };
}

async function checkOpenAiCompatibleUrl(
  baseUrl: string | undefined,
  timeoutMs: number,
  apiKeyEnv?: string,
): Promise<RuntimeDoctorCheck> {
  if (!baseUrl) {
    return {
      id: "litellm",
      status: "skipped",
      summary: "No OpenAI-compatible base URL provided.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${trimTrailingSlash(baseUrl)}/models`;
  const apiKey = apiKeyEnv ? Bun.env[apiKeyEnv] : undefined;
  const headers: HeadersInit = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return {
        id: "litellm",
        status: "error",
        summary: `Router responded with HTTP ${response.status}.`,
        detail: [
          text.slice(0, 1000),
          apiKeyEnv && !apiKey
            ? `No API key found in ${apiKeyEnv}; request was unauthenticated.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      id: "litellm",
      status: "ok",
      summary: apiKeyEnv
        ? `Router responded at ${url}${apiKey ? ` using ${apiKeyEnv}.` : " without an API key."}`
        : `Router responded at ${url}.`,
      detail: text.slice(0, 1000),
    };
  } catch (error) {
    return {
      id: "litellm",
      status: "error",
      summary: `Could not reach router at ${url}.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAcpAdapter(
  config: SloppyConfig,
  workspaceRoot: string,
  adapterId: string | undefined,
  timeoutMs: number,
): Promise<RuntimeDoctorCheck> {
  if (!adapterId) {
    return {
      id: "acp",
      status: "skipped",
      summary: "No ACP adapter id provided.",
    };
  }

  const acpConfig = config.providers.delegation.acp;
  const adapter = acpConfig?.adapters[adapterId];
  if (!acpConfig?.enabled || !adapter) {
    return {
      id: "acp",
      status: "error",
      summary: `ACP adapter '${adapterId}' is not enabled or configured.`,
    };
  }

  const command = expandDoctorCommandTemplate(adapter.command[0] ?? "").trim();
  const cwd = resolve(expandDoctorCommandTemplate(adapter.cwd ?? workspaceRoot));
  if (!command || !(await findExecutable(command, cwd))) {
    return {
      id: "acp",
      status: "error",
      summary: `ACP adapter '${adapterId}' command is not executable.`,
      detail: command
        ? `command='${command}' cwd=${cwd}`
        : "Adapter command is empty after template expansion.",
    };
  }

  const agent = new AcpSessionAgent({
    adapterId,
    adapter: { ...adapter, timeoutMs: adapter.timeoutMs ?? timeoutMs },
    callbacks: {},
    workspaceRoot,
    defaultTimeoutMs: timeoutMs,
  });
  try {
    await agent.start();
    return {
      id: "acp",
      status: "ok",
      summary: `ACP adapter '${adapterId}' completed startup.`,
    };
  } catch (error) {
    return {
      id: "acp",
      status: "error",
      summary: `ACP adapter '${adapterId}' failed startup.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    agent.shutdown();
  }
}

function checkAcpBoundary(config: SloppyConfig, adapterId: string | undefined): RuntimeDoctorCheck {
  if (!adapterId) {
    return {
      id: "acp-boundary",
      status: "skipped",
      summary: "No ACP adapter id provided.",
    };
  }

  const adapter = config.providers.delegation.acp?.adapters[adapterId];
  if (!adapter) {
    return {
      id: "acp-boundary",
      status: "skipped",
      summary: `ACP adapter '${adapterId}' is not configured.`,
    };
  }

  const notes: string[] = [];
  if (adapter.inheritEnv === true) {
    notes.push("inherits the full Sloppy process environment");
  }
  if (adapter.allowCwdOutsideWorkspace === true) {
    notes.push("can launch outside the workspace root");
  }
  if (!adapter.capabilities) {
    notes.push("has no declared adapter capabilities");
  }

  if (notes.length > 0) {
    return {
      id: "acp-boundary",
      status: "warning",
      summary: `ACP adapter '${adapterId}' ${notes.join(" and ")}.`,
      detail:
        "ACP capability declarations and environment filtering are runtime guardrails, not an OS sandbox. Use a separate OS sandbox/container for untrusted adapters.",
    };
  }

  return {
    id: "acp-boundary",
    status: "ok",
    summary: `ACP adapter '${adapterId}' uses Sloppy's minimal environment boundary and declares capabilities.`,
    detail:
      "This does not sandbox local filesystem or network access by itself; it only constrains Sloppy-exposed provider routing and ambient environment inheritance.",
  };
}

export async function runRuntimeDoctor(
  options: RuntimeDoctorOptions = {},
): Promise<RuntimeDoctorResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const config = await loadDoctorConfig(workspaceRoot, options.config);
  const timeoutMs = options.timeoutMs ?? 5000;
  const migratePersistence = options.migratePersistence ?? false;
  const litellmUrl =
    options.litellmUrl ??
    (isOpenAiCompatibleDoctorProvider(config.llm.provider) ? config.llm.baseUrl : undefined);

  const checks = await Promise.all([
    checkLlmProfile(config, options.credentialStore),
    checkWorkspacePaths(config, workspaceRoot),
    checkSubprocessCommands(config, workspaceRoot, options.acpAdapterId),
    checkAuditLogPath(options.eventLogPath),
    checkSocketPath(options.socketPath),
    checkOpenAiCompatibleUrl(litellmUrl, timeoutMs, config.llm.apiKeyEnv),
    checkAcpAdapter(config, workspaceRoot, options.acpAdapterId, timeoutMs),
    checkSessionPersistence(config, workspaceRoot, migratePersistence),
  ]);
  checks.push(checkAcpBoundary(config, options.acpAdapterId));
  checks.push(await checkMetaRuntimePersistence(config, migratePersistence));

  return {
    workspaceRoot,
    checks,
  };
}

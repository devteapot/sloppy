import { type Dirent, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { getHomeConfigPath, getWorkspaceConfigPath, loadConfigFromPaths } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import type { CredentialStore } from "../llm/credential-store";
import { LlmProfileManager } from "../llm/profile-manager";
import {
  createFirstPartyDoctorChecks,
  createFirstPartyDoctorSubprocessProbes,
} from "../plugins/first-party/catalog";
import { loadPersistedSessionSnapshot } from "../session/store/persistence";
import { findExecutable } from "./doctor-helpers";
import type {
  RuntimeDoctorCheck,
  RuntimeDoctorContext,
  RuntimeDoctorOptions,
  RuntimeDoctorResult,
  RuntimeDoctorSubprocessProbe,
} from "./doctor-types";

export type { RuntimeDoctorCheck, RuntimeDoctorOptions, RuntimeDoctorResult } from "./doctor-types";

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

async function checkSubprocessCommands(
  probes: RuntimeDoctorSubprocessProbe[],
): Promise<RuntimeDoctorCheck> {
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
    config.plugins.filesystem.root,
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
  for (const path of snapshotPaths) {
    try {
      loadPersistedSessionSnapshot(path);
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

  return {
    id: "session-persistence",
    status: "ok",
    summary: `${snapshotPaths.length} persisted session snapshot file(s) use the current schema envelope.`,
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

export async function runRuntimeDoctor(
  options: RuntimeDoctorOptions = {},
): Promise<RuntimeDoctorResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const config = await loadDoctorConfig(workspaceRoot, options.config);
  const timeoutMs = options.timeoutMs ?? 5000;
  const litellmUrl =
    options.litellmUrl ??
    (isOpenAiCompatibleDoctorProvider(config.llm.provider) ? config.llm.baseUrl : undefined);
  const context: RuntimeDoctorContext = {
    config,
    workspaceRoot,
    options,
    timeoutMs,
  };
  const subprocessProbeLists = await Promise.all(
    createFirstPartyDoctorSubprocessProbes(config).map((factory) => factory(context)),
  );
  const subprocessProbes = subprocessProbeLists.flat();

  const checks = await Promise.all([
    checkLlmProfile(config, options.credentialStore),
    checkAuditLogPath(options.eventLogPath),
    checkSocketPath(options.socketPath),
    checkOpenAiCompatibleUrl(litellmUrl, timeoutMs, config.llm.apiKeyEnv),
    checkSessionPersistence(config, workspaceRoot),
  ]);
  checks.push(await checkSubprocessCommands(subprocessProbes));
  checks.push(
    ...(await Promise.all(createFirstPartyDoctorChecks(config).map((factory) => factory(context)))),
  );

  return {
    workspaceRoot,
    checks,
  };
}

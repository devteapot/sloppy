import { resolve } from "node:path";

import { getHomeConfigPath, getWorkspaceConfigPath, loadConfigFromPaths } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { AcpSessionAgent } from "./acp";
import { CliSessionAgent } from "./cli";

export type RuntimeDoctorCheck = {
  id: string;
  status: "ok" | "error" | "skipped";
  summary: string;
  detail?: string;
};

export type RuntimeDoctorOptions = {
  workspaceRoot?: string;
  config?: SloppyConfig;
  litellmUrl?: string;
  acpAdapterId?: string;
  cliAdapterId?: string;
  timeoutMs?: number;
};

export type RuntimeDoctorResult = {
  workspaceRoot: string;
  checks: RuntimeDoctorCheck[];
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function loadDoctorConfig(
  workspaceRoot: string,
  config?: SloppyConfig,
): Promise<SloppyConfig> {
  if (config) {
    return config;
  }
  return loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath(workspaceRoot));
}

async function checkOpenAiCompatibleUrl(
  baseUrl: string | undefined,
  timeoutMs: number,
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
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return {
        id: "litellm",
        status: "error",
        summary: `Router responded with HTTP ${response.status}.`,
        detail: text.slice(0, 1000),
      };
    }
    return {
      id: "litellm",
      status: "ok",
      summary: `Router responded at ${url}.`,
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

async function checkCliAdapter(
  config: SloppyConfig,
  workspaceRoot: string,
  adapterId: string | undefined,
  timeoutMs: number,
): Promise<RuntimeDoctorCheck> {
  if (!adapterId) {
    return {
      id: "cli",
      status: "skipped",
      summary: "No CLI adapter id provided.",
    };
  }

  const cliConfig = config.providers.delegation.cli;
  const adapter = cliConfig?.adapters[adapterId];
  if (!cliConfig?.enabled || !adapter) {
    return {
      id: "cli",
      status: "error",
      summary: `CLI adapter '${adapterId}' is not enabled or configured.`,
    };
  }

  const agent = new CliSessionAgent({
    adapterId,
    adapter: { ...adapter, timeoutMs: adapter.timeoutMs ?? timeoutMs },
    callbacks: {},
    workspaceRoot,
    defaultTimeoutMs: timeoutMs,
  });
  try {
    await agent.start();
    return {
      id: "cli",
      status: "ok",
      summary: `CLI adapter '${adapterId}' command is configured.`,
    };
  } catch (error) {
    return {
      id: "cli",
      status: "error",
      summary: `CLI adapter '${adapterId}' failed startup.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    agent.shutdown();
  }
}

export async function runRuntimeDoctor(
  options: RuntimeDoctorOptions = {},
): Promise<RuntimeDoctorResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const config = await loadDoctorConfig(workspaceRoot, options.config);
  const timeoutMs = options.timeoutMs ?? 5000;
  const litellmUrl = options.litellmUrl;

  const checks = await Promise.all([
    checkOpenAiCompatibleUrl(litellmUrl, timeoutMs),
    checkAcpAdapter(config, workspaceRoot, options.acpAdapterId, timeoutMs),
    checkCliAdapter(config, workspaceRoot, options.cliAdapterId, timeoutMs),
  ]);

  return {
    workspaceRoot,
    checks,
  };
}

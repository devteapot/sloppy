import { resolve } from "node:path";

import { getHomeConfigPath, getWorkspaceConfigPath, loadConfigFromPaths } from "../config/load";
import type { SloppyConfig } from "../config/schema";
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
  return loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath(workspaceRoot));
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
  const litellmUrl =
    options.litellmUrl ??
    (isOpenAiCompatibleDoctorProvider(config.llm.provider) ? config.llm.baseUrl : undefined);

  const checks = await Promise.all([
    checkOpenAiCompatibleUrl(litellmUrl, timeoutMs, config.llm.apiKeyEnv),
    checkAcpAdapter(config, workspaceRoot, options.acpAdapterId, timeoutMs),
  ]);
  checks.push(checkAcpBoundary(config, options.acpAdapterId));

  return {
    workspaceRoot,
    checks,
  };
}

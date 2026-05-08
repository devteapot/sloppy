import { resolve } from "node:path";
import { AcpSessionAgent } from "../../../runtime/acp";
import { expandDoctorCommandTemplate, findExecutable } from "../../../runtime/doctor-helpers";
import type {
  RuntimeDoctorCheck,
  RuntimeDoctorContext,
  RuntimeDoctorSubprocessProbe,
} from "../../../runtime/doctor-types";

export function collectAcpSubprocessProbes({
  config,
  workspaceRoot,
  options,
}: RuntimeDoctorContext): RuntimeDoctorSubprocessProbe[] {
  const adapterId = options.acpAdapterId;
  if (!adapterId) {
    return [];
  }

  const acpConfig = config.plugins.delegation.acp;
  const adapter = acpConfig?.enabled ? acpConfig.adapters[adapterId] : undefined;
  const rawCommand = adapter?.command[0];
  if (!rawCommand) {
    return [];
  }

  return [
    {
      label: `acp:${adapterId}`,
      command: expandDoctorCommandTemplate(rawCommand),
      cwd: resolve(expandDoctorCommandTemplate(adapter.cwd ?? workspaceRoot)),
    },
  ];
}

export async function checkAcpAdapter({
  config,
  workspaceRoot,
  options,
  timeoutMs,
}: RuntimeDoctorContext): Promise<RuntimeDoctorCheck> {
  const adapterId = options.acpAdapterId;
  if (!adapterId) {
    return {
      id: "acp",
      status: "skipped",
      summary: "No ACP adapter id provided.",
    };
  }

  const acpConfig = config.plugins.delegation.acp;
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

export function checkAcpBoundary({ config, options }: RuntimeDoctorContext): RuntimeDoctorCheck {
  const adapterId = options.acpAdapterId;
  if (!adapterId) {
    return {
      id: "acp-boundary",
      status: "skipped",
      summary: "No ACP adapter id provided.",
    };
  }

  const adapter = config.plugins.delegation.acp?.adapters[adapterId];
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

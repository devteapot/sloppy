import { resolve } from "node:path";

import type {
  RuntimeDoctorCheck,
  RuntimeDoctorContext,
  RuntimeDoctorSubprocessProbe,
} from "../../../runtime/doctor-types";

export function checkMcpEnvironmentExposure({ config }: RuntimeDoctorContext): RuntimeDoctorCheck {
  const mcpConfig = config.plugins.mcp;
  if (!mcpConfig.enabled) {
    return {
      id: "mcp-environment-exposure",
      status: "skipped",
      summary: "MCP plugin disabled.",
    };
  }

  const exposed = Object.entries(mcpConfig.servers)
    .filter(
      ([, server]) =>
        server.transport === "stdio" && server.inheritEnv === true && !server.envAllowlist?.length,
    )
    .map(([serverId]) => serverId);

  if (exposed.length > 0) {
    return {
      id: "mcp-environment-exposure",
      status: "warning",
      summary: `MCP server(s) inherit the full environment: ${exposed.join(", ")}.`,
      detail:
        "inheritEnv: true passes every environment variable (including shell secrets) to the server subprocess. Prefer envAllowlist with the specific variables the server needs.",
    };
  }

  return {
    id: "mcp-environment-exposure",
    status: "ok",
    summary: "No MCP server inherits the full environment without an allowlist.",
  };
}

function shouldMcpServerConnectOnStart(
  serverConnectOnStart: boolean | undefined,
  providerConnectOnStart: boolean,
): boolean {
  return serverConnectOnStart ?? providerConnectOnStart;
}

export function collectMcpSubprocessProbes({
  config,
  workspaceRoot,
}: RuntimeDoctorContext): RuntimeDoctorSubprocessProbe[] {
  const mcpConfig = config.plugins.mcp;
  if (!config.plugins.mcp.enabled || !mcpConfig) {
    return [];
  }

  const probes: RuntimeDoctorSubprocessProbe[] = [];
  const providerConnectOnStart = mcpConfig.connectOnStart ?? true;
  const filesystemRoot = resolve(workspaceRoot, config.plugins.filesystem.root);
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

  return probes;
}

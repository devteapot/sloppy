import { resolve } from "node:path";

import type {
  RuntimeDoctorContext,
  RuntimeDoctorSubprocessProbe,
} from "../../../runtime/doctor-types";

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

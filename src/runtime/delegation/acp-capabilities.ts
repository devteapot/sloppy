import type { SloppyConfig } from "../../config/schema";
import type { RuntimeCapabilityMask } from "../../core/capability-policy";
import { LlmConfigurationError } from "../../llm/profile-manager";

type AcpAdapterConfig = NonNullable<
  NonNullable<SloppyConfig["providers"]["delegation"]["acp"]>["adapters"][string]
>;

type AcpAdapterCapabilities = NonNullable<AcpAdapterConfig["capabilities"]>;

type CapabilityFlag = keyof AcpAdapterCapabilities;

const ALL_FLAGS: CapabilityFlag[] = [
  "spawn_allowed",
  "shell_allowed",
  "network_allowed",
  "filesystem_reads_allowed",
  "filesystem_writes_allowed",
];

const FILESYSTEM_READ_ACTIONS = new Set([
  "focus",
  "focus_parent",
  "list",
  "read",
  "search",
  "set_focus",
]);

const FILESYSTEM_WRITE_ACTIONS = new Set(["edit", "mkdir", "write"]);

function describeMask(mask: RuntimeCapabilityMask): string {
  const provider = mask.provider ?? "*";
  const actions = mask.actions?.join(",") ?? "*";
  return `${mask.id} (${provider}:${actions})`;
}

function requiredFlagsForFilesystem(mask: RuntimeCapabilityMask): CapabilityFlag[] {
  if (!mask.actions || mask.actions.length === 0) {
    return ["filesystem_reads_allowed", "filesystem_writes_allowed"];
  }

  const required = new Set<CapabilityFlag>();
  for (const action of mask.actions) {
    if (FILESYSTEM_READ_ACTIONS.has(action)) {
      required.add("filesystem_reads_allowed");
      continue;
    }
    if (FILESYSTEM_WRITE_ACTIONS.has(action)) {
      required.add("filesystem_writes_allowed");
      continue;
    }
    required.add("filesystem_writes_allowed");
  }

  return [...required];
}

function requiredFlagsForMask(mask: RuntimeCapabilityMask): CapabilityFlag[] {
  if (!mask.provider || mask.provider === "*") {
    return ALL_FLAGS;
  }

  switch (mask.provider) {
    case "delegation":
      return ["spawn_allowed"];
    case "terminal":
      return ["shell_allowed"];
    case "browser":
    case "web":
      return ["network_allowed"];
    case "filesystem":
      return requiredFlagsForFilesystem(mask);
    default:
      throw new LlmConfigurationError(
        `ACP capability mask ${describeMask(mask)} targets provider '${mask.provider}', which cannot be mapped to adapter capabilities.`,
      );
  }
}

function missingFlags(
  capabilities: AcpAdapterCapabilities,
  requiredFlags: CapabilityFlag[],
): CapabilityFlag[] {
  return requiredFlags.filter((flag) => capabilities[flag] !== true);
}

export function assertAcpSpawnAllowed(options: {
  adapterId: string;
  adapter: AcpAdapterConfig;
  capabilityMasks?: RuntimeCapabilityMask[];
  routeEnvelope?: unknown;
}): void {
  const masks = options.capabilityMasks ?? [];
  const allowMasks = masks.filter((mask) => mask.mode === "allow");
  const routed = options.routeEnvelope !== undefined && options.routeEnvelope !== null;

  if (!routed && allowMasks.length === 0) {
    return;
  }

  const capabilities = options.adapter.capabilities;
  if (!capabilities) {
    throw new LlmConfigurationError(
      `ACP adapter '${options.adapterId}' has no capabilities declaration. Routed or allow-masked ACP spawns require providers.delegation.acp.adapters.${options.adapterId}.capabilities.`,
    );
  }

  const effectiveAllowMasks: RuntimeCapabilityMask[] =
    allowMasks.length > 0 ? allowMasks : [{ id: "implicit-routed-acp-surface", mode: "allow" }];

  for (const mask of effectiveAllowMasks) {
    const requiredFlags = requiredFlagsForMask(mask);
    const missing = missingFlags(capabilities, requiredFlags);
    if (missing.length > 0) {
      throw new LlmConfigurationError(
        `ACP adapter '${options.adapterId}' does not satisfy capability mask ${describeMask(
          mask,
        )}. Missing adapter capabilities: ${missing.join(", ")}.`,
      );
    }
  }
}

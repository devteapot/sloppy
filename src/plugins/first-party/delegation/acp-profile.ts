import type { SloppyConfig } from "../../../config/schema";
import type { AgentCallbacks } from "../../../core/agent";
import { LlmConfigurationError, type LlmProfileState } from "../../../llm/profile-manager";
import { AcpSessionAgent } from "../../../runtime/acp";
import type { SessionAgent } from "../../../session/runtime";

function adapterIdFor(profile: LlmProfileState): string {
  return profile.adapterId?.trim() || profile.model;
}

function adapterFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function acpProfileFingerprint(
  config: SloppyConfig,
  profile: LlmProfileState,
  modelOverride?: string,
): string | null {
  if (profile.provider !== "acp") {
    return null;
  }
  const adapterId = adapterIdFor(profile);
  const adapter = config.plugins.delegation.acp?.adapters[adapterId];
  return [
    profile.provider,
    profile.id,
    adapterId,
    modelOverride ?? profile.model,
    config.plugins.delegation.acp?.defaultTimeoutMs ?? "",
    adapterFingerprint(adapter),
  ].join(":");
}

export function createAcpProfileSessionAgent(options: {
  config: SloppyConfig;
  profile: LlmProfileState;
  modelOverride?: string;
  callbacks: AgentCallbacks;
}): SessionAgent | null {
  if (options.profile.provider !== "acp") {
    return null;
  }

  const adapterId = adapterIdFor(options.profile);
  const acpConfig = options.config.plugins.delegation.acp;
  if (!acpConfig?.enabled) {
    throw new LlmConfigurationError(
      `ACP adapter profile '${options.profile.id}' requires plugins.delegation.acp.enabled to be true.`,
    );
  }
  const adapter = acpConfig.adapters[adapterId];
  if (!adapter) {
    throw new LlmConfigurationError(
      `ACP adapter profile '${options.profile.id}' references unknown adapter '${adapterId}'.`,
    );
  }
  return new AcpSessionAgent({
    adapterId,
    adapter,
    modelOverride: options.modelOverride ?? options.profile.model,
    callbacks: options.callbacks,
    workspaceRoot: options.config.plugins.filesystem.root,
    defaultTimeoutMs: acpConfig.defaultTimeoutMs,
  });
}

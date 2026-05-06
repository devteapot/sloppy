import type { SloppyConfig } from "../../config/schema";
import { LlmConfigurationError } from "../../llm/profile-manager";
import type { ExecutorBinding } from "./executor-binding";

type AcpAdapterConfig = NonNullable<
  NonNullable<SloppyConfig["providers"]["delegation"]["acp"]>["adapters"][string]
>;

type CliAdapterConfig = NonNullable<
  NonNullable<SloppyConfig["providers"]["delegation"]["cli"]>["adapters"][string]
>;

export type ResolvedExecutor =
  | {
      kind: "llm";
      profileId?: string;
      modelOverride?: string;
    }
  | {
      kind: "acp";
      adapterId: string;
      adapter: AcpAdapterConfig;
      timeoutMs?: number;
      defaultTimeoutMs?: number;
    }
  | {
      kind: "cli";
      adapterId: string;
      adapter: CliAdapterConfig;
      timeoutMs?: number;
      defaultTimeoutMs?: number;
    };

export class ExecutorResolver {
  private config: SloppyConfig;

  constructor(options: { config: SloppyConfig }) {
    this.config = options.config;
  }

  updateConfig(config: SloppyConfig): void {
    this.config = config;
  }

  resolve(binding: ExecutorBinding | undefined): ResolvedExecutor {
    if (!binding) {
      // Phase A: undefined binding falls back to the LlmProfileManager's
      // configured default (session/global). No implicit ACP default.
      return { kind: "llm" };
    }

    if (binding.kind === "llm") {
      this.assertLlmProfileExists(binding.profileId);
      return {
        kind: "llm",
        profileId: binding.profileId,
        modelOverride: binding.modelOverride,
      };
    }

    if (binding.kind === "cli") {
      const cliConfig = this.config.providers.delegation.cli;
      if (!cliConfig?.enabled) {
        throw new LlmConfigurationError(
          `CLI delegation adapter '${binding.adapterId}' requested but providers.delegation.cli.enabled is false.`,
        );
      }
      const adapter = cliConfig.adapters[binding.adapterId];
      if (!adapter) {
        throw new LlmConfigurationError(
          `CLI delegation adapter '${binding.adapterId}' is not configured.`,
        );
      }
      return {
        kind: "cli",
        adapterId: binding.adapterId,
        adapter,
        timeoutMs: binding.timeoutMs,
        defaultTimeoutMs: cliConfig.defaultTimeoutMs,
      };
    }

    const acpConfig = this.config.providers.delegation.acp;
    if (!acpConfig?.enabled) {
      throw new LlmConfigurationError(
        `ACP delegation adapter '${binding.adapterId}' requested but providers.delegation.acp.enabled is false.`,
      );
    }
    const adapter = acpConfig.adapters[binding.adapterId];
    if (!adapter) {
      throw new LlmConfigurationError(
        `ACP delegation adapter '${binding.adapterId}' is not configured.`,
      );
    }
    return {
      kind: "acp",
      adapterId: binding.adapterId,
      adapter,
      timeoutMs: binding.timeoutMs,
      defaultTimeoutMs: acpConfig.defaultTimeoutMs,
    };
  }

  private assertLlmProfileExists(profileId: string): void {
    const found = this.config.llm.profiles.some((profile) => profile.id === profileId);
    if (!found) {
      throw new LlmConfigurationError(
        `LLM profile '${profileId}' is not configured. Add it under llm.profiles or pick another id.`,
      );
    }
  }
}

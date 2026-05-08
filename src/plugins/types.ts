import type { ClientTransport } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { ProviderRuntimeHub } from "../core/hub";
import type { InvokePolicy } from "../core/policy";
import type { RuntimeContext } from "../core/role";
import type { ProviderApprovalManager } from "../providers/approvals";
import type { RegisteredProvider } from "../providers/registry";
import type {
  RuntimeDoctorCheckFactory,
  RuntimeDoctorSubprocessProbeFactory,
} from "../runtime/doctor-types";
import type { ToolEventEnricher } from "../session/event-bus";
import type { SessionRuntimePlugin, TuiContributionManifest } from "../session/plugins";

export type PluginProviderContribution = {
  id: string;
  name: string;
  transport: ClientTransport;
  transportLabel: string;
  stop?: () => void;
  systemPromptFragment?: (config: SloppyConfig) => string | null;
  attachRuntime?: (
    hub: ProviderRuntimeHub,
    config: SloppyConfig,
    ctx?: RuntimeContext,
  ) => { stop(): void } | undefined;
  approvals?: ProviderApprovalManager;
};

export type FirstPartyPluginDescriptor = {
  id: keyof SloppyConfig["plugins"] & string;
  version: string;
  description?: string;
  defaultEnabled: boolean;
  providerIds?: string[];
  extensionNamespaces?: string[];
  tui?: TuiContributionManifest;
  createProviders?: (config: SloppyConfig) => RegisteredProvider[];
  createSessionPlugin?: (config: SloppyConfig) => SessionRuntimePlugin;
  policyRules?: (config: SloppyConfig) => InvokePolicy[];
  toolEventEnrichers?: (config: SloppyConfig) => ToolEventEnricher[];
  doctorChecks?: (config: SloppyConfig) => RuntimeDoctorCheckFactory[];
  doctorSubprocessProbes?: (config: SloppyConfig) => RuntimeDoctorSubprocessProbeFactory[];
};

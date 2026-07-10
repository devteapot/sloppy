import type { ClientTransport } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { ProviderRuntimeHub } from "../core/hub";
import type { RuntimeContext } from "../core/role";
import type { ProviderApprovalManager } from "../providers/approvals";

export type PluginProviderContribution = {
  id: string;
  name: string;
  transport: ClientTransport;
  transportLabel: string;
  stop?: () => void | Promise<void>;
  systemPromptFragment?: (config: SloppyConfig) => string | null;
  attachRuntime?: (
    hub: ProviderRuntimeHub,
    config: SloppyConfig,
    ctx?: RuntimeContext,
  ) => { stop(): void | Promise<void> } | undefined;
  approvals?: ProviderApprovalManager;
};

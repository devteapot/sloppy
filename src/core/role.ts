import type { SloppyConfig } from "../config/schema";
import type { ConsumerHub } from "./consumer";
import type { RuntimeToolResolution } from "./tools";

export type ToolPolicyDecision = null | { reject: string };

export type RoleProfile = {
  id: string;
  systemPromptFragment?: (config: SloppyConfig) => string | null;
  toolPolicy?: (
    resolution: RuntimeToolResolution,
    params: Record<string, unknown>,
    config: SloppyConfig,
  ) => ToolPolicyDecision;
  beforeNextTurn?: (hub: ConsumerHub, signal?: AbortSignal) => Promise<void>;
  attachRuntime?: (hub: ConsumerHub, config: SloppyConfig) => { stop(): void };
};

export const defaultRole: RoleProfile = {
  id: "default",
};

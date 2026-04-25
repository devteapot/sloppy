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
  /**
   * Optional pre-invocation transform: rewrite tool params before the
   * affordance is dispatched to the provider. Returning the params object
   * unchanged is a no-op. Used by role layers to inject domain-specific
   * planning policy that the generic providers should not own.
   */
  transformInvoke?: (
    resolution: RuntimeToolResolution,
    params: Record<string, unknown>,
    config: SloppyConfig,
  ) => Record<string, unknown>;
  beforeNextTurn?: (hub: ConsumerHub, signal?: AbortSignal) => Promise<void>;
  attachRuntime?: (hub: ConsumerHub, config: SloppyConfig) => { stop(): void };
};

export const defaultRole: RoleProfile = {
  id: "default",
};

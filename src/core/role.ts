import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import type { ProviderRuntimeHub } from "./hub";
import type { RuntimeToolResolution } from "./tools";

export type ToolPolicyDecision = null | { reject: string };

/**
 * Generic event published through the agent's runtime event bus. Extensions
 * (roles, providers) emit these via `RuntimeContext.publishEvent` without the
 * kernel needing to know about specific event shapes.
 */
export type RuntimeEvent = {
  kind: string;
  [key: string]: unknown;
};

/**
 * Context passed to extensions' `attachRuntime` hooks. Provides the kernel
 * services an extension may need without coupling the kernel to any specific
 * extension type.
 */
export interface RuntimeContext {
  hub: ProviderRuntimeHub;
  config: SloppyConfig;
  /** Publish a generic runtime event through the agent event bus. */
  publishEvent: (event: RuntimeEvent) => void;
  /** Registry where extensions can register role factories by id. */
  roleRegistry: RoleRegistry;
  /**
   * The agent's LlmProfileManager. Exposed so providers (e.g. delegation) can
   * construct executor resolvers and spawn sub-agents bound to a specific
   * profile without wiring a second manager instance.
   */
  llmProfileManager?: LlmProfileManager;
}

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
  beforeNextTurn?: (hub: ProviderRuntimeHub, signal?: AbortSignal) => Promise<void>;
  attachRuntime?: (
    hub: ProviderRuntimeHub,
    config: SloppyConfig,
    ctx?: RuntimeContext,
  ) => { stop(): void };
};

export const defaultRole: RoleProfile = {
  id: "default",
};

export type RoleFactory = (ctx: RuntimeContext) => RoleProfile;

/**
 * In-process registry of role factories keyed by role id. Extensions register
 * themselves here (typically in a provider's `attachRuntime`) so the agent can
 * resolve a role by id at start time without the kernel hard-coding which
 * roles exist.
 */
export class RoleRegistry {
  private factories = new Map<string, RoleFactory>();

  register(id: string, factory: RoleFactory): void {
    this.factories.set(id, factory);
  }

  unregister(id: string): void {
    this.factories.delete(id);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  resolve(id: string, ctx: RuntimeContext): RoleProfile | null {
    const factory = this.factories.get(id);
    return factory ? factory(ctx) : null;
  }
}

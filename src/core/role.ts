import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import type { LlmResponse } from "../llm/types";
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
 * Hooks provided by the delegation runtime so other extensions (e.g. the
 * orchestration provider) can wire task-aware behavior into spawned
 * sub-agents without the delegation runtime needing to know about them.
 */
export interface DelegationRuntimeHooks {
  setTaskContextFactory(factory: TaskContextFactory | null): void;
}

/**
 * Minimal metadata about an upcoming sub-agent spawn that an extension can
 * use to decide whether to attach a `TaskContext`.
 */
export interface TaskContextSpawnInfo {
  id: string;
  name: string;
  goal: string;
  externalTaskId?: string;
}

/**
 * Optional context an extension provides to a sub-agent spawn. The sub-agent
 * runner uses this to build the initial prompt and report lifecycle
 * transitions back to whatever owns the task (e.g. an orchestrator).
 */
export interface TaskContext {
  buildInitialPrompt(goal: string): Promise<string>;
  recordTransition(action: "start" | "cancel" | "start_verification"): Promise<void>;
  recordCompletion(result: string | undefined): Promise<void>;
  recordFailure(error: string): Promise<void>;
  ensureTask(): Promise<void>;
  /**
   * Optional list of builtin provider keys to disable in the spawned
   * sub-agent's child config. Lets the extension owning the task (e.g. an
   * orchestrator) strip planning-layer providers so the child can't recurse,
   * without the kernel sub-agent runner naming any specific planner.
   */
  disableBuiltinProviders?: readonly string[];
}

export type TaskContextFactory = (spawn: TaskContextSpawnInfo) => TaskContext | undefined;

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
  /** Hooks exposed by the delegation runtime, when present. */
  delegationHooks?: DelegationRuntimeHooks;
  /** Setter delegation runtime uses to expose its hooks. */
  setDelegationHooks?: (hooks: DelegationRuntimeHooks | null) => void;
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
  onModelResponse?: (
    response: LlmResponse,
    hub: ProviderRuntimeHub,
    signal?: AbortSignal,
  ) => Promise<void> | void;
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

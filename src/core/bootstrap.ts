// Shared composition root for the provider runtime. Agent.start() and the
// runtime smoke runner both assemble providers + hub the same way; this is the
// single place that ordering lives. Keep it a function, not a framework.
import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import type { RegisteredProvider } from "../providers/registry";
import { createFirstPartyProviders } from "../providers/registry";
import { ConsumerHub } from "./consumer";
import { RoleRegistry, type RuntimeContext, type RuntimeEvent } from "./role";

export interface ProviderRuntimeBootstrap {
  hub: ConsumerHub;
  providers: RegisteredProvider[];
  runtimeCtx: RuntimeContext;
  runtimeStops: Array<{ stop(): void }>;
  systemPromptFragments: string[];
}

/**
 * Creates providers, constructs and connects the hub, then attaches provider
 * runtimes in provider order (system-prompt fragments are order-sensitive).
 */
export async function bootstrapProviderRuntime(options: {
  config: SloppyConfig;
  /** Defaults to createFirstPartyProviders(config). */
  providers?: RegisteredProvider[];
  /** Extra providers (e.g. discovered apps) registered after hub.connect(). */
  registerAfterConnect?: RegisteredProvider[];
  /** Runs after hub construction, before connect — for subscriptions. */
  onHubCreated?: (hub: ConsumerHub) => void;
  publishEvent?: (event: RuntimeEvent) => void;
  roleRegistry?: RoleRegistry;
  llmProfileManager?: LlmProfileManager;
  collectSystemPromptFragments?: boolean;
}): Promise<ProviderRuntimeBootstrap> {
  const providers = options.providers ?? createFirstPartyProviders(options.config);
  const hub = new ConsumerHub(providers, options.config);
  options.onHubCreated?.(hub);
  await hub.connect();
  for (const provider of options.registerAfterConnect ?? []) {
    hub.registerProvider(provider);
  }

  const runtimeCtx: RuntimeContext = {
    hub,
    config: options.config,
    publishEvent: options.publishEvent ?? (() => undefined),
    roleRegistry: options.roleRegistry ?? new RoleRegistry(),
    llmProfileManager: options.llmProfileManager,
  };

  const runtimeStops: Array<{ stop(): void }> = [];
  const systemPromptFragments: string[] = [];
  for (const provider of providers) {
    const runtimeStop = provider.attachRuntime?.(hub, options.config, runtimeCtx);
    if (runtimeStop) {
      runtimeStops.push(runtimeStop);
    }
    if (options.collectSystemPromptFragments) {
      const fragment = provider.systemPromptFragment?.(options.config);
      if (fragment) {
        systemPromptFragments.push(fragment);
      }
    }
  }

  return { hub, providers, runtimeCtx, runtimeStops, systemPromptFragments };
}

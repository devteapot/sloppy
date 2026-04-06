import { loadConfig } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { createLlmAdapter } from "../llm/factory";
import type { LlmAdapter } from "../llm/types";
import {
  discoverProviderDescriptors,
  type ProviderDiscoveryUpdate,
  watchProviderDescriptors,
} from "../providers/discovery";
import {
  createBuiltinProviders,
  createDiscoveredProviders,
  createRegisteredProviderFromDescriptor,
} from "../providers/registry";
import { ConsumerHub } from "./consumer";
import { ConversationHistory } from "./history";
import { runLoop } from "./loop";

export interface AgentCallbacks {
  onText?: (chunk: string) => void;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
}

export class Agent {
  private config: SloppyConfig;
  private hub: ConsumerHub | null = null;
  private builtinProviderIds = new Set<string>();
  private discoveryStop: (() => void) | null = null;
  private discoverySync: Promise<void> = Promise.resolve();
  private history: ConversationHistory;
  private llm: LlmAdapter;
  private callbacks: AgentCallbacks;

  constructor(options?: { config?: SloppyConfig } & AgentCallbacks) {
    this.config = options?.config ?? loadConfig();
    this.callbacks = {
      onText: options?.onText,
      onToolCall: options?.onToolCall,
      onToolResult: options?.onToolResult,
    };
    this.history = new ConversationHistory({
      historyTurns: this.config.agent.historyTurns,
      toolResultMaxChars: this.config.agent.toolResultMaxChars,
    });
    this.llm = createLlmAdapter(this.config);
  }

  async start(): Promise<void> {
    if (this.hub) {
      return;
    }

    const builtins = createBuiltinProviders(this.config);
    this.builtinProviderIds = new Set(builtins.map((provider) => provider.id));

    const discoveredDescriptors = this.config.providers.discovery.enabled
      ? discoverProviderDescriptors(this.config.providers.discovery.paths)
      : [];
    const providers = [
      ...builtins,
      ...createDiscoveredProviders(discoveredDescriptors, this.builtinProviderIds),
    ];
    const hub = new ConsumerHub(providers, this.config);
    await hub.connect();
    this.hub = hub;

    if (this.config.providers.discovery.enabled) {
      this.discoveryStop = watchProviderDescriptors({
        paths: this.config.providers.discovery.paths,
        initialDescriptors: discoveredDescriptors,
        onChange: (update) => {
          this.discoverySync = this.discoverySync
            .then(() => this.applyDiscoveryUpdate(update))
            .catch((error) => {
              console.warn(
                `[sloppy] provider discovery update failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        },
      });
    }
  }

  async chat(userMessage: string): Promise<string> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }

    this.history.addUserText(userMessage);
    return runLoop({
      config: this.config,
      hub: this.hub,
      history: this.history,
      llm: this.llm,
      onText: this.callbacks.onText,
      onToolCall: this.callbacks.onToolCall,
      onToolResult: this.callbacks.onToolResult,
    });
  }

  shutdown(): void {
    this.discoveryStop?.();
    this.discoveryStop = null;

    const hub = this.hub;
    this.hub = null;
    hub?.shutdown();

    this.builtinProviderIds.clear();
    this.discoverySync = Promise.resolve();
  }

  private async applyDiscoveryUpdate(update: ProviderDiscoveryUpdate): Promise<void> {
    const hub = this.hub;
    if (!hub) {
      return;
    }

    for (const descriptor of update.removed) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        continue;
      }

      hub.removeProvider(descriptor.id);
    }

    for (const descriptor of update.updated) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        continue;
      }

      hub.removeProvider(descriptor.id);
    }

    for (const descriptor of [...update.updated, ...update.added]) {
      if (this.builtinProviderIds.has(descriptor.id)) {
        continue;
      }

      const provider = createRegisteredProviderFromDescriptor(descriptor);
      if (!provider) {
        continue;
      }

      await hub.addProvider(provider);
    }
  }
}

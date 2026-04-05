import {
  formatTree,
  type HelloMessage,
  type ResultMessage,
  SlopConsumer,
  type SlopNode,
} from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { RegisteredProvider } from "../providers/registry";
import type { ProviderTreeView } from "./subscriptions";
import { buildRuntimeToolSet, type RuntimeToolSet } from "./tools";

type ConnectedProvider = RegisteredProvider & {
  consumer: SlopConsumer;
  hello: HelloMessage;
  overviewSubscriptionId: string;
  overviewTree: SlopNode;
  detailSubscriptionId?: string;
  detailPath?: string;
  detailTree?: SlopNode;
};

export class ConsumerHub {
  private providers = new Map<string, ConnectedProvider>();
  private config: SloppyConfig;
  private registeredProviders: RegisteredProvider[];

  constructor(registeredProviders: RegisteredProvider[], config: SloppyConfig) {
    this.registeredProviders = registeredProviders;
    this.config = config;
  }

  async connect(): Promise<void> {
    for (const registeredProvider of this.registeredProviders) {
      try {
        const consumer = new SlopConsumer(registeredProvider.transport);
        const hello = await consumer.connect();
        const overview = await consumer.subscribe("/", this.config.agent.overviewDepth, {
          max_nodes: this.config.agent.overviewMaxNodes,
          filter: { min_salience: this.config.agent.minSalience },
        });

        const provider: ConnectedProvider = {
          ...registeredProvider,
          consumer,
          hello,
          overviewSubscriptionId: overview.id,
          overviewTree: overview.snapshot,
        };

        consumer.on("patch", (subscriptionId: string) => {
          const tree = consumer.getTree(subscriptionId);
          if (!tree) {
            return;
          }

          if (subscriptionId === provider.overviewSubscriptionId) {
            provider.overviewTree = tree;
            return;
          }

          if (subscriptionId === provider.detailSubscriptionId) {
            provider.detailTree = tree;
          }
        });

        this.providers.set(provider.id, provider);
      } catch (error) {
        console.warn(
          `[sloppy] skipped provider ${registeredProvider.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  getProviderViews(): ProviderTreeView[] {
    return [...this.providers.values()].map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      kind: provider.kind,
      overviewTree: provider.overviewTree,
      detailPath: provider.detailPath,
      detailTree: provider.detailTree,
    }));
  }

  getRuntimeToolSet(): RuntimeToolSet {
    return buildRuntimeToolSet(this.getProviderViews());
  }

  async queryState(options: {
    providerId: string;
    path: string;
    depth?: number;
    maxNodes?: number;
    minSalience?: number;
    window?: [number, number];
  }): Promise<SlopNode> {
    const provider = this.requireProvider(options.providerId);
    return provider.consumer.query(options.path, options.depth ?? 2, {
      max_nodes: options.maxNodes,
      filter: options.minSalience != null ? { min_salience: options.minSalience } : undefined,
      window: options.window,
    });
  }

  async focusState(options: {
    providerId: string;
    path: string;
    depth?: number;
    maxNodes?: number;
  }): Promise<SlopNode> {
    const provider = this.requireProvider(options.providerId);

    if (provider.detailSubscriptionId) {
      provider.consumer.unsubscribe(provider.detailSubscriptionId);
      provider.detailSubscriptionId = undefined;
      provider.detailPath = undefined;
      provider.detailTree = undefined;
    }

    const detail = await provider.consumer.subscribe(
      options.path,
      options.depth ?? this.config.agent.detailDepth,
      {
        max_nodes: options.maxNodes ?? this.config.agent.detailMaxNodes,
      },
    );
    provider.detailSubscriptionId = detail.id;
    provider.detailPath = options.path;
    provider.detailTree = detail.snapshot;
    return detail.snapshot;
  }

  async invoke(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    const provider = this.requireProvider(providerId);
    return provider.consumer.invoke(path, action, params);
  }

  shutdown(): void {
    for (const provider of this.providers.values()) {
      provider.consumer.disconnect();
      provider.stop?.();
    }
    this.providers.clear();
  }

  formatSnapshot(tree: SlopNode): string {
    return formatTree(tree);
  }

  private requireProvider(providerId: string): ConnectedProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    return provider;
  }
}

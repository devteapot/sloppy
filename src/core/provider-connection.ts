import { type HelloMessage, SlopConsumer, type SlopNode } from "@slop-ai/consumer/browser";

import type { RegisteredProvider } from "../providers/registry";

export type ConnectedProvider = RegisteredProvider & {
  consumer: SlopConsumer;
  hello: HelloMessage;
  overviewSubscriptionId: string;
  overviewTree: SlopNode;
  focusSubscriptions: Map<
    string,
    { path: string; subscriptionId: string; tree: SlopNode; depth: number }
  >;
  patchListener: (subscriptionId: string) => void;
  disconnectListener: () => void;
  unsubscribeEvent: (() => void) | null;
  watchedSubscriptions: Map<
    string,
    {
      path: string;
      subscriptionId: string;
      tree: SlopNode;
      listeners: Set<(tree: SlopNode | null) => void>;
    }
  >;
};

export type ProviderConnectionHooks = {
  onPatch: (providerId: string, subscriptionId: string, tree: SlopNode) => void;
  onDisconnect: (providerId: string) => void;
  onEvent: (providerId: string, name: string, data: unknown) => void;
};

export async function connectProvider(
  registeredProvider: RegisteredProvider,
  overviewDepth: number,
  hooks: ProviderConnectionHooks,
): Promise<ConnectedProvider> {
  const consumer = new SlopConsumer(registeredProvider.transport);
  const hello = await consumer.connect();
  const overview = await consumer.subscribe("/", overviewDepth);
  const patchListener = (subscriptionId: string) => {
    const tree = consumer.getTree(subscriptionId);
    if (tree) {
      hooks.onPatch(registeredProvider.id, subscriptionId, tree);
    }
  };
  const disconnectListener = () => hooks.onDisconnect(registeredProvider.id);
  const unsubscribeEvent = consumer.onEvent((name, data) => {
    hooks.onEvent(registeredProvider.id, name, data);
  });

  const provider: ConnectedProvider = {
    ...registeredProvider,
    consumer,
    hello,
    overviewSubscriptionId: overview.id,
    overviewTree: overview.snapshot,
    focusSubscriptions: new Map(),
    patchListener,
    disconnectListener,
    unsubscribeEvent,
    watchedSubscriptions: new Map(),
  };
  consumer.on("patch", patchListener);
  consumer.on("disconnect", disconnectListener);
  return provider;
}

export function disconnectProvider(provider: ConnectedProvider, connectionAlive: boolean): void {
  provider.consumer.off("patch", provider.patchListener);
  provider.consumer.off("disconnect", provider.disconnectListener);
  provider.unsubscribeEvent?.();
  provider.unsubscribeEvent = null;

  unsubscribeAll(provider, provider.watchedSubscriptions);
  unsubscribeAll(provider, provider.focusSubscriptions);

  if (!connectionAlive) return;
  try {
    provider.consumer.unsubscribe(provider.overviewSubscriptionId);
  } catch {
    // The provider may have dropped before the overview could be removed.
  }
  try {
    provider.consumer.disconnect();
  } catch {
    // Best-effort disconnect after unsubscribe failures.
  }
}

function unsubscribeAll(
  provider: ConnectedProvider,
  subscriptions: Map<string, { subscriptionId: string }>,
): void {
  for (const subscription of subscriptions.values()) {
    try {
      provider.consumer.unsubscribe(subscription.subscriptionId);
    } catch {
      // The provider may already be disconnected.
    }
  }
  subscriptions.clear();
}

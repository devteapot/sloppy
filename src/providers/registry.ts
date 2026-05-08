import type { ClientTransport } from "@slop-ai/consumer/browser";
import { WebSocketClientTransport } from "@slop-ai/consumer/browser";
import type { SloppyConfig } from "../config/schema";
import type { ProviderRuntimeHub } from "../core/hub";
import type { RuntimeContext } from "../core/role";
import { createFirstPartyPluginProviders } from "../plugins/first-party/catalog";
import type { ProviderApprovalManager } from "./approvals";
import {
  discoverProviderDescriptors,
  type ProviderDescriptor,
  type ProviderTransportDescriptor,
} from "./discovery";
import { NodeSocketClientTransport } from "./node-socket";

export interface RegisteredProvider {
  id: string;
  name: string;
  kind: "first-party" | "external";
  transport: ClientTransport;
  transportLabel: string;
  stop?: () => void;
  systemPromptFragment?: (config: SloppyConfig) => string | null;
  attachRuntime?: (
    hub: ProviderRuntimeHub,
    config: SloppyConfig,
    ctx?: RuntimeContext,
  ) => { stop(): void } | undefined;
  /**
   * Optional reference to the provider's `ProviderApprovalManager`. When
   * present, the registry / hub connects it to `hub.approvals` so all
   * policy-mediated and provider-native approval requests share one queue.
   */
  approvals?: ProviderApprovalManager;
}

export function describeProviderTransport(transport: ProviderTransportDescriptor): string {
  switch (transport.type) {
    case "unix":
      return `unix:${transport.path}`;
    case "ws":
      return `ws:${transport.url}`;
    case "stdio":
      return `stdio:${transport.command.join(" ")}`;
    case "pipe":
      return `pipe:${transport.name}`;
    case "postmessage":
      return "postmessage";
  }
}

export function createFirstPartyProviders(config: SloppyConfig): RegisteredProvider[] {
  return createFirstPartyPluginProviders(config);
}

export function createRegisteredProviderFromDescriptor(
  descriptor: ProviderDescriptor,
): RegisteredProvider | null {
  let transport: ClientTransport | null = null;

  if (descriptor.transport.type === "unix") {
    transport = new NodeSocketClientTransport(descriptor.transport.path);
  }

  if (descriptor.transport.type === "ws") {
    transport = new WebSocketClientTransport(descriptor.transport.url);
  }

  if (!transport) {
    return null;
  }

  return {
    id: descriptor.id,
    name: descriptor.name,
    kind: "external",
    transport,
    transportLabel: describeProviderTransport(descriptor.transport),
  };
}

export function createDiscoveredProviders(
  descriptors: ProviderDescriptor[],
  reservedIds: Iterable<string> = [],
): RegisteredProvider[] {
  const providers: RegisteredProvider[] = [];
  const knownIds = new Set(reservedIds);

  for (const descriptor of descriptors) {
    if (knownIds.has(descriptor.id)) {
      continue;
    }

    const provider = createRegisteredProviderFromDescriptor(descriptor);
    if (!provider) {
      continue;
    }

    providers.push(provider);
    knownIds.add(provider.id);
  }

  return providers;
}

export async function createRegisteredProviders(
  config: SloppyConfig,
): Promise<RegisteredProvider[]> {
  const firstPartyProviders = createFirstPartyProviders(config);
  if (!config.providers.discovery.enabled) {
    return firstPartyProviders;
  }

  const descriptors = await discoverProviderDescriptors(config.providers.discovery.paths);
  const externalProviders = createDiscoveredProviders(
    descriptors,
    firstPartyProviders.map((provider) => provider.id),
  );

  return [...firstPartyProviders, ...externalProviders];
}

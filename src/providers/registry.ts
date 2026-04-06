import { type ClientTransport, WebSocketClientTransport } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import { FilesystemProvider } from "./builtin/filesystem";
import { InProcessTransport } from "./builtin/in-process";
import { TerminalProvider } from "./builtin/terminal";
import { discoverProviderDescriptors, type ProviderDescriptor } from "./discovery";
import { NodeSocketClientTransport } from "./node-socket";

export interface RegisteredProvider {
  id: string;
  name: string;
  kind: "builtin" | "external";
  transport: ClientTransport;
  stop?: () => void;
}

export function createBuiltinProviders(config: SloppyConfig): RegisteredProvider[] {
  const providers: RegisteredProvider[] = [];

  if (config.providers.builtin.terminal) {
    const terminal = new TerminalProvider({
      cwd: config.providers.terminal.cwd,
      historyLimit: config.providers.terminal.historyLimit,
      syncTimeoutMs: config.providers.terminal.syncTimeoutMs,
    });
    providers.push({
      id: "terminal",
      name: "Terminal",
      kind: "builtin",
      transport: new InProcessTransport(terminal.server),
      stop: () => terminal.stop(),
    });
  }

  if (config.providers.builtin.filesystem) {
    const filesystem = new FilesystemProvider({
      root: config.providers.filesystem.root,
      focus: config.providers.filesystem.focus ?? config.providers.filesystem.root,
      recentLimit: config.providers.filesystem.recentLimit,
      searchLimit: config.providers.filesystem.searchLimit,
      readMaxBytes: config.providers.filesystem.readMaxBytes,
    });
    providers.push({
      id: "filesystem",
      name: "Filesystem",
      kind: "builtin",
      transport: new InProcessTransport(filesystem.server),
      stop: () => filesystem.stop(),
    });
  }

  return providers;
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

export function createRegisteredProviders(config: SloppyConfig): RegisteredProvider[] {
  const builtins = createBuiltinProviders(config);
  if (!config.providers.discovery.enabled) {
    return builtins;
  }

  const descriptors = discoverProviderDescriptors(config.providers.discovery.paths);
  const externalProviders = createDiscoveredProviders(
    descriptors,
    builtins.map((provider) => provider.id),
  );

  return [...builtins, ...externalProviders];
}

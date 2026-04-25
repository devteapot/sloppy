// Coordinates external-provider discovery for Agent. Owns the per-descriptor
// error state and the rules for accepting/rejecting/replacing external
// providers, so Agent can stay focused on hub lifecycle and the run loop.

import type { ProviderDescriptor, ProviderDiscoveryUpdate } from "../../providers/discovery";
import {
  createRegisteredProviderFromDescriptor,
  describeProviderTransport,
  type RegisteredProvider,
} from "../../providers/registry";
import type { ExternalProviderState } from "../consumer";
import type { ProviderRuntimeHub } from "../hub";

export interface ProviderDiscoveryCoordinatorOptions {
  ignoredProviderIds?: Iterable<string>;
  /**
   * Called whenever this coordinator's error map mutates so Agent can
   * re-merge external-provider state and notify its consumer callbacks.
   */
  notifyStateChange: () => void;
}

export class ProviderDiscoveryCoordinator {
  private readonly ignoredProviderIds: Set<string>;
  private readonly notifyStateChange: () => void;
  private builtinProviderIds = new Set<string>();
  private readonly errors = new Map<string, ExternalProviderState>();

  constructor(options: ProviderDiscoveryCoordinatorOptions) {
    this.ignoredProviderIds = new Set(options.ignoredProviderIds ?? []);
    this.notifyStateChange = options.notifyStateChange;
  }

  setBuiltinProviderIds(ids: Iterable<string>): void {
    this.builtinProviderIds = new Set(ids);
  }

  resetErrors(): void {
    if (this.errors.size === 0) return;
    this.errors.clear();
    this.notifyStateChange();
  }

  errorStates(): IterableIterator<ExternalProviderState> {
    return this.errors.values();
  }

  resolveDescriptor(descriptor: ProviderDescriptor): RegisteredProvider | null {
    if (this.ignoredProviderIds.has(descriptor.id)) {
      if (this.errors.delete(descriptor.id)) {
        this.notifyStateChange();
      }
      return null;
    }

    if (this.builtinProviderIds.has(descriptor.id)) {
      this.errors.set(descriptor.id, {
        id: descriptor.id,
        name: descriptor.name,
        transport: describeProviderTransport(descriptor.transport),
        status: "error",
        lastError: `Descriptor id conflicts with built-in provider '${descriptor.id}'.`,
      });
      this.notifyStateChange();
      return null;
    }

    const provider = createRegisteredProviderFromDescriptor(descriptor);
    if (!provider) {
      this.errors.set(descriptor.id, {
        id: descriptor.id,
        name: descriptor.name,
        transport: describeProviderTransport(descriptor.transport),
        status: "error",
        lastError: `Unsupported transport: ${descriptor.transport.type}`,
      });
      this.notifyStateChange();
      return null;
    }

    if (this.errors.delete(descriptor.id)) {
      this.notifyStateChange();
    }
    return provider;
  }

  async applyUpdate(args: {
    hub: ProviderRuntimeHub;
    update: ProviderDiscoveryUpdate;
    registerMirrors: (providerId: string) => Promise<void>;
    unregisterMirrors: (providerId: string) => void;
  }): Promise<void> {
    const { hub, update, registerMirrors, unregisterMirrors } = args;

    const dropExternal = (descriptor: ProviderDescriptor) => {
      if (this.builtinProviderIds.has(descriptor.id)) {
        if (this.errors.delete(descriptor.id)) {
          this.notifyStateChange();
        }
        return;
      }
      this.errors.delete(descriptor.id);
      unregisterMirrors(descriptor.id);
      hub.removeProvider(descriptor.id);
      this.notifyStateChange();
    };

    for (const descriptor of update.removed) {
      dropExternal(descriptor);
    }

    for (const descriptor of update.updated) {
      dropExternal(descriptor);
    }

    for (const descriptor of [...update.updated, ...update.added]) {
      const provider = this.resolveDescriptor(descriptor);
      if (!provider) continue;

      const added = await hub.addProvider(provider);
      if (added) {
        await registerMirrors(provider.id);
      }
    }
  }
}

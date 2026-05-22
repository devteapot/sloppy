import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { ExternalProviderState } from "../../../core/consumer";
import type { ProviderRuntimeHub } from "../../../core/hub";

function compareApps(left: ExternalProviderState, right: ExternalProviderState): number {
  const nameComparison = left.name.localeCompare(right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }
  return left.id.localeCompare(right.id);
}

export class AppsProvider {
  readonly server: SlopServer;
  private hub: ProviderRuntimeHub | null = null;
  private unsubscribeExternalProviderStateChange: (() => void) | null = null;

  constructor() {
    this.server = createSlopServer({
      id: "apps",
      name: "Apps",
    });

    this.server.register("available", () => this.buildAvailableDescriptor());
  }

  setHub(hub: ProviderRuntimeHub | null): void {
    this.unsubscribeExternalProviderStateChange?.();
    this.unsubscribeExternalProviderStateChange = null;
    this.hub = hub;

    if (hub) {
      this.unsubscribeExternalProviderStateChange = hub.onExternalProviderStateChange(() => {
        this.server.refresh();
      });
    }
    this.server.refresh();
  }

  stop(): void {
    this.setHub(null);
    this.server.stop();
  }

  private apps(): ExternalProviderState[] {
    return (this.hub?.getExternalProviderStates() ?? []).sort(compareApps);
  }

  private requireHub(): ProviderRuntimeHub {
    if (!this.hub) {
      throw new Error("Apps provider is not attached to the runtime Hub.");
    }
    return this.hub;
  }

  private requireApp(providerId: string): ExternalProviderState {
    const app = this.apps().find((candidate) => candidate.id === providerId);
    if (!app) {
      throw new Error(`Unknown external app: ${providerId}`);
    }
    return app;
  }

  private async loadProvider(providerId: string): Promise<{
    provider_id: string;
    status: "connected";
    was_connected: boolean;
  }> {
    const hub = this.requireHub();
    this.requireApp(providerId);
    const wasConnected = await hub.loadProvider(providerId);
    this.server.refresh();
    return {
      provider_id: providerId,
      status: "connected",
      was_connected: wasConnected,
    };
  }

  private async reloadProvider(providerId: string): Promise<{
    provider_id: string;
    status: "connected";
  }> {
    const hub = this.requireHub();
    this.requireApp(providerId);
    await hub.reloadProvider(providerId);
    this.server.refresh();
    return {
      provider_id: providerId,
      status: "connected",
    };
  }

  private unloadProvider(providerId: string): {
    provider_id: string;
    status: "unloaded";
    was_connected: boolean;
  } {
    const hub = this.requireHub();
    this.requireApp(providerId);
    const wasConnected = hub.unloadProvider(providerId);
    this.server.refresh();
    return {
      provider_id: providerId,
      status: "unloaded",
      was_connected: wasConnected,
    };
  }

  private buildAvailableDescriptor() {
    const apps = this.apps();
    const connected = apps.filter((app) => app.status === "connected").length;
    const unloaded = apps.filter((app) => app.status === "unloaded").length;
    const disconnected = apps.filter((app) => app.status === "disconnected").length;
    const errored = apps.filter((app) => app.status === "error").length;
    return {
      type: "collection",
      props: {
        count: apps.length,
        connected_count: connected,
        unloaded_count: unloaded,
        disconnected_count: disconnected,
        error_count: errored,
      },
      summary:
        "Available external SLOP apps registered for this session. Load only task-relevant apps.",
      items: apps.map((app) => this.buildAppItem(app)),
      actions: {
        load_provider: action(
          { provider_id: "string" },
          async ({ provider_id }) => this.loadProvider(String(provider_id)),
          {
            label: "Load App",
            description:
              "Connect an unloaded, disconnected, or errored external app provider so its state and affordances enter the agent Hub.",
            estimate: "fast",
          },
        ),
        unload_provider: action(
          { provider_id: "string" },
          async ({ provider_id }) => this.unloadProvider(String(provider_id)),
          {
            label: "Unload App",
            description:
              "Disconnect an external app provider from the agent Hub while keeping its app card available for later loading.",
            estimate: "fast",
          },
        ),
        reload_provider: action(
          { provider_id: "string" },
          async ({ provider_id }) => this.reloadProvider(String(provider_id)),
          {
            label: "Reload App",
            description: "Disconnect and reconnect a currently connected external app provider.",
            estimate: "fast",
          },
        ),
      },
    };
  }

  private buildAppItem(app: ExternalProviderState): ItemDescriptor {
    return {
      id: app.id,
      props: {
        provider_id: app.id,
        name: app.name,
        transport: app.transport,
        status: app.status,
        last_error: app.lastError,
      },
      summary: `${app.name} (${app.status})`,
    };
  }
}

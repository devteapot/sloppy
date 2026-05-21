import { action, type ItemDescriptor, type NodeDescriptor } from "@slop-ai/server";

import type { LocalRuntimeTool } from "../../core/agent";
import type { QueuedSessionMessage } from "../types";
import type {
  ActivePluginTurn,
  PluginRuntimeContext,
  PluginTurnCompleteEvent,
  PluginTurnFailureEvent,
  PluginTurnRequest,
  SessionNodeContribution,
  SessionRuntimePlugin,
} from "./types";

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export class SessionPluginManager {
  constructor(
    private readonly plugins: SessionRuntimePlugin[],
    private readonly ctx: PluginRuntimeContext,
  ) {}

  list(): SessionRuntimePlugin[] {
    return [...this.plugins];
  }

  sessionNodes(): SessionNodeContribution[] {
    return this.plugins.flatMap((plugin) => plugin.sessionNodes?.(this.ctx) ?? []);
  }

  sessionSummary(): { props: Record<string, unknown>; summaries: string[] } {
    const props: Record<string, unknown> = {};
    const summaries: string[] = [];
    for (const plugin of this.plugins) {
      const contribution = plugin.sessionSummary?.(this.ctx);
      if (!contribution) {
        continue;
      }
      Object.assign(props, contribution.props ?? {});
      if (contribution.summary) {
        summaries.push(contribution.summary);
      }
    }
    return { props, summaries };
  }

  async onStartup(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onStartup?.(this.ctx);
    }
  }

  onShutdown(): void {
    for (const plugin of [...this.plugins].reverse()) {
      plugin.onShutdown?.(this.ctx);
    }
  }

  buildPluginsDescriptor(): NodeDescriptor {
    const items: ItemDescriptor[] = this.plugins.map((plugin) => {
      const sessionPaths = (plugin.sessionNodes?.(this.ctx) ?? []).map((node) =>
        normalizePath(node.path),
      );
      return {
        id: plugin.id,
        props: {
          id: plugin.id,
          version: plugin.version,
          status: "active",
          description: plugin.description,
          default_enabled: plugin.defaultEnabled,
          provider_ids: plugin.providerIds ?? [],
          extension_namespaces: plugin.extensionNamespaces ?? [],
          session_paths: sessionPaths,
          ui: plugin.ui ?? {},
        },
        summary: plugin.description ?? plugin.id,
        actions: {
          inspect_manifest: action(async () => ({ status: "ok", manifest: plugin.ui ?? {} }), {
            label: "Inspect UI Manifest",
            description: "Return this session plugin's declarative UI contribution manifest.",
            estimate: "instant",
            idempotent: true,
          }),
        },
      };
    });

    return {
      type: "collection",
      props: {
        count: items.length,
        ids: items.map((item) => item.id),
        ui_manifest_version: 2,
      },
      summary: "Active first-party session runtime plugins.",
      items,
    };
  }

  localTools(activeTurn: ActivePluginTurn | null): LocalRuntimeTool[] {
    const tools: LocalRuntimeTool[] = [];
    const owners = new Map<string, string>();

    for (const plugin of this.plugins) {
      for (const tool of plugin.localTools?.(this.ctx, activeTurn) ?? []) {
        const name = tool.tool.function.name;
        const existingOwner = owners.get(name);
        if (existingOwner) {
          throw new Error(
            `Duplicate local runtime tool ${name} registered by ${existingOwner} and ${plugin.id}.`,
          );
        }
        owners.set(name, plugin.id);
        tools.push({
          ...tool,
          pluginId: plugin.id,
        });
      }
    }

    return tools;
  }

  acceptQueuedTurn(message: QueuedSessionMessage): PluginTurnRequest | null {
    const pluginId = message.pluginId;
    if (!pluginId) {
      return null;
    }
    const plugin = this.plugins.find((candidate) => candidate.id === pluginId);
    return plugin?.acceptQueuedTurn?.(message, this.ctx) ?? null;
  }

  nextTurn(): PluginTurnRequest | null {
    for (const plugin of this.plugins) {
      const request = plugin.nextTurn?.(this.ctx);
      if (request) {
        return request;
      }
    }
    return null;
  }

  onTurnComplete(event: PluginTurnCompleteEvent): void {
    const plugin = this.plugins.find((candidate) => candidate.id === event.pluginTurn.pluginId);
    plugin?.onTurnComplete?.(event, this.ctx);
  }

  onTurnFailure(event: PluginTurnFailureEvent): void {
    const plugin = this.plugins.find((candidate) => candidate.id === event.pluginTurn.pluginId);
    plugin?.onTurnFailure?.(event, this.ctx);
  }
}

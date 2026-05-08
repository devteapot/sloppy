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
          session_paths: sessionPaths,
          tui: plugin.tui ?? {},
        },
        summary: plugin.description ?? plugin.id,
        actions: {
          inspect_manifest: action(async () => ({ status: "ok", manifest: plugin.tui ?? {} }), {
            label: "Inspect UI Manifest",
            description: "Return this session plugin's declarative TUI contribution manifest.",
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
        ui_manifest_version: 1,
      },
      summary: "Active first-party session runtime plugins.",
      items,
    };
  }

  localTools(activeTurn: ActivePluginTurn | null): LocalRuntimeTool[] {
    return this.plugins.flatMap((plugin) => plugin.localTools?.(this.ctx, activeTurn) ?? []);
  }

  acceptQueuedTurn(message: QueuedSessionMessage): PluginTurnRequest | null {
    const pluginId =
      message.pluginId ?? (message.author === "goal" ? "persistent-goal" : undefined);
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

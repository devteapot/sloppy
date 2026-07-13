import type { ItemDescriptor, NodeDescriptor } from "@slop-ai/server";

import type { LocalRuntimeTool } from "../../core/agent";
import type { QueuedSessionMessage } from "../types";
import type { ClientContributionManifest } from "./client-contributions";
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
  ) {
    validateSessionPluginIds(plugins);
    validateClientContributions(plugins, ctx);
  }

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

  autoCloseBlockers(): { pluginId: string; id: string; label: string }[] {
    return this.plugins.flatMap((plugin) =>
      (plugin.autoCloseBlockers?.(this.ctx) ?? []).map((blocker) => ({
        pluginId: plugin.id,
        id: blocker.id,
        label: blocker.label,
      })),
    );
  }

  clientPlugins(): Array<{
    id: string;
    version: string;
    status: "active";
    description?: string;
    providerIds: string[];
    extensionNamespaces: string[];
    contributions: ClientContributionManifest;
  }> {
    const snapshot = this.ctx.snapshot();
    return this.plugins.map((plugin) => {
      const commands = new Map(
        (plugin.clientCommands?.(this.ctx) ?? []).map((command) => [command.id, command]),
      );
      return {
        id: plugin.id,
        version: plugin.version,
        status: "active",
        description: plugin.description,
        providerIds: plugin.providerIds ?? [],
        extensionNamespaces: plugin.extensionNamespaces ?? [],
        contributions: {
          actions: (plugin.client?.actions ?? []).map((action) => ({
            ...action,
            available:
              commands.get(action.command)?.available?.(snapshot) ?? commands.has(action.command),
          })),
          indicators: plugin.client?.indicators ?? [],
          notifications: plugin.client?.notifications ?? [],
        },
      };
    });
  }

  async invokeClientCommand(
    pluginId: string,
    commandId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const plugin = this.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`Unknown session plugin: ${pluginId}`);
    const command = plugin
      .clientCommands?.(this.ctx)
      .find((candidate) => candidate.id === commandId);
    if (!command) throw new Error(`Unknown client command ${pluginId}:${commandId}`);
    if (command.available && !command.available(this.ctx.snapshot())) {
      throw new Error(`Client command is not currently available: ${pluginId}:${commandId}`);
    }
    return command.execute(this.ctx, params);
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
        },
        summary: plugin.description ?? plugin.id,
      };
    });

    return {
      type: "collection",
      props: {
        count: items.length,
        ids: items.map((item) => item.id),
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

function validateClientContributions(
  plugins: SessionRuntimePlugin[],
  ctx: PluginRuntimeContext,
): void {
  for (const plugin of plugins) {
    const commands = plugin.clientCommands?.(ctx) ?? [];
    const commandIds = new Set<string>();
    for (const command of commands) {
      if (!command.id)
        throw new Error(`Session plugin ${plugin.id} has an empty client command id.`);
      if (commandIds.has(command.id)) {
        throw new Error(`Duplicate client command ${plugin.id}:${command.id}.`);
      }
      commandIds.add(command.id);
    }
    const actionIds = new Set<string>();
    for (const action of plugin.client?.actions ?? []) {
      if (actionIds.has(action.id)) {
        throw new Error(`Duplicate client action ${plugin.id}:${action.id}.`);
      }
      actionIds.add(action.id);
      if (!commandIds.has(action.command)) {
        throw new Error(
          `Client action ${plugin.id}:${action.id} references unknown command ${action.command}.`,
        );
      }
    }
  }
}

function validateSessionPluginIds(plugins: SessionRuntimePlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.id || /[\s:]/.test(plugin.id)) {
      throw new Error(
        `Invalid session plugin id '${plugin.id}'. Plugin ids must be non-empty and cannot contain whitespace or ':'.`,
      );
    }
    if (seen.has(plugin.id)) {
      throw new Error(`Duplicate session plugin id '${plugin.id}'. Plugin ids must be unique.`);
    }
    seen.add(plugin.id);
  }
}

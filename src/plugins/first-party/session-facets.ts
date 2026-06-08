import type { SloppyConfig } from "../../config/schema";
import type { ToolEventEnricher } from "../../session/event-bus";
import type { SessionRuntimePlugin } from "../../session/plugins";
import { createDelegationWaitTool } from "./delegation/runtime/wait-tool";
import { filesystemToolEventEnricher } from "./filesystem/audit";
import {
  activeFirstPartyPluginMetadata,
  type FirstPartyPluginMetadata,
  isFirstPartyPluginEnabled,
} from "./manifest";
import { createPersistentGoalPlugin } from "./persistent-goal/session";
import { voiceManagerFor } from "./voice/runtime";
import { createVoicePlugin } from "./voice/session";
import { createVoiceConversationPlugin } from "./voice-conversation/session";

export function metadataSessionPlugin(plugin: FirstPartyPluginMetadata): SessionRuntimePlugin {
  if (plugin.extensionNamespaces?.length) {
    throw new Error(
      `First-party plugin '${plugin.id}' declares extensionNamespaces but has no session facet.`,
    );
  }
  return {
    id: plugin.id,
    version: plugin.version,
    description: plugin.description,
    defaultEnabled: plugin.defaultEnabled,
    providerIds: plugin.providerIds ? [...plugin.providerIds] : undefined,
    extensionNamespaces: plugin.extensionNamespaces ? [...plugin.extensionNamespaces] : undefined,
  };
}

export function createFirstPartySessionPlugins(config: SloppyConfig): SessionRuntimePlugin[] {
  return activeFirstPartyPluginMetadata(config).map((plugin) => {
    if (plugin.id === "persistent-goal") {
      return createPersistentGoalPlugin();
    }
    if (plugin.id === "delegation") {
      return {
        ...metadataSessionPlugin(plugin),
        localTools: () => [createDelegationWaitTool()],
      };
    }
    if (plugin.id === "voice") {
      return createVoicePlugin(voiceManagerFor(config));
    }
    if (plugin.id === "voice-conversation") {
      return createVoiceConversationPlugin(config.plugins["voice-conversation"]);
    }
    return metadataSessionPlugin(plugin);
  });
}

export function createFirstPartyToolEventEnrichers(config: SloppyConfig): ToolEventEnricher[] {
  const filesystem = activeFirstPartyPluginMetadata(config).find(
    (plugin) => plugin.id === "filesystem",
  );
  return filesystem && isFirstPartyPluginEnabled(config, filesystem)
    ? [filesystemToolEventEnricher]
    : [];
}

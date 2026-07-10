import type { SloppyConfig } from "../../config/schema";
import type { UiContributionManifest } from "../../session/plugins";

export type FirstPartyPluginMetadata = {
  id: keyof SloppyConfig["plugins"] & string;
  version: string;
  description?: string;
  defaultEnabled: boolean;
  providerIds?: string[];
  extensionNamespaces?: string[];
  ui?: UiContributionManifest;
};

export const FIRST_PARTY_PLUGIN_MANIFEST = [
  {
    id: "persistent-goal",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Persistent long-running session objective controls.",
    extensionNamespaces: ["goal"],
  },
  {
    id: "apps",
    version: "1.0.0",
    defaultEnabled: true,
    description: "External app discovery and load/unload controls.",
    providerIds: ["apps"],
  },
  {
    id: "terminal",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Terminal command execution provider.",
    providerIds: ["terminal"],
  },
  {
    id: "filesystem",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Workspace filesystem state and file editing provider.",
    providerIds: ["filesystem"],
  },
  {
    id: "memory",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Session memory provider.",
    providerIds: ["memory"],
  },
  {
    id: "skills",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Hermes-style skill discovery and management provider.",
    providerIds: ["skills"],
  },
  {
    id: "meta-runtime",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Optional topology and self-evolution provider.",
    providerIds: ["meta-runtime"],
    ui: {},
  },
  {
    id: "web",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Web search and read provider.",
    providerIds: ["web"],
  },
  {
    id: "browser",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Browser automation provider.",
    providerIds: ["browser"],
  },
  {
    id: "cron",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Scheduled job provider.",
    providerIds: ["cron"],
  },
  {
    id: "messaging",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Internal typed messaging provider.",
    providerIds: ["messaging"],
  },
  {
    id: "delegation",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Delegated child-agent provider and wait tool.",
    providerIds: ["delegation"],
  },
  {
    id: "spec",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Workspace specification provider.",
    providerIds: ["spec"],
  },
  {
    id: "vision",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Image generation and analysis provider.",
    providerIds: ["vision"],
  },
  {
    id: "workspaces",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Workspace and scoped config provider.",
    providerIds: ["workspaces"],
  },
  {
    id: "a2a",
    version: "1.0.0",
    defaultEnabled: false,
    description: "A2A interoperability provider.",
    providerIds: ["a2a"],
  },
  {
    id: "mcp",
    version: "1.0.0",
    defaultEnabled: false,
    description: "MCP compatibility provider.",
    providerIds: ["mcp"],
  },
] as const satisfies readonly FirstPartyPluginMetadata[];

export const FIRST_PARTY_PLUGIN_BY_ID = new Map(
  FIRST_PARTY_PLUGIN_MANIFEST.map((plugin) => [plugin.id, plugin]),
);

export function firstPartyPluginMetadata(
  id: FirstPartyPluginMetadata["id"],
): FirstPartyPluginMetadata {
  const plugin = FIRST_PARTY_PLUGIN_BY_ID.get(id);
  if (!plugin) {
    throw new Error(`Unknown first-party plugin metadata: ${id}`);
  }
  return plugin;
}

export function isFirstPartyPluginEnabled(
  config: SloppyConfig,
  plugin: FirstPartyPluginMetadata,
): boolean {
  return config.plugins[plugin.id]?.enabled ?? plugin.defaultEnabled;
}

export function activeFirstPartyPluginMetadata(config: SloppyConfig): FirstPartyPluginMetadata[] {
  return FIRST_PARTY_PLUGIN_MANIFEST.filter((plugin) => isFirstPartyPluginEnabled(config, plugin));
}

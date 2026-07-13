import { join } from "node:path";

import { getHomeConfigPath } from "../../config/load";
import type { SloppyConfig } from "../../config/schema";
import { InProcessTransport } from "../../providers/in-process";
import type { RegisteredProvider } from "../../providers/registry";
import { RuntimeServiceRegistry } from "../../runtime/services";
import { A2AProvider } from "./a2a/provider";
import { AppsProvider } from "./apps/provider";
import { BrowserProvider } from "./browser/provider";
import { CronProvider } from "./cron/provider";
import { DelegationProvider } from "./delegation/provider";
import { attachSubAgentRunnerFactory } from "./delegation/runtime/runner-factory";
import { FilesystemProvider } from "./filesystem/provider";
import {
  type FirstPartyPluginMetadata,
  firstPartyPluginMetadata,
  isFirstPartyPluginEnabled,
} from "./manifest";
import { McpProvider } from "./mcp/provider";
import { MemoryProvider } from "./memory/provider";
import { MessagingProvider } from "./messaging/provider";
import { MetaRuntimeProvider } from "./meta-runtime/provider";
import { DELEGATION_SERVICE, MESSAGING_SERVICE, SKILLS_SERVICE } from "./service-keys";
import { SkillsProvider } from "./skills/provider";
import { SpecProvider } from "./spec/provider";
import { TerminalProvider } from "./terminal/provider";
import { VisionProvider } from "./vision/provider";
import { WebProvider } from "./web/provider";
import { WorkspacesProvider } from "./workspaces/provider";

function registeredProvider(
  input: Omit<RegisteredProvider, "kind"> & { kind?: RegisteredProvider["kind"] },
): RegisteredProvider {
  return {
    ...input,
    kind: input.kind ?? "first-party",
  };
}

export type FirstPartyPluginDescriptor = FirstPartyPluginMetadata & {
  createProviders?: (
    config: SloppyConfig,
    services: RuntimeServiceRegistry,
  ) => RegisteredProvider[];
};

export type FirstPartyPluginAssembly = {
  providers: RegisteredProvider[];
  services: RuntimeServiceRegistry;
};

export const FIRST_PARTY_PLUGINS: FirstPartyPluginDescriptor[] = [
  {
    ...firstPartyPluginMetadata("persistent-goal"),
  },
  {
    ...firstPartyPluginMetadata("apps"),
    createProviders: () => {
      const apps = new AppsProvider();
      return [
        registeredProvider({
          id: "apps",
          name: "Apps",
          transport: new InProcessTransport(apps.server),
          transportLabel: "in-process",
          stop: () => apps.stop(),
          attachRuntime: (hub) => {
            apps.setHub(hub);
            return {
              stop() {
                apps.setHub(null);
              },
            };
          },
          systemPromptFragment: () =>
            [
              "External apps are listed by the apps provider under /available.",
              "Discovered apps are unloaded by default. Load only apps relevant to the current task, then inspect their provider state with query_state or focus_state.",
              "Unload external apps when they are no longer relevant so their state and affordances leave the agent context.",
            ].join("\n"),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("terminal"),
    createProviders: (config) => {
      const plugin = config.plugins.terminal;
      const terminal = new TerminalProvider({
        cwd: plugin.cwd,
        historyLimit: plugin.historyLimit,
        syncTimeoutMs: plugin.syncTimeoutMs,
      });
      return [
        registeredProvider({
          id: "terminal",
          name: "Terminal",
          transport: new InProcessTransport(terminal.server),
          transportLabel: "in-process",
          stop: () => terminal.stop(),
          approvals: terminal.approvals,
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("filesystem"),
    createProviders: (config) => {
      const plugin = config.plugins.filesystem;
      const filesystem = new FilesystemProvider({
        root: plugin.root,
        focus: plugin.focus ?? plugin.root,
        recentLimit: plugin.recentLimit,
        searchLimit: plugin.searchLimit,
        readMaxBytes: plugin.readMaxBytes,
        contentRefThresholdBytes: plugin.contentRefThresholdBytes,
        previewBytes: plugin.previewBytes,
      });
      return [
        registeredProvider({
          id: "filesystem",
          name: "Filesystem",
          transport: new InProcessTransport(filesystem.server),
          transportLabel: "in-process",
          stop: () => filesystem.stop(),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("memory"),
    createProviders: (config) => {
      const plugin = config.plugins.memory;
      const memory = new MemoryProvider({
        maxMemories: plugin.maxMemories,
        defaultWeight: plugin.defaultWeight,
        compactThreshold: plugin.compactThreshold,
      });
      return [
        registeredProvider({
          id: "memory",
          name: "Memory",
          transport: new InProcessTransport(memory.server),
          transportLabel: "in-process",
          stop: () => memory.stop(),
          approvals: memory.approvals,
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("skills"),
    createProviders: (config, services) => {
      const plugin = config.plugins.skills;
      const metaRuntime = config.plugins["meta-runtime"];
      const skills = new SkillsProvider({
        builtinSkillsDir: plugin.builtinSkillsDir,
        skillsDir: plugin.skillsDir,
        globalSkillsDir: join(metaRuntime.globalRoot, "skills"),
        workspaceSkillsDir: join(metaRuntime.workspaceRoot, "skills"),
        externalDirs: plugin.externalDirs ?? [],
        templateVars: plugin.templateVars ?? true,
        viewMaxBytes: plugin.viewMaxBytes ?? 65536,
      });
      services.bind(SKILLS_SERVICE, skills);
      return [
        registeredProvider({
          id: "skills",
          name: "Skills",
          transport: new InProcessTransport(skills.server),
          transportLabel: "in-process",
          stop: () => skills.stop(),
          approvals: skills.approvals,
          systemPromptFragment: () =>
            [
              "Skills use progressive disclosure.",
              "Use the skills provider's compact /skills list to decide relevance, then call skill_view with a skill name to load SKILL.md.",
              "If a skill advertises supporting_files, call skill_view with file_path to load only the needed reference, template, or script.",
              "When a repeatable workflow should become procedural memory, use skill_manage; persistent workspace/global skill changes require approval.",
            ].join("\n"),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("meta-runtime"),
    createProviders: (config, services) => {
      const plugin = config.plugins["meta-runtime"];
      const metaRuntime = new MetaRuntimeProvider({
        globalRoot: plugin.globalRoot,
        workspaceRoot: plugin.workspaceRoot,
        services,
      });
      return [
        registeredProvider({
          id: "meta-runtime",
          name: "Meta Runtime",
          transport: new InProcessTransport(metaRuntime.server),
          transportLabel: "in-process",
          stop: () => metaRuntime.stop(),
          approvals: metaRuntime.approvals,
          attachRuntime: (_hub, _hubConfig, ctx) => {
            metaRuntime.setEventPublisher(ctx?.publishEvent);
            return {
              stop() {
                metaRuntime.setEventPublisher();
              },
            };
          },
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("web"),
    createProviders: (config) => {
      const web = new WebProvider({ historyLimit: config.plugins.web.historyLimit });
      return [
        registeredProvider({
          id: "web",
          name: "Web",
          transport: new InProcessTransport(web.server),
          transportLabel: "in-process",
          stop: () => web.stop(),
          approvals: web.approvals,
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("browser"),
    createProviders: (config) => {
      const plugin = config.plugins.browser;
      const browser = new BrowserProvider({
        viewportWidth: plugin.viewportWidth,
        viewportHeight: plugin.viewportHeight,
      });
      return [
        registeredProvider({
          id: "browser",
          name: "Browser",
          transport: new InProcessTransport(browser.server),
          transportLabel: "in-process",
          stop: () => browser.stop(),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("cron"),
    createProviders: (config) => {
      const cron = new CronProvider({ maxJobs: config.plugins.cron.maxJobs });
      return [
        registeredProvider({
          id: "cron",
          name: "Cron",
          transport: new InProcessTransport(cron.server),
          transportLabel: "in-process",
          stop: () => cron.stop(),
          approvals: cron.approvals,
          attachRuntime: (hub) => {
            cron.setRunner({
              invoke: hub.invoke.bind(hub),
              cancelApproval: (id, reason) => hub.approvals.cancel(id, reason),
            });
            return {
              stop() {
                cron.setRunner(null);
              },
            };
          },
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("messaging"),
    createProviders: (config, services) => {
      const messaging = new MessagingProvider({
        maxMessages: config.plugins.messaging.maxMessages,
      });
      services.bind(MESSAGING_SERVICE, messaging);
      return [
        registeredProvider({
          id: "messaging",
          name: "Messaging",
          transport: new InProcessTransport(messaging.server),
          transportLabel: "in-process",
          stop: () => messaging.stop(),
          approvals: messaging.approvals,
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("delegation"),
    createProviders: (config, services) => {
      const delegation = new DelegationProvider({
        maxAgents: config.plugins.delegation.maxAgents,
      });
      services.bind(DELEGATION_SERVICE, delegation);
      return [
        registeredProvider({
          id: "delegation",
          name: "Delegation",
          transport: new InProcessTransport(delegation.server),
          transportLabel: "in-process",
          stop: () => delegation.stop(),
          approvals: delegation.approvals,
          systemPromptFragment: () =>
            [
              "Delegation child agents run as background child sessions.",
              "Use spawn_agent to start child work without blocking.",
              "If the user asks you to work in parallel or in the meantime, do your own independent work before the first delegation wait.",
              "When you need child progress, call slop_wait_for_delegation_event with the agent ids instead of repeatedly querying delegation /agents.",
              "A wait returns one wake event; wait again when more children remain active.",
              "Call get_result before relying on a completed child's findings.",
              "After retrieving a child's final result, close that child session unless you need a follow-up turn.",
            ].join("\n"),
          attachRuntime: (hub, hubConfig, ctx) => {
            attachSubAgentRunnerFactory(
              delegation,
              hub,
              hubConfig,
              ctx?.llmProfileManager,
              ctx?.childSessionFactory,
            );
            return {
              stop() {},
            };
          },
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("spec"),
    createProviders: (config) => {
      const spec = new SpecProvider({ workspaceRoot: config.plugins.filesystem.root });
      return [
        registeredProvider({
          id: "spec",
          name: "Spec",
          transport: new InProcessTransport(spec.server),
          transportLabel: "in-process",
          stop: () => spec.stop(),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("vision"),
    createProviders: (config) => {
      const plugin = config.plugins.vision;
      const vision = new VisionProvider({
        maxImages: plugin.maxImages,
        defaultWidth: plugin.defaultWidth,
        defaultHeight: plugin.defaultHeight,
      });
      return [
        registeredProvider({
          id: "vision",
          name: "Vision",
          transport: new InProcessTransport(vision.server),
          transportLabel: "in-process",
          stop: () => vision.stop(),
          approvals: vision.approvals,
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("workspaces"),
    createProviders: (config) => {
      const workspaces = new WorkspacesProvider({
        registry: config.workspaces,
        globalConfigPath: getHomeConfigPath(),
      });
      return [
        registeredProvider({
          id: "workspaces",
          name: "Workspaces",
          transport: new InProcessTransport(workspaces.server),
          transportLabel: "in-process",
          stop: () => workspaces.stop(),
          systemPromptFragment: () =>
            [
              "Workspace and project scopes are exposed through the workspaces provider.",
              "Use /workspaces and /projects to inspect configured roots and active scoped config layers.",
              "A workspace or project config layer can scope optional providers such as mcp without making core provider logic special.",
            ].join("\n"),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("a2a"),
    createProviders: (config) => {
      const plugin = config.plugins.a2a;
      const a2a = new A2AProvider({
        agents: plugin.agents ?? {},
        fetchOnStart: plugin.fetchOnStart ?? true,
      });
      return [
        registeredProvider({
          id: "a2a",
          name: "A2A",
          transport: new InProcessTransport(a2a.server),
          transportLabel: "in-process",
          stop: () => a2a.stop(),
          attachRuntime: () => {
            a2a.start();
            return {
              stop() {},
            };
          },
          systemPromptFragment: () =>
            [
              "A2A interoperability is exposed through the a2a provider as SLOP state.",
              "Use /agents to inspect remote Agent Cards and declared skills before sending messages.",
              "Use A2A for external opaque-agent collaboration; prefer SLOP/meta-runtime routes for internal agent topology.",
            ].join("\n"),
        }),
      ];
    },
  },
  {
    ...firstPartyPluginMetadata("mcp"),
    createProviders: (config) => {
      const plugin = config.plugins.mcp;
      const mcp = new McpProvider({
        servers: plugin.servers ?? {},
        connectOnStart: plugin.connectOnStart ?? true,
      });
      return [
        registeredProvider({
          id: "mcp",
          name: "MCP",
          transport: new InProcessTransport(mcp.server),
          transportLabel: "in-process",
          stop: () => mcp.stop(),
          attachRuntime: () => {
            mcp.start();
            return {
              stop() {},
            };
          },
          systemPromptFragment: () =>
            [
              "MCP compatibility is exposed through the mcp provider as SLOP state.",
              "Use /servers to inspect configured MCP servers, then call MCP tools through the relevant server or tool node.",
              "Prefer MCP for external ecosystem compatibility; keep runtime-native behavior SLOP-first.",
            ].join("\n"),
        }),
      ];
    },
  },
];

export function activeFirstPartyPlugins(config: SloppyConfig): FirstPartyPluginDescriptor[] {
  return FIRST_PARTY_PLUGINS.filter((plugin) => isFirstPartyPluginEnabled(config, plugin));
}

export function createFirstPartyPluginProviders(config: SloppyConfig): RegisteredProvider[] {
  return createFirstPartyPluginAssembly(config).providers;
}

export function createFirstPartyPluginAssembly(
  config: SloppyConfig,
  services = new RuntimeServiceRegistry(),
): FirstPartyPluginAssembly {
  const providers = activeFirstPartyPlugins(config).flatMap(
    (plugin) => plugin.createProviders?.(config, services) ?? [],
  );
  return { providers, services };
}

export {
  createFirstPartyDoctorChecks,
  createFirstPartyDoctorSubprocessProbes,
} from "./doctor-facets";
export { isFirstPartyPluginEnabled } from "./manifest";
export { createFirstPartyPluginPolicyRules } from "./policy-facets";
export {
  createFirstPartySessionPlugins,
  createFirstPartyToolEventEnrichers,
  metadataSessionPlugin,
} from "./session-facets";

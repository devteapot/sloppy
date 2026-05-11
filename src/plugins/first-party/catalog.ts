import { join } from "node:path";

import { getHomeConfigPath } from "../../config/load";
import type { SloppyConfig } from "../../config/schema";
import type { InvokePolicy } from "../../core/policy";
import { InProcessTransport } from "../../providers/in-process";
import type { RegisteredProvider } from "../../providers/registry";
import type {
  RuntimeDoctorCheckFactory,
  RuntimeDoctorSubprocessProbeFactory,
} from "../../runtime/doctor-types";
import type { ToolEventEnricher } from "../../session/event-bus";
import type { SessionRuntimePlugin } from "../../session/plugins";
import type { FirstPartyPluginDescriptor } from "../types";
import { A2AProvider } from "./a2a/provider";
import { BrowserProvider } from "./browser/provider";
import { CronProvider } from "./cron/provider";
import { checkAcpAdapter, checkAcpBoundary, collectAcpSubprocessProbes } from "./delegation/doctor";
import { DelegationProvider } from "./delegation/provider";
import { attachSubAgentRunnerFactory, createDelegationWaitTool } from "./delegation/runtime";
import { filesystemToolEventEnricher } from "./filesystem/audit";
import { checkWorkspacePaths } from "./filesystem/doctor";
import { FilesystemProvider } from "./filesystem/provider";
import { collectMcpSubprocessProbes } from "./mcp/doctor";
import { McpProvider } from "./mcp/provider";
import { MemoryProvider } from "./memory/provider";
import { MessagingProvider } from "./messaging/provider";
import { checkMetaRuntimePersistence } from "./meta-runtime/doctor";
import { MetaRuntimeProvider } from "./meta-runtime/provider";
import { createPersistentGoalPlugin } from "./persistent-goal/session";
import { SkillsProvider } from "./skills/provider";
import { SpecProvider } from "./spec/provider";
import { terminalSafetyRule } from "./terminal/policy";
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

function metadataSessionPlugin(plugin: FirstPartyPluginDescriptor): SessionRuntimePlugin {
  return {
    id: plugin.id,
    version: plugin.version,
    description: plugin.description,
    defaultEnabled: plugin.defaultEnabled,
    providerIds: plugin.providerIds,
    extensionNamespaces: plugin.extensionNamespaces,
    tui: plugin.tui,
  };
}

export const FIRST_PARTY_PLUGINS: FirstPartyPluginDescriptor[] = [
  {
    id: "persistent-goal",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Persistent long-running session objective controls.",
    extensionNamespaces: ["goal"],
    createSessionPlugin: () => createPersistentGoalPlugin(),
  },
  {
    id: "terminal",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Terminal command execution provider.",
    providerIds: ["terminal"],
    policyRules: () => [terminalSafetyRule],
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
    id: "filesystem",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Workspace filesystem state and file editing provider.",
    providerIds: ["filesystem"],
    doctorChecks: () => [checkWorkspacePaths],
    toolEventEnrichers: () => [filesystemToolEventEnricher],
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
    id: "memory",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Session memory provider.",
    providerIds: ["memory"],
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
    id: "skills",
    version: "1.0.0",
    defaultEnabled: true,
    description: "Hermes-style skill discovery and management provider.",
    providerIds: ["skills"],
    createProviders: (config) => {
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
    id: "meta-runtime",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Optional topology and self-evolution provider.",
    providerIds: ["meta-runtime"],
    tui: {
      commands: [
        {
          id: "runtime",
          name: "runtime",
          signature:
            "[refresh|export|inspect <proposal-id>|apply <proposal-id>|revert <proposal-id>]",
          description: "Open or manage meta-runtime proposals",
        },
      ],
    },
    doctorChecks: () => [checkMetaRuntimePersistence],
    createProviders: (config) => {
      const plugin = config.plugins["meta-runtime"];
      const metaRuntime = new MetaRuntimeProvider({
        globalRoot: plugin.globalRoot,
        workspaceRoot: plugin.workspaceRoot,
      });
      return [
        registeredProvider({
          id: "meta-runtime",
          name: "Meta Runtime",
          transport: new InProcessTransport(metaRuntime.server),
          transportLabel: "in-process",
          stop: () => metaRuntime.stop(),
          approvals: metaRuntime.approvals,
          attachRuntime: (hub, _hubConfig, ctx) => {
            metaRuntime.setHub(hub, ctx?.publishEvent);
            return {
              stop() {
                metaRuntime.setHub(null);
              },
            };
          },
        }),
      ];
    },
  },
  {
    id: "web",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Web search and read provider.",
    providerIds: ["web"],
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
    id: "browser",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Browser automation provider.",
    providerIds: ["browser"],
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
    id: "cron",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Scheduled job provider.",
    providerIds: ["cron"],
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
    id: "messaging",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Internal typed messaging provider.",
    providerIds: ["messaging"],
    createProviders: (config) => {
      const messaging = new MessagingProvider({
        maxMessages: config.plugins.messaging.maxMessages,
      });
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
    id: "delegation",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Delegated child-agent provider and wait tool.",
    providerIds: ["delegation"],
    doctorChecks: () => [checkAcpAdapter, checkAcpBoundary],
    doctorSubprocessProbes: () => [collectAcpSubprocessProbes],
    createProviders: (config) => {
      const delegation = new DelegationProvider({
        maxAgents: config.plugins.delegation.maxAgents,
      });
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
            attachSubAgentRunnerFactory(delegation, hub, hubConfig, ctx?.llmProfileManager);
            return {
              stop() {},
            };
          },
        }),
      ];
    },
    createSessionPlugin: () => ({
      id: "delegation",
      version: "1.0.0",
      description: "Delegated child-agent provider and wait tool.",
      defaultEnabled: false,
      providerIds: ["delegation"],
      localTools: () => [createDelegationWaitTool()],
    }),
  },
  {
    id: "spec",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Workspace specification provider.",
    providerIds: ["spec"],
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
    id: "vision",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Image generation and analysis provider.",
    providerIds: ["vision"],
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
    id: "workspaces",
    version: "1.0.0",
    defaultEnabled: false,
    description: "Workspace and scoped config provider.",
    providerIds: ["workspaces"],
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
    id: "a2a",
    version: "1.0.0",
    defaultEnabled: false,
    description: "A2A interoperability provider.",
    providerIds: ["a2a"],
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
    id: "mcp",
    version: "1.0.0",
    defaultEnabled: false,
    description: "MCP compatibility provider.",
    providerIds: ["mcp"],
    doctorSubprocessProbes: () => [collectMcpSubprocessProbes],
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

export function isFirstPartyPluginEnabled(
  config: SloppyConfig,
  plugin: FirstPartyPluginDescriptor,
): boolean {
  return config.plugins[plugin.id]?.enabled ?? plugin.defaultEnabled;
}

export function activeFirstPartyPlugins(config: SloppyConfig): FirstPartyPluginDescriptor[] {
  return FIRST_PARTY_PLUGINS.filter((plugin) => isFirstPartyPluginEnabled(config, plugin));
}

export function createFirstPartyPluginProviders(config: SloppyConfig): RegisteredProvider[] {
  return activeFirstPartyPlugins(config).flatMap(
    (plugin) => plugin.createProviders?.(config) ?? [],
  );
}

export function createFirstPartySessionPlugins(config: SloppyConfig): SessionRuntimePlugin[] {
  return activeFirstPartyPlugins(config).map((plugin) =>
    plugin.createSessionPlugin ? plugin.createSessionPlugin(config) : metadataSessionPlugin(plugin),
  );
}

export function createFirstPartyPluginPolicyRules(config: SloppyConfig): InvokePolicy[] {
  return activeFirstPartyPlugins(config).flatMap((plugin) => plugin.policyRules?.(config) ?? []);
}

export function createFirstPartyToolEventEnrichers(config: SloppyConfig): ToolEventEnricher[] {
  return activeFirstPartyPlugins(config).flatMap(
    (plugin) => plugin.toolEventEnrichers?.(config) ?? [],
  );
}

export function createFirstPartyDoctorChecks(config: SloppyConfig): RuntimeDoctorCheckFactory[] {
  return FIRST_PARTY_PLUGINS.flatMap((plugin) => plugin.doctorChecks?.(config) ?? []);
}

export function createFirstPartyDoctorSubprocessProbes(
  config: SloppyConfig,
): RuntimeDoctorSubprocessProbeFactory[] {
  return FIRST_PARTY_PLUGINS.flatMap((plugin) => plugin.doctorSubprocessProbes?.(config) ?? []);
}

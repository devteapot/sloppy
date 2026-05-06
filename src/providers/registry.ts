import { join } from "node:path";
import type { ClientTransport } from "@slop-ai/consumer/browser";
import { WebSocketClientTransport } from "@slop-ai/consumer/browser";
import { getHomeConfigPath } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import type { ProviderRuntimeHub } from "../core/hub";
import type { RuntimeContext } from "../core/role";
import { attachSubAgentRunnerFactory } from "../runtime/delegation";
import type { ProviderApprovalManager } from "./approvals";
import { A2AProvider } from "./builtin/a2a";
import { BrowserProvider } from "./builtin/browser";
import { CronProvider } from "./builtin/cron";
import { DelegationProvider } from "./builtin/delegation";
import { FilesystemProvider } from "./builtin/filesystem";
import { InProcessTransport } from "./builtin/in-process";
import { McpProvider } from "./builtin/mcp";
import { MemoryProvider } from "./builtin/memory";
import { MessagingProvider } from "./builtin/messaging";
import { MetaRuntimeProvider } from "./builtin/meta-runtime";
import { SkillsProvider } from "./builtin/skills";
import { SpecProvider } from "./builtin/spec";
import { TerminalProvider } from "./builtin/terminal";
import { VisionProvider } from "./builtin/vision";
import { WebProvider } from "./builtin/web";
import { WorkspacesProvider } from "./builtin/workspaces";
import {
  discoverProviderDescriptors,
  type ProviderDescriptor,
  type ProviderTransportDescriptor,
} from "./discovery";
import { NodeSocketClientTransport } from "./node-socket";

export interface RegisteredProvider {
  id: string;
  name: string;
  kind: "builtin" | "external";
  transport: ClientTransport;
  transportLabel: string;
  stop?: () => void;
  systemPromptFragment?: (config: SloppyConfig) => string | null;
  attachRuntime?: (
    hub: ProviderRuntimeHub,
    config: SloppyConfig,
    ctx?: RuntimeContext,
  ) => { stop(): void } | undefined;
  /**
   * Optional reference to the provider's `ProviderApprovalManager`. When
   * present, the registry / hub connects it to `hub.approvals` so all
   * policy-mediated and provider-native approval requests share one queue.
   */
  approvals?: ProviderApprovalManager;
}

export function describeProviderTransport(transport: ProviderTransportDescriptor): string {
  switch (transport.type) {
    case "unix":
      return `unix:${transport.path}`;
    case "ws":
      return `ws:${transport.url}`;
    case "stdio":
      return `stdio:${transport.command.join(" ")}`;
    case "pipe":
      return `pipe:${transport.name}`;
    case "postmessage":
      return "postmessage";
  }
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
      transportLabel: "in-process",
      stop: () => terminal.stop(),
      approvals: terminal.approvals,
    });
  }

  if (config.providers.builtin.filesystem) {
    const filesystem = new FilesystemProvider({
      root: config.providers.filesystem.root,
      focus: config.providers.filesystem.focus ?? config.providers.filesystem.root,
      recentLimit: config.providers.filesystem.recentLimit,
      searchLimit: config.providers.filesystem.searchLimit,
      readMaxBytes: config.providers.filesystem.readMaxBytes,
      contentRefThresholdBytes: config.providers.filesystem.contentRefThresholdBytes,
      previewBytes: config.providers.filesystem.previewBytes,
    });
    providers.push({
      id: "filesystem",
      name: "Filesystem",
      kind: "builtin",
      transport: new InProcessTransport(filesystem.server),
      transportLabel: "in-process",
      stop: () => filesystem.stop(),
    });
  }

  if (config.providers.builtin.memory) {
    const memory = new MemoryProvider({
      maxMemories: config.providers.memory.maxMemories,
      defaultWeight: config.providers.memory.defaultWeight,
      compactThreshold: config.providers.memory.compactThreshold,
    });
    providers.push({
      id: "memory",
      name: "Memory",
      kind: "builtin",
      transport: new InProcessTransport(memory.server),
      transportLabel: "in-process",
      stop: () => memory.stop(),
      approvals: memory.approvals,
    });
  }

  if (config.providers.builtin.skills) {
    const skills = new SkillsProvider({
      builtinSkillsDir: config.providers.skills.builtinSkillsDir,
      skillsDir: config.providers.skills.skillsDir,
      globalSkillsDir: join(config.providers.metaRuntime.globalRoot, "skills"),
      workspaceSkillsDir: join(config.providers.metaRuntime.workspaceRoot, "skills"),
      externalDirs: config.providers.skills.externalDirs ?? [],
      templateVars: config.providers.skills.templateVars ?? true,
      viewMaxBytes: config.providers.skills.viewMaxBytes ?? 65536,
    });
    providers.push({
      id: "skills",
      name: "Skills",
      kind: "builtin",
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
    });
  }

  if (config.providers.builtin.metaRuntime) {
    const metaRuntime = new MetaRuntimeProvider({
      globalRoot: config.providers.metaRuntime.globalRoot,
      workspaceRoot: config.providers.metaRuntime.workspaceRoot,
    });
    providers.push({
      id: "meta-runtime",
      name: "Meta Runtime",
      kind: "builtin",
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
    });
  }

  if (config.providers.builtin.web) {
    const web = new WebProvider({
      historyLimit: config.providers.web.historyLimit,
    });
    providers.push({
      id: "web",
      name: "Web",
      kind: "builtin",
      transport: new InProcessTransport(web.server),
      transportLabel: "in-process",
      stop: () => web.stop(),
      approvals: web.approvals,
    });
  }

  if (config.providers.builtin.browser) {
    const browser = new BrowserProvider({
      viewportWidth: config.providers.browser.viewportWidth,
      viewportHeight: config.providers.browser.viewportHeight,
    });
    providers.push({
      id: "browser",
      name: "Browser",
      kind: "builtin",
      transport: new InProcessTransport(browser.server),
      transportLabel: "in-process",
      stop: () => browser.stop(),
    });
  }

  if (config.providers.builtin.cron) {
    const cron = new CronProvider({
      maxJobs: config.providers.cron.maxJobs,
    });
    providers.push({
      id: "cron",
      name: "Cron",
      kind: "builtin",
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
    });
  }

  if (config.providers.builtin.messaging) {
    const messaging = new MessagingProvider({
      maxMessages: config.providers.messaging.maxMessages,
    });
    providers.push({
      id: "messaging",
      name: "Messaging",
      kind: "builtin",
      transport: new InProcessTransport(messaging.server),
      transportLabel: "in-process",
      stop: () => messaging.stop(),
      approvals: messaging.approvals,
    });
  }

  if (config.providers.builtin.delegation) {
    const delegation = new DelegationProvider({
      maxAgents: config.providers.delegation.maxAgents,
    });
    providers.push({
      id: "delegation",
      name: "Delegation",
      kind: "builtin",
      transport: new InProcessTransport(delegation.server),
      transportLabel: "in-process",
      stop: () => delegation.stop(),
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
    });
  }

  if (config.providers.builtin.spec) {
    const spec = new SpecProvider({
      workspaceRoot: config.providers.filesystem.root,
    });
    providers.push({
      id: "spec",
      name: "Spec",
      kind: "builtin",
      transport: new InProcessTransport(spec.server),
      transportLabel: "in-process",
      stop: () => spec.stop(),
    });
  }

  if (config.providers.builtin.vision) {
    const vision = new VisionProvider({
      maxImages: config.providers.vision.maxImages,
      defaultWidth: config.providers.vision.defaultWidth,
      defaultHeight: config.providers.vision.defaultHeight,
    });
    providers.push({
      id: "vision",
      name: "Vision",
      kind: "builtin",
      transport: new InProcessTransport(vision.server),
      transportLabel: "in-process",
      stop: () => vision.stop(),
      approvals: vision.approvals,
    });
  }

  if (config.providers.builtin.workspaces) {
    const workspaces = new WorkspacesProvider({
      registry: config.workspaces,
      globalConfigPath: getHomeConfigPath(),
    });
    providers.push({
      id: "workspaces",
      name: "Workspaces",
      kind: "builtin",
      transport: new InProcessTransport(workspaces.server),
      transportLabel: "in-process",
      stop: () => workspaces.stop(),
      systemPromptFragment: () =>
        [
          "Workspace and project scopes are exposed through the workspaces provider.",
          "Use /workspaces and /projects to inspect configured roots and active scoped config layers.",
          "A workspace or project config layer can scope optional providers such as mcp without making core provider logic special.",
        ].join("\n"),
    });
  }

  if (config.providers.builtin.a2a) {
    const a2a = new A2AProvider({
      agents: config.providers.a2a?.agents ?? {},
      fetchOnStart: config.providers.a2a?.fetchOnStart ?? true,
    });
    providers.push({
      id: "a2a",
      name: "A2A",
      kind: "builtin",
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
    });
  }

  if (config.providers.builtin.mcp) {
    const mcp = new McpProvider({
      servers: config.providers.mcp?.servers ?? {},
      connectOnStart: config.providers.mcp?.connectOnStart ?? true,
    });
    providers.push({
      id: "mcp",
      name: "MCP",
      kind: "builtin",
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
    transportLabel: describeProviderTransport(descriptor.transport),
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

export async function createRegisteredProviders(
  config: SloppyConfig,
): Promise<RegisteredProvider[]> {
  const builtins = createBuiltinProviders(config);
  if (!config.providers.discovery.enabled) {
    return builtins;
  }

  const descriptors = await discoverProviderDescriptors(config.providers.discovery.paths);
  const externalProviders = createDiscoveredProviders(
    descriptors,
    builtins.map((provider) => provider.id),
  );

  return [...builtins, ...externalProviders];
}

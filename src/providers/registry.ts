import type { ClientTransport } from "@slop-ai/consumer/browser";
import { WebSocketClientTransport } from "@slop-ai/consumer/browser";
import type { SloppyConfig } from "../config/schema";
import type { ProviderRuntimeHub } from "../core/hub";
import type { RuntimeContext } from "../core/role";
import { attachSubAgentRunnerFactory } from "../runtime/delegation";
import { attachOrchestrationRuntime } from "../runtime/orchestration/attach";
import type { ProviderApprovalManager } from "./approvals";
import { BrowserProvider } from "./builtin/browser";
import { CronProvider } from "./builtin/cron";
import { DelegationProvider } from "./builtin/delegation";
import { FilesystemProvider } from "./builtin/filesystem";
import { InProcessTransport } from "./builtin/in-process";
import { MemoryProvider } from "./builtin/memory";
import { MessagingProvider } from "./builtin/messaging";
import { OrchestrationProvider } from "./builtin/orchestration";
import { normalizeGatePolicyInput } from "./builtin/orchestration/gate-policy";
import { createLlmPrecedentTieBreaker } from "./builtin/orchestration/precedent-tiebreaker";
import { SkillsProvider } from "./builtin/skills";
import { SpecProvider } from "./builtin/spec";
import { TerminalProvider } from "./builtin/terminal";
import { VisionProvider } from "./builtin/vision";
import { WebProvider } from "./builtin/web";
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
      skillsDir: config.providers.skills.skillsDir,
    });
    providers.push({
      id: "skills",
      name: "Skills",
      kind: "builtin",
      transport: new InProcessTransport(skills.server),
      transportLabel: "in-process",
      stop: () => skills.stop(),
      approvals: skills.approvals,
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
      attachRuntime: (hub, hubConfig, ctx) => {
        const hooks = attachSubAgentRunnerFactory(
          delegation,
          hub,
          hubConfig,
          ctx?.llmProfileManager,
          ctx?.roleRegistry,
        );
        ctx?.setDelegationHooks?.(hooks);
        return {
          stop() {
            ctx?.setDelegationHooks?.(null);
          },
        };
      },
    });
  }

  if (config.providers.builtin.orchestration) {
    const orchestrationDelivery = config.providers.orchestration.delivery ?? {
      slack: {},
      email: { to: [], headers: {} },
    };
    const slackWebhookUrl =
      orchestrationDelivery.slack.webhookUrl ??
      (orchestrationDelivery.slack.webhookUrlEnv
        ? Bun.env[orchestrationDelivery.slack.webhookUrlEnv]
        : undefined);
    const emailEndpointUrl =
      orchestrationDelivery.email.endpointUrl ??
      (orchestrationDelivery.email.endpointUrlEnv
        ? Bun.env[orchestrationDelivery.email.endpointUrlEnv]
        : undefined);
    const emailApiKey = orchestrationDelivery.email.apiKeyEnv
      ? Bun.env[orchestrationDelivery.email.apiKeyEnv]
      : undefined;
    const orchestration = new OrchestrationProvider({
      workspaceRoot: config.providers.filesystem.root,
      progressTailMaxChars: config.providers.orchestration.progressTailMaxChars,
      finalAuditCommandTimeoutMs: config.providers.orchestration.finalAuditCommandTimeoutMs,
      digestDeliveryChannel: orchestrationDelivery.channel,
      digestPolicy: config.providers.orchestration.digest,
      digestDeliverySlack: slackWebhookUrl
        ? {
            webhookUrl: slackWebhookUrl,
            username: orchestrationDelivery.slack.username,
            iconEmoji: orchestrationDelivery.slack.iconEmoji,
          }
        : undefined,
      digestDeliveryEmail:
        emailEndpointUrl &&
        orchestrationDelivery.email.from &&
        orchestrationDelivery.email.to.length > 0
          ? {
              endpointUrl: emailEndpointUrl,
              from: orchestrationDelivery.email.from,
              to: orchestrationDelivery.email.to,
              apiKey: emailApiKey,
              subjectPrefix: orchestrationDelivery.email.subjectPrefix,
              headers: orchestrationDelivery.email.headers,
            }
          : undefined,
      defaultPlanBudget:
        config.providers.orchestration.budget?.wallTimeMs !== undefined ||
        config.providers.orchestration.budget?.retriesPerSlice !== undefined ||
        config.providers.orchestration.budget?.tokenLimit !== undefined ||
        config.providers.orchestration.budget?.costUsd !== undefined
          ? {
              wall_time_ms: config.providers.orchestration.budget.wallTimeMs,
              retries_per_slice: config.providers.orchestration.budget.retriesPerSlice,
              token_limit: config.providers.orchestration.budget.tokenLimit,
              cost_usd: config.providers.orchestration.budget.costUsd,
            }
          : undefined,
      gatePolicy: normalizeGatePolicyInput(config.providers.orchestration.policy),
      guardrails:
        config.providers.orchestration.guardrails?.repeatedFailureLimit !== undefined ||
        config.providers.orchestration.guardrails?.progressStallLimit !== undefined ||
        config.providers.orchestration.guardrails?.progressProjectionRequiresBudget !== undefined ||
        config.providers.orchestration.guardrails?.coherenceReplanRateLimit !== undefined ||
        config.providers.orchestration.guardrails?.coherenceQuestionDensityLimit !== undefined ||
        config.providers.orchestration.guardrails?.blastRadius?.maxFilesModified !== undefined ||
        config.providers.orchestration.guardrails?.blastRadius?.maxDepsAdded !== undefined ||
        config.providers.orchestration.guardrails?.blastRadius?.maxExternalCalls !== undefined ||
        config.providers.orchestration.guardrails?.blastRadius?.publicSurfaceDeltaRequiresGate !==
          undefined
          ? {
              repeated_failure_limit:
                config.providers.orchestration.guardrails.repeatedFailureLimit,
              progress_stall_limit: config.providers.orchestration.guardrails.progressStallLimit,
              progress_projection_requires_budget:
                config.providers.orchestration.guardrails.progressProjectionRequiresBudget,
              coherence_replan_rate_limit:
                config.providers.orchestration.guardrails.coherenceReplanRateLimit,
              coherence_question_density_limit:
                config.providers.orchestration.guardrails.coherenceQuestionDensityLimit,
              blast_radius: {
                max_files_modified:
                  config.providers.orchestration.guardrails.blastRadius?.maxFilesModified,
                max_deps_added: config.providers.orchestration.guardrails.blastRadius?.maxDepsAdded,
                max_external_calls:
                  config.providers.orchestration.guardrails.blastRadius?.maxExternalCalls,
                public_surface_delta_requires_gate:
                  config.providers.orchestration.guardrails.blastRadius
                    ?.publicSurfaceDeltaRequiresGate,
              },
            }
          : undefined,
    });
    providers.push({
      id: "orchestration",
      name: "Orchestration",
      kind: "builtin",
      transport: new InProcessTransport(orchestration.server),
      transportLabel: "in-process",
      stop: () => orchestration.stop(),
      attachRuntime: (hub, hubConfig, ctx) => {
        if (ctx?.llmProfileManager) {
          orchestration.setPrecedentTieBreaker(createLlmPrecedentTieBreaker(ctx.llmProfileManager));
        }
        return attachOrchestrationRuntime(hub, hubConfig, ctx);
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

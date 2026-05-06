import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  defaultConfigPromise,
  getHomeConfigPath,
  getWorkspaceConfigPath,
  loadConfigFromPaths,
} from "../config/load";
import type { LlmProfileConfig, SloppyConfig } from "../config/schema";
import { ConsumerHub } from "../core/consumer";
import { RoleRegistry } from "../core/role";
import { LlmConfigurationError, type LlmProfileManager } from "../llm/profile-manager";
import { buildRuntimeSloppyConfig } from "../llm/runtime-config";
import { createBuiltinProviders, type RegisteredProvider } from "../providers/registry";
import { type AgentEventBus, createAgentEventBus } from "../session/event-bus";

const DEFAULT_CONFIG = await defaultConfigPromise;

export type RuntimeSmokeMode = "providers" | "native" | "acp";

export type RuntimeSmokeOptions = {
  mode?: RuntimeSmokeMode;
  config?: SloppyConfig;
  keepState?: boolean;
  workspaceRoot?: string;
  profileId?: string;
  modelOverride?: string;
  acpAdapterId?: string;
  timeoutMs?: number;
  eventLogPath?: string;
  llmProfileManager?: LlmProfileManager;
  log?: (line: string) => void;
};

export type RuntimeSmokeResult = {
  mode: RuntimeSmokeMode;
  workspaceRoot: string;
  proposalId: string;
  channelId: string;
  dispatch: unknown;
  channelHistory: unknown[];
  delegatedAgent?: {
    id: string;
    status: string;
    resultPreview?: string;
    error?: string;
  };
  eventLogPath?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasStatus(value: unknown): value is { status: string; error?: { message?: string } } {
  return Boolean(value && typeof value === "object" && "status" in value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeProfile(config: SloppyConfig, profileId?: string): LlmProfileConfig | undefined {
  if (profileId) {
    return config.llm.profiles.find((profile) => profile.id === profileId);
  }
  if (config.llm.defaultProfileId) {
    return config.llm.profiles.find((profile) => profile.id === config.llm.defaultProfileId);
  }
  return config.llm.profiles[0];
}

function buildSmokeConfig(
  baseConfig: SloppyConfig,
  options: {
    mode: RuntimeSmokeMode;
    workspaceRoot: string;
    profileId?: string;
    acpAdapterId?: string;
    timeoutMs?: number;
  },
): SloppyConfig {
  const workspaceRoot = resolve(options.workspaceRoot);
  return {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      maxIterations: Math.max(baseConfig.agent.maxIterations, 8),
    },
    providers: {
      ...baseConfig.providers,
      builtin: {
        ...baseConfig.providers.builtin,
        terminal: false,
        filesystem: true,
        memory: false,
        skills: true,
        metaRuntime: true,
        web: false,
        browser: false,
        cron: false,
        messaging: true,
        delegation: true,
        spec: false,
        vision: false,
      },
      discovery: {
        enabled: false,
        paths: [],
      },
      filesystem: {
        ...baseConfig.providers.filesystem,
        root: workspaceRoot,
        focus: workspaceRoot,
      },
      terminal: {
        ...baseConfig.providers.terminal,
        cwd: workspaceRoot,
      },
      metaRuntime: {
        globalRoot: join(workspaceRoot, ".sloppy-smoke/global-meta"),
        workspaceRoot: ".sloppy-smoke/workspace-meta",
      },
      skills: {
        ...baseConfig.providers.skills,
        skillsDir: join(workspaceRoot, ".sloppy-smoke/skills"),
      },
      delegation:
        options.mode === "acp" && options.acpAdapterId
          ? {
              ...baseConfig.providers.delegation,
              acp: {
                enabled: true,
                defaultTimeoutMs:
                  options.timeoutMs ?? baseConfig.providers.delegation.acp?.defaultTimeoutMs,
                adapters: baseConfig.providers.delegation.acp?.adapters ?? {},
              },
            }
          : baseConfig.providers.delegation,
    },
  };
}

async function attachProviderRuntimes(
  providers: RegisteredProvider[],
  hub: ConsumerHub,
  config: SloppyConfig,
  llmProfileManager?: LlmProfileManager,
  eventBus?: AgentEventBus,
): Promise<Array<{ stop(): void }>> {
  const stops: Array<{ stop(): void }> = [];
  for (const provider of providers) {
    const stop = provider.attachRuntime?.(hub, config, {
      hub,
      config,
      publishEvent: eventBus?.publish ?? (() => undefined),
      roleRegistry: new RoleRegistry(),
      llmProfileManager,
    });
    if (stop) stops.push(stop);
  }
  return stops;
}

async function invokeOk(
  hub: ConsumerHub,
  providerId: string,
  path: string,
  action: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const result = await hub.invoke(providerId, path, action, params);
  if (result.status === "error") {
    throw new Error(
      `${providerId}:${path}.${action} failed: ${result.error?.message ?? "unknown error"}`,
    );
  }
  return result.data;
}

async function applyProposal(hub: ConsumerHub, proposalId: string): Promise<void> {
  const result = await hub.invoke("meta-runtime", `/proposals/${proposalId}`, "apply_proposal", {});
  if (result.status !== "error") return;
  if (result.error?.code !== "approval_required") {
    throw new Error(result.error?.message ?? `Could not apply proposal ${proposalId}.`);
  }

  const approval = hub.approvals
    .list({ providerId: "meta-runtime" })
    .find(
      (record) =>
        record.status === "pending" &&
        record.path === `/proposals/${proposalId}` &&
        record.action === "apply_proposal",
    );
  if (!approval) {
    throw new Error(`Proposal ${proposalId} requested approval, but no approval was queued.`);
  }
  const approved = await hub.approvals.approve(approval.id);
  if (hasStatus(approved) && approved.status === "error") {
    throw new Error(approved.error?.message ?? `Approval ${approval.id} failed.`);
  }
}

function buildTopologyOps(options: {
  mode: RuntimeSmokeMode;
  channelId: string;
  profileId?: string;
  modelOverride?: string;
  acpAdapterId?: string;
}) {
  const ops: unknown[] = [
    {
      type: "upsertChannel",
      channel: {
        id: options.channelId,
        topic: "runtime-smoke",
        participants: ["root", "smoke-worker"],
        visibility: "shared",
      },
    },
    {
      type: "upsertRoute",
      route: {
        id: "smoke-channel-route",
        source: "root",
        match: "runtime smoke",
        target: `channel:${options.channelId}`,
        enabled: true,
        priority: 1,
      },
    },
  ];

  if (options.mode === "providers") {
    return ops;
  }

  const bindingId =
    options.mode === "acp" || options.profileId || options.modelOverride
      ? options.mode === "acp"
        ? "smoke-acp"
        : "smoke-llm"
      : undefined;
  if (bindingId) {
    ops.push({
      type: "setExecutorBinding",
      binding:
        options.mode === "acp"
          ? {
              id: bindingId,
              kind: "acp",
              adapterId: options.acpAdapterId,
            }
          : {
              id: bindingId,
              kind: "llm",
              profileId: options.profileId,
              modelOverride: options.modelOverride,
            },
    });
  }

  ops.push(
    {
      type: "setCapabilityMask",
      mask: {
        id: "smoke-filesystem-read",
        provider: "filesystem",
        actions: ["read"],
        mode: "allow",
      },
    },
    {
      type: "upsertAgentProfile",
      profile: {
        id: "smoke-worker",
        name: "Smoke Worker",
        instructions:
          "Reply with a concise confirmation that the runtime smoke message was received.",
      },
    },
    {
      type: "spawnAgent",
      agent: {
        id: "smoke-worker-agent",
        profileId: "smoke-worker",
        status: "active",
        channels: [options.channelId],
        capabilityMaskIds: ["smoke-filesystem-read"],
        executorBindingId: bindingId,
      },
    },
    {
      type: "upsertRoute",
      route: {
        id: "smoke-agent-route",
        source: "root",
        match: "runtime smoke",
        target: "agent:smoke-worker-agent",
        enabled: true,
        priority: 2,
      },
    },
  );

  return ops;
}

async function waitForDelegatedAgent(
  hub: ConsumerHub,
  timeoutMs: number,
  eventBus?: AgentEventBus,
): Promise<RuntimeSmokeResult["delegatedAgent"]> {
  const started = Date.now();
  let lastStatus: string | undefined;
  while (Date.now() - started < timeoutMs) {
    const tree = await hub.queryState({ providerId: "delegation", path: "/agents", depth: 2 });
    const child = tree.children?.[0];
    const props = asRecord(child?.properties);
    const status = typeof props.status === "string" ? props.status : undefined;
    if (child?.id && status && status !== lastStatus) {
      lastStatus = status;
      eventBus?.publish({
        kind: "delegated_agent.state",
        providerId: "delegation",
        agentId: child.id,
        status,
        resultPreview: typeof props.result_preview === "string" ? props.result_preview : undefined,
        error: typeof props.error === "string" ? props.error : undefined,
      });
    }
    if (child?.id && status && ["completed", "failed", "cancelled"].includes(status)) {
      return {
        id: child.id,
        status,
        resultPreview: typeof props.result_preview === "string" ? props.result_preview : undefined,
        error: typeof props.error === "string" ? props.error : undefined,
      };
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for delegated agent after ${timeoutMs}ms.`);
}

export async function runRuntimeSmoke(
  options: RuntimeSmokeOptions = {},
): Promise<RuntimeSmokeResult> {
  const mode = options.mode ?? "providers";
  const log = options.log ?? (() => undefined);
  const tempRoot = options.workspaceRoot
    ? undefined
    : await mkdtemp(join(tmpdir(), "sloppy-runtime-smoke-"));
  const workspaceRoot = resolve(options.workspaceRoot ?? tempRoot ?? process.cwd());
  const loadedConfig =
    options.config ??
    (options.workspaceRoot
      ? await loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath(workspaceRoot))
      : DEFAULT_CONFIG);
  const baseConfig = buildRuntimeSloppyConfig(loadedConfig);
  const profile = mode === "native" ? activeProfile(baseConfig, options.profileId) : undefined;
  if (mode === "native" && options.profileId && !profile) {
    throw new LlmConfigurationError(`LLM profile '${options.profileId}' is not configured.`);
  }
  if (mode === "acp" && !options.acpAdapterId) {
    throw new Error("ACP smoke mode requires --acp-adapter <id>.");
  }

  const config = buildSmokeConfig(baseConfig, {
    mode,
    workspaceRoot,
    profileId: profile?.id,
    acpAdapterId: options.acpAdapterId,
    timeoutMs: options.timeoutMs,
  });
  const providers = createBuiltinProviders(config);
  const hub = new ConsumerHub(providers, config);
  const eventLogPath = options.eventLogPath ?? process.env.SLOPPY_EVENT_LOG;
  const eventBus = eventLogPath
    ? createAgentEventBus({
        logPath: eventLogPath,
        actor: { id: "runtime-smoke", name: "Runtime Smoke", kind: "smoke" },
      })
    : undefined;
  const unsubscribeProviderStates = eventBus
    ? hub.onExternalProviderStateChange((states) => {
        eventBus.callbacks.onExternalProviderStates?.(states);
      })
    : undefined;
  let stops: Array<{ stop(): void }> = [];

  try {
    log(`workspace: ${workspaceRoot}`);
    await hub.connect();
    eventBus?.callbacks.onExternalProviderStates?.(hub.getExternalProviderStates());
    stops = await attachProviderRuntimes(
      providers,
      hub,
      config,
      options.llmProfileManager,
      eventBus,
    );
    log("providers connected");
    const channel = (await invokeOk(hub, "messaging", "/session", "add_channel", {
      name: "Runtime Smoke",
      transport_type: "local",
    })) as { id: string };
    log(`messaging channel created: ${channel.id}`);

    const proposal = (await invokeOk(hub, "meta-runtime", "/session", "propose_change", {
      scope: "session",
      summary: "Runtime smoke topology",
      ops: buildTopologyOps({
        mode,
        channelId: channel.id,
        profileId: profile?.id,
        modelOverride: options.modelOverride,
        acpAdapterId: options.acpAdapterId,
      }),
    })) as { id: string };
    await applyProposal(hub, proposal.id);
    log(`proposal applied: ${proposal.id}`);

    const dispatch = await invokeOk(hub, "meta-runtime", "/session", "dispatch_route", {
      source: "root",
      message: "fallback runtime smoke message",
      envelope: {
        id: "smoke-message",
        source: "root",
        body: "runtime smoke: verify typed envelope routing",
        topic: "runtime-smoke",
        metadata: { mode },
      },
      fanout: true,
    });
    if (asRecord(dispatch).routed !== true) {
      throw new Error(`Route dispatch did not deliver: ${JSON.stringify(dispatch)}`);
    }
    log("route dispatched");

    const channelHistory = (await invokeOk(
      hub,
      "messaging",
      `/channels/${channel.id}`,
      "view_history",
      {},
    )) as unknown[];
    if (channelHistory.length === 0) {
      throw new Error("Messaging channel history is empty after route dispatch.");
    }
    eventBus?.publish({
      kind: "runtime_smoke.channel_verified",
      mode,
      channelId: channel.id,
      messageCount: channelHistory.length,
    });

    const delegatedAgent =
      mode === "providers"
        ? undefined
        : await waitForDelegatedAgent(hub, options.timeoutMs ?? 120000, eventBus);
    if (delegatedAgent?.status === "failed") {
      throw new Error(`Delegated agent failed: ${delegatedAgent.error ?? "unknown error"}`);
    }
    eventBus?.publish({
      kind: "runtime_smoke.completed",
      mode,
      proposalId: proposal.id,
      channelId: channel.id,
      delegatedAgentStatus: delegatedAgent?.status,
    });

    return {
      mode,
      workspaceRoot,
      proposalId: proposal.id,
      channelId: channel.id,
      dispatch,
      channelHistory,
      delegatedAgent,
      eventLogPath,
    };
  } finally {
    unsubscribeProviderStates?.();
    for (const stop of stops) {
      try {
        stop.stop();
      } catch {
        // best-effort
      }
    }
    hub.shutdown();
    eventBus?.stop();
    if (tempRoot && !options.keepState) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

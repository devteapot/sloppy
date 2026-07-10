import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { createDefaultConfig } from "../config/load";
import {
  llmReasoningEffortSchema,
  llmThinkingDisplaySchema,
  type SloppyConfig,
} from "../config/schema";
import type {
  AgentCallbacks,
  AgentRunResult,
  LocalRuntimeTool,
  ResolvedApprovalToolResult,
  RoleProfile,
} from "../core/agent";
import type { InvokePolicy } from "../core/policy";
import type { RoleRegistry } from "../core/role";
import {
  LlmConfigurationError,
  type LlmProfileManager,
  type LlmStateSnapshot as RuntimeLlmStateSnapshot,
} from "../llm/profile-manager";
import { createRuntimeLlmProfileManager } from "../llm/runtime-config";
import { isLlmAbortError } from "../llm/types";
import {
  createFirstPartySessionPlugins,
  createFirstPartyToolEventEnrichers,
} from "../plugins/first-party/catalog";
import { type AgentEventBus, createAgentEventBus, mergeCallbacks } from "./event-bus";
import {
  type ExternalSessionAgentState,
  toExternalAgentLlmState,
  toSessionLlmState,
} from "./llm-state";
import {
  SESSION_MIRROR_PATH_LIST,
  SESSION_MIRROR_PATHS,
  syncExternalProviderStatesToSession,
  syncProviderSnapshotToSession,
} from "./mirror-sync";
import { type PluginRuntimeContext, SessionPluginManager } from "./plugins";
import { ProfileSessionAgent } from "./profile-agent";
import {
  boundToolResult,
  buildToolResultBlock,
  mergePluginExtensionEventTypes,
  parseProfileKind,
  previewToolParams,
  resolveInitialLlmRoute,
  resolveSessionPersistencePath,
  runtimeConfigFingerprint,
} from "./runtime-helpers";
import { SessionStore } from "./store";
import { TurnCoordinator } from "./turn-coordinator";
import type { ApprovalMode } from "./types";

export type { ExternalSessionAgentState } from "./llm-state";
export { boundToolResult } from "./runtime-helpers";

const DEFAULT_CONFIG = createDefaultConfig();

export interface SessionAgent {
  start(): Promise<void>;
  listConnectedProviders?(): { id: string; name: string }[];
  chat(userMessage: string): Promise<AgentRunResult>;
  resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult>;
  invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage>;
  queryProvider?(
    providerId: string,
    path: string,
    options?: {
      depth?: number;
      maxNodes?: number;
      window?: [number, number];
    },
  ): Promise<SlopNode>;
  loadProvider?(providerId: string): Promise<boolean>;
  reloadProvider?(providerId: string): Promise<void>;
  unloadProvider?(providerId: string): boolean;
  resolveApprovalDirect(approvalId: string): Promise<ResultMessage>;
  rejectApprovalDirect(approvalId: string, reason?: string): void;
  cancelActiveTurn(): boolean;
  clearPendingApproval(): void;
  updateConfig?(config: SloppyConfig): void;
  shutdown(): void;
}

export type SessionAgentFactory = (
  callbacks: AgentCallbacks,
  config: SloppyConfig,
  llmProfileManager: LlmProfileManager,
) => SessionAgent;

export type SendMessageResult =
  | { status: "started"; turnId: string }
  | { status: "queued"; queuedMessageId: string; position: number };

function createDefaultSessionAgent(
  callbacks: AgentCallbacks,
  config: SloppyConfig,
  llmProfileManager: LlmProfileManager,
  ignoredProviderIds: string[] = [],
  role?: RoleProfile,
  extras?: {
    roleId?: string;
    roleRegistry?: RoleRegistry;
    publishEvent?: (event: Record<string, unknown> & { kind: string }) => void;
    llmProfileId?: string;
    llmModelOverride?: string;
    policyRules?: InvokePolicy[];
    localTools?: () => LocalRuntimeTool[];
  },
): SessionAgent {
  return new ProfileSessionAgent({
    config,
    llmProfileManager,
    llmProfileId: extras?.llmProfileId,
    llmModelOverride: extras?.llmModelOverride,
    ignoredProviderIds,
    role,
    roleId: extras?.roleId,
    roleRegistry: extras?.roleRegistry,
    publishEvent: extras?.publishEvent,
    mirrorProviderPaths: SESSION_MIRROR_PATH_LIST,
    policyRules: extras?.policyRules,
    localTools: extras?.localTools,
    callbacks,
  });
}

export class SessionRuntime {
  config: SloppyConfig;
  readonly store: SessionStore;

  private agent: SessionAgent;
  private llmProfileManager: LlmProfileManager;
  private eventBus: AgentEventBus | null = null;
  private requiresLlmProfile = true;
  private externalAgentState?: ExternalSessionAgentState;
  private started = false;
  private readonly localProviderIds = new Set<string>();
  private readonly plugins: SessionPluginManager;
  private turns!: TurnCoordinator;
  private readonly startedRuntimeConfigFingerprint: string;
  private readonly configReloader?: () => Promise<SloppyConfig>;

  constructor(options?: {
    config?: SloppyConfig;
    sessionId?: string;
    title?: string;
    store?: SessionStore;
    agentFactory?: SessionAgentFactory;
    llmProfileManager?: LlmProfileManager;
    ignoredProviderIds?: string[];
    parentActorId?: string;
    taskId?: string;
    role?: RoleProfile;
    roleId?: string;
    roleRegistry?: RoleRegistry;
    actorKind?: string;
    actorName?: string;
    actorId?: string;
    launchScope?: {
      key: string;
      root: string;
    };
    requiresLlmProfile?: boolean;
    externalAgentState?: ExternalSessionAgentState;
    llmProfileId?: string;
    llmModelOverride?: string;
    policyRules?: InvokePolicy[];
    sessionPersistencePath?: string | false;
    approvalMode?: ApprovalMode;
    configReloader?: () => Promise<SloppyConfig>;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.startedRuntimeConfigFingerprint = runtimeConfigFingerprint(this.config);
    this.configReloader = options?.configReloader;
    this.requiresLlmProfile = options?.requiresLlmProfile ?? true;
    this.externalAgentState = options?.externalAgentState;
    this.llmProfileManager =
      options?.llmProfileManager ??
      createRuntimeLlmProfileManager({
        config: this.config,
      });
    const sessionId = options?.sessionId ?? crypto.randomUUID();
    for (const providerId of options?.ignoredProviderIds ?? []) {
      this.localProviderIds.add(providerId);
    }
    this.localProviderIds.add(`sloppy-session-${sessionId}`);
    const sessionPlugins = createFirstPartySessionPlugins(this.config);
    const initialLlmRoute = resolveInitialLlmRoute(this.config);
    this.store =
      options?.store ??
      new SessionStore({
        sessionId,
        modelProvider: initialLlmRoute.endpointId,
        model: initialLlmRoute.model,
        title: options?.title,
        workspaceRoot: this.config.plugins.filesystem.root,
        workspaceId: this.config.workspaces?.activeWorkspaceId,
        projectId: this.config.workspaces?.activeProjectId,
        launchScope: options?.launchScope,
        persistencePath: resolveSessionPersistencePath(
          this.config,
          sessionId,
          options?.sessionPersistencePath,
        ),
        snapshotMigrators: sessionPlugins.flatMap((plugin) =>
          plugin.migrateSnapshot ? [plugin.migrateSnapshot] : [],
        ),
        snapshotRecoverers: sessionPlugins.flatMap((plugin) =>
          plugin.recoverSnapshot ? [plugin.recoverSnapshot] : [],
        ),
        snapshotProjections: sessionPlugins.flatMap((plugin) => plugin.snapshotProjections ?? []),
        extensionEventTypes: mergePluginExtensionEventTypes(sessionPlugins),
      });
    if (options?.approvalMode) {
      this.store.setApprovalMode(options.approvalMode);
    }
    this.plugins = new SessionPluginManager(sessionPlugins, this.createPluginContext());

    if (!this.requiresLlmProfile) {
      this.store.syncLlmState(
        toExternalAgentLlmState(
          this.externalAgentState ?? {
            provider: "external",
            model: "agent",
          },
        ),
      );
    }

    const callbacks: AgentCallbacks = {
      onText: (chunk) => {
        const turnId = this.turns.snapshot().activeTurnId;
        if (!turnId) {
          return;
        }
        this.store.appendAssistantText(turnId, chunk);
      },
      onThinking: (delta) => {
        const turnId = this.turns.snapshot().activeTurnId;
        if (!turnId) {
          return;
        }
        this.store.appendAssistantThinking(turnId, {
          blockId: delta.id,
          provider: delta.provider,
          model: delta.model,
          format: delta.format,
          display: delta.display,
          delta: delta.delta,
          startedAt: delta.startedAt,
          completedAt: delta.completedAt,
          elapsedMs: delta.elapsedMs,
          tokenCount: delta.tokenCount,
          tokenCountSource: delta.tokenCountSource,
          done: delta.done,
        });
      },
      onToolEvent: (event) => {
        this.turns.handleToolEvent(event);
      },
      onTurnUsage: (usage) => {
        this.store.recordUsage({
          ...usage,
          turnId: this.turns.snapshot().activeTurnId ?? undefined,
        });
      },
      onProviderSnapshot: (update) => {
        syncProviderSnapshotToSession(this.store, update, this.turns.snapshot().pendingApproval, {
          localProviderIds: this.localProviderIds,
        });
        if (update.path === SESSION_MIRROR_PATHS.approvals) {
          this.turns.scheduleAutoApprovals();
        }
      },
      onExternalProviderStates: (states) => {
        syncExternalProviderStatesToSession(this.store, states);
      },
    };

    const eventLogPath = process.env.SLOPPY_EVENT_LOG;
    if (eventLogPath) {
      this.eventBus = createAgentEventBus({
        logPath: eventLogPath,
        actor: {
          id: options?.actorId ?? options?.sessionId ?? "agent",
          name: options?.actorName ?? options?.title,
          kind: options?.actorKind ?? "agent",
          parentId: options?.parentActorId,
          taskId: options?.taskId,
        },
        toolEventEnrichers: createFirstPartyToolEventEnrichers(this.config),
      });
    }

    const finalCallbacks = this.eventBus
      ? mergeCallbacks(callbacks, this.eventBus.callbacks)
      : callbacks;

    const eventBus = this.eventBus;
    const publishEvent = eventBus
      ? (event: Record<string, unknown> & { kind: string }) => eventBus.publish(event)
      : undefined;

    const agentFactory =
      options?.agentFactory ??
      ((callbacks, config, llmProfileManager) =>
        createDefaultSessionAgent(
          callbacks,
          config,
          llmProfileManager,
          options?.ignoredProviderIds,
          options?.role,
          {
            roleId: options?.roleId,
            roleRegistry: options?.roleRegistry,
            publishEvent,
            llmProfileId: options?.llmProfileId,
            llmModelOverride: options?.llmModelOverride,
            policyRules: options?.policyRules,
            localTools: () => this.buildLocalTools(),
          },
        ));
    this.agent = agentFactory(finalCallbacks, this.config, this.llmProfileManager);
    this.turns = new TurnCoordinator({
      store: this.store,
      plugins: this.plugins,
      agent: () => this.agent,
      audit: (event) => this.audit(event),
      previewToolParams,
      boundToolResult,
      buildToolResultBlock,
      isAbortError: isLlmAbortError,
    });
  }

  private createPluginContext(): PluginRuntimeContext {
    return {
      config: () => this.config,
      store: this.store,
      snapshot: () => this.store.getSnapshot(),
      ensureReady: async () => {
        await this.start();
        if (this.requiresLlmProfile) {
          await this.refreshLlmState({ requireReady: true });
        }
      },
      invokeProvider: async (providerId, path, action, params) =>
        this.agent.invokeProvider(providerId, path, action, params),
      queryProvider: async (providerId, path, options) => {
        if (!this.agent.queryProvider) {
          throw new Error("Provider state query is not available for this session agent.");
        }
        return this.agent.queryProvider(providerId, path, options);
      },
      startTurn: (request) => this.turns.startPluginTurn(request),
      queueTurn: (request) => this.turns.queuePluginTurn(request),
      drainQueue: () => this.turns.drainQueue(),
      audit: (event) => this.audit(event),
    };
  }

  registerSessionProviderId(providerId: string): void {
    this.localProviderIds.add(providerId);
  }

  listConnectedProviders(): { id: string; name: string }[] {
    return this.agent.listConnectedProviders?.() ?? [];
  }

  getPluginSessionNodes() {
    return this.plugins.sessionNodes();
  }

  getPluginRuntimeContext(): PluginRuntimeContext {
    return this.createPluginContext();
  }

  buildPluginsDescriptor() {
    return this.plugins.buildPluginsDescriptor();
  }

  buildPluginSessionSummary(): { props: Record<string, unknown>; summaries: string[] } {
    return this.plugins.sessionSummary();
  }

  buildAutoCloseBlockers(): { source: string; id: string; label: string }[] {
    const snapshot = this.store.getSnapshot();
    const blockers: { source: string; id: string; label: string }[] = [];
    if (snapshot.turn.state === "running" || snapshot.turn.state === "waiting_approval") {
      blockers.push({
        source: "core",
        id: `turn:${snapshot.turn.state}`,
        label: snapshot.turn.message,
      });
    }
    if (snapshot.queue.length > 0) {
      blockers.push({ source: "core", id: "queue", label: "Queued messages" });
    }
    if (snapshot.approvals.some((approval) => approval.status === "pending")) {
      blockers.push({ source: "core", id: "approval", label: "Pending approval" });
    }
    if (snapshot.tasks.some((task) => task.status === "running")) {
      blockers.push({ source: "core", id: "task", label: "Running task" });
    }
    for (const blocker of this.plugins.autoCloseBlockers()) {
      blockers.push({
        source: blocker.pluginId,
        id: blocker.id,
        label: blocker.label,
      });
    }
    return blockers;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.agent.start();
    await this.plugins.onStartup();
    await this.refreshLlmState();
    this.store.recordUsage({
      inputTokenSource: "unavailable",
      outputTokenSource: "unavailable",
      stateContextTokenSource: "unavailable",
    });
    this.started = true;
    this.turns.scheduleAutoApprovals();
  }

  private buildLocalTools(): LocalRuntimeTool[] {
    return this.plugins.localTools(this.turns.snapshot().activePluginTurn);
  }

  async sendMessage(text: string): Promise<SendMessageResult> {
    await this.start();
    if (this.requiresLlmProfile) {
      await this.refreshLlmState({ requireReady: true });
    }
    return this.turns.submit({ source: "user", text });
  }

  cancelQueuedMessage(queuedMessageId: string): { queuedMessageId: string; status: string } {
    return this.turns.cancelQueuedTurn(queuedMessageId);
  }

  clearExtension(namespace: string): { status: string; namespace: string; removed: boolean } {
    const removed = this.store.clearExtension(namespace);
    this.audit({ kind: "extension_cleared", namespace, removed });
    return { status: removed ? "cleared" : "missing", namespace, removed };
  }

  sweepExtensions(): { status: string; removed: string[] } {
    const result = this.store.sweepExtensions();
    this.audit({ kind: "extensions_swept", removed: result.removed });
    return { status: "ok", removed: result.removed };
  }

  async saveLlmProfile(params: Record<string, unknown>): Promise<{ status: string }> {
    const kind = parseProfileKind(params.kind);
    const profileId = typeof params.profile_id === "string" ? params.profile_id : undefined;
    const label = typeof params.label === "string" ? params.label : undefined;
    const endpointId =
      typeof params.endpoint_id === "string"
        ? params.endpoint_id
        : typeof params.endpointId === "string"
          ? params.endpointId
          : undefined;
    const model = typeof params.model === "string" ? params.model : undefined;
    const reasoningEffort =
      typeof params.reasoning_effort === "string"
        ? llmReasoningEffortSchema.parse(params.reasoning_effort)
        : typeof params.reasoningEffort === "string"
          ? llmReasoningEffortSchema.parse(params.reasoningEffort)
          : undefined;
    const thinkingEnabled =
      typeof params.thinking_enabled === "boolean"
        ? params.thinking_enabled
        : typeof params.thinkingEnabled === "boolean"
          ? params.thinkingEnabled
          : undefined;
    const thinkingDisplay =
      typeof params.thinking_display === "string"
        ? llmThinkingDisplaySchema.parse(params.thinking_display)
        : typeof params.thinkingDisplay === "string"
          ? llmThinkingDisplaySchema.parse(params.thinkingDisplay)
          : undefined;
    const adapterId =
      typeof params.adapter_id === "string"
        ? params.adapter_id
        : typeof params.adapterId === "string"
          ? params.adapterId
          : undefined;
    const apiKey = typeof params.api_key === "string" ? params.api_key : undefined;
    const makeDefault = typeof params.make_default === "boolean" ? params.make_default : undefined;

    const state = await this.llmProfileManager.saveProfile({
      profileId,
      label,
      kind,
      endpointId,
      model,
      reasoningEffort,
      thinkingEnabled,
      thinkingDisplay,
      adapterId,
      apiKey,
      makeDefault,
    });
    this.applyLlmState(state);
    return { status: "ok" };
  }

  async setDefaultLlmProfile(profileId: string): Promise<{ profileId: string; status: string }> {
    const state = await this.llmProfileManager.setDefaultProfile(profileId);
    this.applyLlmState(state);
    return {
      profileId,
      status: "ok",
    };
  }

  async deleteLlmProfile(profileId: string): Promise<{ profileId: string; status: string }> {
    const state = await this.llmProfileManager.deleteProfile(profileId);
    this.applyLlmState(state);
    return {
      profileId,
      status: "ok",
    };
  }

  async deleteLlmApiKey(profileId: string): Promise<{ profileId: string; status: string }> {
    const state = await this.llmProfileManager.deleteApiKey(profileId);
    this.applyLlmState(state);
    return {
      profileId,
      status: "ok",
    };
  }

  setApprovalMode(mode: ApprovalMode): { mode: ApprovalMode } {
    this.turns.setApprovalMode(mode);
    return { mode };
  }

  async reloadConfig(): Promise<{
    status: "ok";
    configRequiresRestart: boolean;
    configRestartReason?: string;
  }> {
    if (!this.configReloader) {
      throw new Error("No config reload source is configured for this session.");
    }
    const nextConfig = await this.configReloader();
    this.llmProfileManager.updateConfig(nextConfig);
    await this.refreshLlmState();
    const snapshot = this.store.getSnapshot();
    return {
      status: "ok",
      configRequiresRestart: snapshot.session.configRequiresRestart === true,
      ...(snapshot.session.configRestartReason && {
        configRestartReason: snapshot.session.configRestartReason,
      }),
    };
  }

  async approveApproval(approvalId: string): Promise<{ approvalId: string; status: string }> {
    return this.turns.resolveApproval(approvalId, "approve");
  }

  async rejectApproval(
    approvalId: string,
    reason?: string,
  ): Promise<{ approvalId: string; status: string }> {
    return this.turns.resolveApproval(approvalId, "reject", { reason });
  }

  async cancelTask(taskId: string): Promise<{ taskId: string; status: string }> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    if (!task.canCancel || !task.sourcePath) {
      throw new Error(`Task cannot be cancelled: ${taskId}`);
    }

    const result = await this.agent.invokeProvider(task.provider, task.sourcePath, "cancel");
    return {
      taskId,
      status: result.status,
    };
  }

  async queryProviderState(
    providerId: string,
    path: string,
    options?: {
      depth?: number;
      maxNodes?: number;
      window?: [number, number];
    },
  ): Promise<SlopNode> {
    await this.start();
    if (!this.agent.queryProvider) {
      throw new Error("Provider state query is not available for this session agent.");
    }
    return this.agent.queryProvider(providerId, path, options);
  }

  async invokeProviderAction(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage> {
    await this.start();
    return this.agent.invokeProvider(providerId, path, action, params);
  }

  async loadProvider(providerId: string): Promise<{
    provider_id: string;
    status: "connected";
    was_connected: boolean;
  }> {
    await this.start();
    if (!this.agent.loadProvider) {
      throw new Error("Provider load is not available for this session agent.");
    }
    return {
      provider_id: providerId,
      status: "connected",
      was_connected: await this.agent.loadProvider(providerId),
    };
  }

  async reloadProvider(providerId: string): Promise<{
    provider_id: string;
    status: "connected";
  }> {
    await this.start();
    if (!this.agent.reloadProvider) {
      throw new Error("Provider reload is not available for this session agent.");
    }
    await this.agent.reloadProvider(providerId);
    return {
      provider_id: providerId,
      status: "connected",
    };
  }

  async unloadProvider(providerId: string): Promise<{
    provider_id: string;
    status: "unloaded";
    was_connected: boolean;
  }> {
    await this.start();
    if (!this.agent.unloadProvider) {
      throw new Error("Provider unload is not available for this session agent.");
    }
    return {
      provider_id: providerId,
      status: "unloaded",
      was_connected: this.agent.unloadProvider(providerId),
    };
  }

  canCancelTurn(): boolean {
    return this.turns.canCancel();
  }

  async cancelTurn(): Promise<{ status: string; turnId: string }> {
    return this.turns.cancelActiveTurn();
  }

  async waitForIdle(): Promise<void> {
    await this.turns.waitForIdle();
  }
  shutdown(): void {
    try {
      this.plugins.onShutdown();
    } catch (error) {
      console.warn("[sloppy] plugin shutdown hook failed:", error);
    } finally {
      this.agent.shutdown();
      this.turns.shutdown();
      this.started = false;
      this.store.close();
      this.eventBus?.stop();
      this.eventBus = null;
    }
  }

  private audit(event: Record<string, unknown> & { kind: string }): void {
    this.eventBus?.publish(event);
  }

  private async refreshLlmState(options?: { requireReady?: boolean }): Promise<void> {
    if (!this.requiresLlmProfile) {
      this.store.syncLlmState(
        toExternalAgentLlmState(
          this.externalAgentState ?? {
            provider: "external",
            model: "agent",
          },
        ),
      );
      return;
    }

    try {
      const state = options?.requireReady
        ? await this.llmProfileManager.ensureReady()
        : await this.llmProfileManager.getState();
      this.applyLlmState(state);
    } catch (error) {
      if (!(error instanceof LlmConfigurationError)) {
        throw error;
      }

      const state = await this.llmProfileManager.getState();
      this.applyLlmState(state);
      throw error;
    }
  }

  private applyLlmState(state: RuntimeLlmStateSnapshot): void {
    const nextConfig = this.llmProfileManager.getConfig();
    const restartRequired =
      runtimeConfigFingerprint(nextConfig) !== this.startedRuntimeConfigFingerprint;
    this.config = nextConfig;
    this.agent.updateConfig?.(this.config);
    this.store.setConfigRestartRequired(
      restartRequired,
      restartRequired
        ? "Runtime provider or agent configuration changed. Restart this session to rebuild providers, discovery, policies, and runtime hooks."
        : undefined,
    );
    this.store.syncLlmState(toSessionLlmState(state));
    this.store.syncUsageModelContext({
      modelContextWindowTokens: state.selectedContextWindowTokens,
    });
  }
}

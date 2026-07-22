import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { createDefaultConfig } from "../config/load";
import {
  llmReasoningEffortSchema,
  llmThinkingDisplaySchema,
  type SloppyConfig,
} from "../config/schema";
import type { AgentCallbacks, LocalRuntimeTool, RoleProfile } from "../core/agent";
import { ConversationHistory } from "../core/history";
import type { InvokePolicy } from "../core/policy";
import type { RoleRegistry } from "../core/role";
import {
  LlmConfigurationError,
  type LlmProfileBindingLease,
  type LlmProfileManager,
  type LlmStateSnapshot as RuntimeLlmStateSnapshot,
} from "../llm/profile-manager";
import { createRuntimeLlmProfileManager } from "../llm/runtime-config";
import { isLlmAbortError } from "../llm/types";
import { createFirstPartySessionPlugins } from "../plugins/first-party/session-facets";
import type { ChildSessionFactory, ChildSessionFactoryOptions } from "../runtime/child-session";
import type { SessionClientSnapshot } from "./client-protocol/types";
import { type AgentEventBus, mergeCallbacks } from "./event-bus";
import {
  type ExternalSessionAgentState,
  toExternalAgentLlmState,
  toSessionLlmState,
} from "./llm-state";
import { SESSION_MIRROR_PATH_LIST } from "./mirror-sync";
import {
  type PluginRuntimeContext,
  type PluginTransientState,
  SessionPluginManager,
} from "./plugins";
import { ProfileSessionAgent } from "./profile-agent";
import { AgentSessionProvider } from "./provider";
import {
  createLocalProviderIds,
  createSessionCallbacks,
  createSessionEventBus,
  createSessionStore,
  type SessionRuntimeOptions,
  syncExternalRuntimeLlmState,
} from "./runtime-assembly";
import type { SendMessageResult, SessionAgent } from "./runtime-contracts";
import {
  boundToolResult,
  buildToolResultBlock,
  parseProfileKind,
  previewToolParams,
  runtimeConfigFingerprint,
} from "./runtime-helpers";
import type { SessionStore } from "./store";
import { TurnCoordinator } from "./turn-coordinator";
import type { ApprovalMode, JsonObject, TranscriptMessage } from "./types";

export type { ExternalSessionAgentState } from "./llm-state";
export type { SessionRuntimeOptions } from "./runtime-assembly";
export type {
  SendMessageResult,
  SessionAgent,
  SessionAgentFactory,
} from "./runtime-contracts";
export { boundToolResult } from "./runtime-helpers";

const DEFAULT_CONFIG = createDefaultConfig();

function createDefaultSessionAgent(
  callbacks: AgentCallbacks,
  config: SloppyConfig,
  llmProfileManager: LlmProfileManager,
  ignoredProviderIds: string[] = [],
  role?: RoleProfile,
  conversationHistory?: ConversationHistory,
  extras?: {
    roleId?: string;
    roleRegistry?: RoleRegistry;
    publishEvent?: (event: Record<string, unknown> & { kind: string }) => void;
    llmProfileId?: string;
    llmModelOverride?: string;
    policyRules?: InvokePolicy[];
    localTools?: () => LocalRuntimeTool[];
    childSessionFactory?: ChildSessionFactory;
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
    childSessionFactory: extras?.childSessionFactory,
    conversationHistory:
      conversationHistory ??
      new ConversationHistory({
        historyTurns: config.agent.historyTurns,
        toolResultMaxChars: config.agent.toolResultMaxChars,
      }),
    callbacks,
  });
}

function historyFromTranscript(
  transcript: TranscriptMessage[],
  config: SloppyConfig,
): ConversationHistory {
  const history = new ConversationHistory({
    historyTurns: config.agent.historyTurns,
    toolResultMaxChars: config.agent.toolResultMaxChars,
  });
  for (const message of transcript) {
    const text = message.content
      .flatMap((block) => {
        if (block.type === "text") return [block.text];
        if (block.type === "media") {
          return [
            block.summary ??
              block.preview ??
              `[${block.mime} attachment: ${block.name ?? "media"}]`,
          ];
        }
        return [];
      })
      .join("\n");
    if (!text) continue;
    if (message.role === "assistant") {
      history.addAssistantContent([{ type: "text", text }]);
    } else {
      history.addUserText(message.role === "system" ? `[System continuation]\n${text}` : text);
    }
  }
  return history;
}

export function createDefaultChildSession(
  options: ChildSessionFactoryOptions,
): ReturnType<ChildSessionFactory> {
  const runtime = new SessionRuntime({
    config: options.config,
    sessionId: options.sessionId,
    title: options.title,
    agentFactory: options.agentFactory,
    ignoredProviderIds: options.ignoredProviderIds,
    llmProfileManager: options.llmProfileManager,
    llmProfileId: options.llmProfileId,
    llmModelOverride: options.llmModelOverride,
    requiresLlmProfile: options.requiresLlmProfile,
    externalAgentState: options.externalAgentState,
    policyRules: options.policyRules,
    parentActorId: options.parentActorId,
    preserveScopedConfig: true,
  });
  const provider = new AgentSessionProvider(runtime, {
    providerId: options.providerId,
    providerName: options.providerName,
  });
  return { runtime, provider };
}

export class SessionRuntime {
  config: SloppyConfig;
  readonly store: SessionStore;

  private agent: SessionAgent;
  private readonly conversationHistory: ConversationHistory;
  private unsubscribeConversationHistory: (() => void) | null = null;
  private llmProfileManager: LlmProfileManager;
  private eventBus: AgentEventBus | null = null;
  private requiresLlmProfile = true;
  private externalAgentState?: ExternalSessionAgentState;
  private started = false;
  private readonly localProviderIds: Set<string>;
  private readonly plugins: SessionPluginManager;
  private readonly transientPluginStates = new Map<string, JsonObject>();
  private readonly transientStateListeners = new Set<() => void>();
  private turns!: TurnCoordinator;
  private readonly startedRuntimeConfigFingerprint: string;
  private readonly configReloader?: () => Promise<SloppyConfig>;
  private readonly llmProfileId?: string;
  private readonly llmModelOverride?: string;
  private readonly llmProfileBindingLease?: LlmProfileBindingLease;
  private readonly preserveScopedConfig: boolean;
  private shutdownCompletion: Promise<void> = Promise.resolve();
  private shutdownRequested = false;

  constructor(options: SessionRuntimeOptions = {}) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.startedRuntimeConfigFingerprint = runtimeConfigFingerprint(this.config);
    this.configReloader = options.configReloader;
    this.llmProfileId = options.llmProfileId;
    this.llmModelOverride = options.llmModelOverride;
    this.preserveScopedConfig = options.preserveScopedConfig ?? false;
    this.requiresLlmProfile = options.requiresLlmProfile ?? true;
    this.externalAgentState = options.externalAgentState;
    this.llmProfileManager =
      options.llmProfileManager ??
      createRuntimeLlmProfileManager({
        config: this.config,
        profileBindingRegistry: options.llmProfileBindingRegistry,
        expectedRevision: options.llmProfileRevision,
      });
    if (
      options.llmProfileManager &&
      !this.preserveScopedConfig &&
      this.llmProfileManager.getConfig() !== this.config
    ) {
      this.llmProfileManager.updateConfig(this.config);
    }
    const sessionId = options.sessionId ?? crypto.randomUUID();
    this.localProviderIds = createLocalProviderIds(sessionId, options.ignoredProviderIds);
    const sessionPlugins = createFirstPartySessionPlugins(this.config);
    this.store = createSessionStore(options, this.config, sessionId, sessionPlugins);
    const persistedConversation = this.store.getConversationHistory();
    const restoredSnapshot = this.store.getSnapshot();
    const transcript = restoredSnapshot.transcript;
    this.conversationHistory =
      persistedConversation && (persistedConversation.archive.length > 0 || transcript.length === 0)
        ? new ConversationHistory({
            historyTurns: this.config.agent.historyTurns,
            toolResultMaxChars: this.config.agent.toolResultMaxChars,
            snapshot: persistedConversation,
          })
        : historyFromTranscript(transcript, this.config);
    if (this.store.didRecoverInterruptedTurn()) {
      this.conversationHistory.recoverInterruptedTurn();
    }
    this.unsubscribeConversationHistory = this.conversationHistory.subscribe((snapshot) =>
      this.store.syncConversationHistory(snapshot),
    );
    this.store.syncConversationHistory(this.conversationHistory.snapshot());
    if (options.approvalMode) {
      this.store.setApprovalMode(options.approvalMode);
    }
    this.plugins = new SessionPluginManager(sessionPlugins, (pluginId) =>
      this.createPluginContext(pluginId),
    );

    if (!this.requiresLlmProfile) {
      syncExternalRuntimeLlmState(this.store, this.externalAgentState);
    }

    const callbacks = createSessionCallbacks({
      store: this.store,
      localProviderIds: this.localProviderIds,
      turns: () => this.turns,
      isStopped: () => this.shutdownRequested,
    });
    this.eventBus = createSessionEventBus(options, this.config);

    const finalCallbacks = this.eventBus
      ? mergeCallbacks(callbacks, this.eventBus.callbacks)
      : callbacks;

    const eventBus = this.eventBus;
    const publishEvent = eventBus
      ? (event: Record<string, unknown> & { kind: string }) => eventBus.publish(event)
      : undefined;

    const agentFactory =
      options.agentFactory ??
      ((callbacks, config, llmProfileManager, conversationHistory) =>
        createDefaultSessionAgent(
          callbacks,
          config,
          llmProfileManager,
          options.ignoredProviderIds,
          options.role,
          conversationHistory,
          {
            roleId: options.roleId,
            roleRegistry: options.roleRegistry,
            publishEvent,
            llmProfileId: options.llmProfileId,
            llmModelOverride: options.llmModelOverride,
            policyRules: options.policyRules,
            localTools: () => this.buildLocalTools(),
            childSessionFactory: options.childSessionFactory ?? createDefaultChildSession,
          },
        ));
    this.agent = agentFactory(
      finalCallbacks,
      this.config,
      this.llmProfileManager,
      this.conversationHistory,
    );
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
    this.llmProfileBindingLease = this.requiresLlmProfile
      ? this.llmProfileManager.acquireProfileBinding(this.llmProfileId)
      : undefined;
  }

  private createPluginContext(pluginId: string): PluginRuntimeContext {
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
      getRuntimeService: (key) => this.agent.getRuntimeService?.(key),
      invokeProvider: async (providerId, path, action, params) =>
        this.agent.invokeProvider(providerId, path, action, params),
      queryProvider: async (providerId, path, options) => {
        if (!this.agent.queryProvider) {
          throw new Error("Provider state query is not available for this session agent.");
        }
        return this.agent.queryProvider(providerId, path, options);
      },
      transientState: this.transientStateFor(pluginId),
      approvals: {
        request: (request) => this.turns.requestPluginApproval(pluginId, request),
        cancel: (approvalId, reason) => this.turns.cancelPluginApproval(approvalId, reason),
      },
      turns: {
        submit: (request) => this.turns.submit({ source: "plugin", request }),
        drainQueue: () => this.turns.drainQueue(),
      },
      startTurn: (request) => this.turns.startPluginTurn(request),
      queueTurn: (request) => this.turns.queuePluginTurn(request),
      drainQueue: () => this.turns.drainQueue(),
      audit: (event) => this.audit(event),
    };
  }

  private transientStateFor(pluginId: string): PluginTransientState {
    return {
      read: <T extends JsonObject>() => {
        const state = this.transientPluginStates.get(pluginId);
        return state ? (structuredClone(state) as T) : undefined;
      },
      replace: <T extends JsonObject>(state: T) => {
        this.transientPluginStates.set(pluginId, structuredClone(state));
        this.notifyTransientStateChange();
      },
      update: <T extends JsonObject>(
        updater: (current: Readonly<T> | undefined) => T | undefined,
      ) => {
        const current = this.transientPluginStates.get(pluginId);
        const next = updater(current ? (structuredClone(current) as T) : undefined);
        if (next) {
          this.transientPluginStates.set(pluginId, structuredClone(next));
        } else {
          this.transientPluginStates.delete(pluginId);
        }
        this.notifyTransientStateChange();
      },
      clear: () => {
        if (this.transientPluginStates.delete(pluginId)) {
          this.notifyTransientStateChange();
        }
      },
    };
  }

  onTransientStateChange(listener: () => void): () => void {
    this.transientStateListeners.add(listener);
    return () => {
      this.transientStateListeners.delete(listener);
    };
  }

  private notifyTransientStateChange(): void {
    for (const listener of this.transientStateListeners) {
      try {
        listener();
      } catch {
        // A broken UI refresh listener must not break Plugin state transitions.
      }
    }
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

  getPluginRuntimeContext(pluginId = "session-provider"): PluginRuntimeContext {
    return this.createPluginContext(pluginId);
  }

  buildPluginsDescriptor() {
    return this.plugins.buildPluginsDescriptor();
  }

  buildPluginSessionSummary(): { props: Record<string, unknown>; summaries: string[] } {
    return this.plugins.sessionSummary();
  }

  getClientSnapshot(): SessionClientSnapshot {
    const snapshot = this.store.getSnapshot();
    return {
      session: snapshot,
      controls: {
        canSendMessage: snapshot.llm.status === "ready",
        canCancelTurn: this.canCancelTurn(),
        canReloadConfig: this.configReloader !== undefined,
      },
      pluginState: this.plugins.clientState(),
      plugins: this.plugins.clientPlugins(),
    };
  }

  invokePluginClientCommand(
    pluginId: string,
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.plugins.invokeClientCommand(pluginId, command, params);
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
    if (this.shutdownRequested) {
      throw new Error("Session runtime has been shut down.");
    }
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

    await this.llmProfileManager.saveProfile({
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
    await this.refreshLlmState();
    return { status: "ok" };
  }

  async setDefaultLlmProfile(profileId: string): Promise<{ profileId: string; status: string }> {
    await this.llmProfileManager.setDefaultProfile(profileId);
    await this.refreshLlmState();
    return {
      profileId,
      status: "ok",
    };
  }

  async deleteLlmProfile(profileId: string): Promise<{ profileId: string; status: string }> {
    await this.llmProfileManager.deleteProfile(profileId);
    await this.refreshLlmState();
    return {
      profileId,
      status: "ok",
    };
  }

  async deleteLlmApiKey(profileId: string): Promise<{ profileId: string; status: string }> {
    await this.llmProfileManager.deleteApiKey(profileId);
    await this.refreshLlmState();
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
    const expectedRevision = this.llmProfileManager.captureConfigRevision();
    const nextConfig = await this.configReloader();
    this.llmProfileManager.updateConfig(nextConfig, { expectedRevision });
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
    if (this.shutdownRequested) {
      return;
    }
    this.shutdownRequested = true;
    const cleanupErrors: unknown[] = [];
    let pluginShutdown = Promise.resolve();
    try {
      const shutdown = this.plugins.onShutdown();
      if (shutdown) {
        pluginShutdown = Promise.resolve(shutdown).catch((error: unknown) => {
          console.warn("[sloppy] plugin shutdown hook failed:", error);
        });
      }
    } catch (error) {
      console.warn("[sloppy] plugin shutdown hook failed:", error);
    }

    try {
      if (this.llmProfileBindingLease) {
        this.llmProfileManager.releaseProfileBinding(this.llmProfileBindingLease);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.agent.shutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const agentShutdown = this.agent.waitForShutdown?.() ?? Promise.resolve();
      this.shutdownCompletion = Promise.all([pluginShutdown, agentShutdown]).then(() => undefined);
    } catch (error) {
      cleanupErrors.push(error);
      this.shutdownCompletion = pluginShutdown;
    }
    this.shutdownCompletion = this.shutdownCompletion.finally(() => {
      this.store.syncConversationHistory(this.conversationHistory.snapshot());
      this.unsubscribeConversationHistory?.();
      this.unsubscribeConversationHistory = null;
    });
    try {
      this.turns.shutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (this.transientPluginStates.size > 0) {
      this.transientPluginStates.clear();
      this.notifyTransientStateChange();
    }
    this.started = false;
    try {
      this.store.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.eventBus?.stop();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      this.eventBus = null;
    }

    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Session runtime shutdown failed.");
    }
  }

  async waitForShutdown(): Promise<void> {
    await this.shutdownCompletion;
  }

  isShutdownComplete(): boolean {
    return this.agent.isShutdownComplete?.() ?? this.agent.waitForShutdown === undefined;
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

    const route = {
      profileId: this.llmProfileId,
      modelOverride: this.llmModelOverride,
    };
    try {
      const state = options?.requireReady
        ? await this.llmProfileManager.ensureReady(route)
        : await this.llmProfileManager.getState(route);
      this.applyLlmState(state);
    } catch (error) {
      if (!(error instanceof LlmConfigurationError)) {
        throw error;
      }

      const state = await this.llmProfileManager.getState(route);
      this.applyLlmState(state);
      throw error;
    }
  }

  private applyLlmState(state: RuntimeLlmStateSnapshot): void {
    if (this.llmProfileBindingLease) {
      this.llmProfileManager.moveProfileBinding(this.llmProfileBindingLease, state.activeProfileId);
    }
    const managedConfig = this.llmProfileManager.getConfig();
    const nextConfig = this.preserveScopedConfig
      ? { ...this.config, llm: managedConfig.llm }
      : managedConfig;
    const restartRequired =
      runtimeConfigFingerprint(nextConfig) !== this.startedRuntimeConfigFingerprint;
    this.config = nextConfig;
    this.agent.updateConfig?.(this.config, {
      syncLlmProfileManager: !this.preserveScopedConfig,
    });
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

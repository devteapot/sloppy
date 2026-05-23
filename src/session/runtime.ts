import { join, resolve } from "node:path";

import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { createDefaultConfig } from "../config/load";
import {
  llmProviderSchema,
  llmReasoningEffortSchema,
  llmThinkingDisplaySchema,
  type SloppyConfig,
} from "../config/schema";
import type {
  AgentCallbacks,
  AgentRunResult,
  AgentToolEvent,
  LocalRuntimeTool,
  ResolvedApprovalToolResult,
  RoleProfile,
} from "../core/agent";
import { renderEditDiff } from "../core/diff";
import type { InvokePolicy } from "../core/policy";
import type { RoleRegistry } from "../core/role";
import {
  LlmConfigurationError,
  type LlmProfileManager,
  type LlmStateSnapshot as RuntimeLlmStateSnapshot,
} from "../llm/profile-manager";
import { createRuntimeLlmProfileManager } from "../llm/runtime-config";
import type { ToolResultContentBlock } from "../llm/types";
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
  type PendingApprovalMirror,
  syncExternalProviderStatesToSession,
  syncProviderSnapshotToSession,
} from "./mirror-sync";
import {
  type ActivePluginTurn,
  type PluginRuntimeContext,
  type PluginTurnRequest,
  SessionPluginManager,
  type SessionRuntimePlugin,
} from "./plugins";
import { ProfileSessionAgent } from "./profile-agent";
import { SessionStore } from "./store";
import type {
  ApprovalItem,
  ApprovalMode,
  JsonValue,
  SessionStoreEventType,
  ToolCallResult,
} from "./types";

export type { ExternalSessionAgentState } from "./llm-state";

const DEFAULT_CONFIG = createDefaultConfig();

function runtimeConfigFingerprint(config: SloppyConfig): string {
  return JSON.stringify({
    agent: config.agent,
    maxToolResultSize: config.maxToolResultSize,
    plugins: config.plugins,
    providers: config.providers,
  });
}

function mergePluginExtensionEventTypes(
  plugins: readonly SessionRuntimePlugin[],
): Record<string, readonly SessionStoreEventType[]> {
  const result: Record<string, SessionStoreEventType[]> = {};
  for (const plugin of plugins) {
    for (const [namespace, eventTypes] of Object.entries(plugin.extensionEvents ?? {})) {
      result[namespace] = [...(result[namespace] ?? []), ...eventTypes];
    }
  }
  return result;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "session";
}

function resolveSessionPersistencePath(
  config: SloppyConfig,
  sessionId: string,
  explicitPath: string | false | undefined,
): string | undefined {
  if (explicitPath === false) {
    return undefined;
  }
  if (explicitPath) {
    return resolve(explicitPath);
  }
  if (config.session?.persistSnapshots !== true) {
    return undefined;
  }
  const dir = config.session.persistenceDir ?? ".sloppy/sessions";
  const absoluteDir = resolve(config.plugins.filesystem.root, dir);
  return join(absoluteDir, `${sanitizePathSegment(sessionId)}.json`);
}

function stringifyResultMessage(result: ResultMessage): string {
  if (result.status === "error") {
    return result.error?.message ?? "Provider action failed.";
  }

  return JSON.stringify(result, null, 2);
}

function buildToolResultBlock(toolUseId: string, result: ResultMessage): ToolResultContentBlock {
  return {
    type: "tool_result",
    toolUseId,
    content: stringifyResultMessage(result),
    isError: result.status === "error",
  };
}

const PARAMS_PREVIEW_BYTE_LIMIT = 1500;
const PARAMS_PREVIEW_LINE_LIMIT = 24;
const TOOL_RESULT_BYTE_LIMIT = 12000;
const TOOL_RESULT_STRING_BYTE_LIMIT = 4000;
const TOOL_RESULT_ARRAY_ITEM_LIMIT = 100;
const TOOL_RESULT_OBJECT_ENTRY_LIMIT = 100;

// Compact a tool's params into a multi-line preview for the activity feed.
// Edit-shaped actions (write/edit/patch) put the new content/hunks first so
// the TUI can render a diff-like block; everything else falls back to a
// stable JSON dump capped at PARAMS_PREVIEW_BYTE_LIMIT.
function previewToolParams(action: string, params: Record<string, unknown>): string | undefined {
  if (!params || Object.keys(params).length === 0) {
    return undefined;
  }
  const lower = action.toLowerCase();
  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch")) {
    const diff = renderEditDiff(params);
    if (diff) return clampPreview(diff);
    const preferred = ["new_string", "content", "patch", "diff"];
    for (const key of preferred) {
      const value = params[key];
      if (typeof value === "string" && value.length > 0) {
        return clampPreview(value);
      }
    }
  }
  let json: string;
  try {
    json = JSON.stringify(params, null, 2);
  } catch {
    return undefined;
  }
  return clampPreview(json);
}

function clampPreview(value: string): string {
  const lines = value.split(/\r?\n/);
  let truncatedLines = lines;
  if (lines.length > PARAMS_PREVIEW_LINE_LIMIT) {
    truncatedLines = [
      ...lines.slice(0, PARAMS_PREVIEW_LINE_LIMIT),
      `… +${lines.length - PARAMS_PREVIEW_LINE_LIMIT} lines`,
    ];
  }
  const out = truncatedLines.join("\n");
  if (out.length <= PARAMS_PREVIEW_BYTE_LIMIT) {
    return out;
  }
  return `${out.slice(0, PARAMS_PREVIEW_BYTE_LIMIT)}…`;
}

export function boundToolResult(
  input: { kind?: string; data?: unknown } | undefined,
): ToolCallResult | undefined {
  if (!input) {
    return undefined;
  }
  const kind =
    typeof input.kind === "string" && input.kind.trim().length > 0 ? input.kind.trim() : undefined;
  const budget = { remaining: TOOL_RESULT_BYTE_LIMIT, truncated: false };
  const data =
    Object.hasOwn(input, "data") && input.data !== undefined
      ? boundJsonValue(input.data, budget, new WeakSet<object>())
      : undefined;
  if (!kind && data === undefined) {
    return undefined;
  }
  return {
    ...(kind ? { kind } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(budget.truncated ? { truncated: true } : {}),
  };
}

function boundJsonValue(
  value: unknown,
  budget: { remaining: number; truncated: boolean },
  seen: WeakSet<object>,
): JsonValue {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return "[truncated]";
  }
  if (value === null || typeof value === "boolean") {
    budget.remaining -= 4;
    return value;
  }
  if (typeof value === "number") {
    budget.remaining -= 16;
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    const limit = Math.min(TOOL_RESULT_STRING_BYTE_LIMIT, Math.max(0, budget.remaining));
    if (value.length > limit) {
      budget.truncated = true;
      budget.remaining = 0;
      return `${value.slice(0, Math.max(0, limit - 16))}\n...[truncated]`;
    }
    budget.remaining -= value.length;
    return value;
  }
  if (typeof value === "bigint") {
    const out = value.toString();
    budget.remaining -= out.length;
    return out;
  }
  if (typeof value !== "object") {
    const out = String(value);
    budget.remaining -= out.length;
    return out;
  }
  if (seen.has(value)) {
    budget.truncated = true;
    return "[circular]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index >= TOOL_RESULT_ARRAY_ITEM_LIMIT || budget.remaining <= 0) {
          budget.truncated = true;
          break;
        }
        out.push(boundJsonValue(value[index], budget, seen));
      }
      return out;
    }

    const out: Record<string, JsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (let index = 0; index < entries.length; index += 1) {
      if (index >= TOOL_RESULT_OBJECT_ENTRY_LIMIT || budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      const [key, entryValue] = entries[index] ?? ["", undefined];
      if (!key || entryValue === undefined || typeof entryValue === "function") {
        continue;
      }
      budget.remaining -= key.length;
      out[key] = boundJsonValue(entryValue, budget, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

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
    mirrorProviderPaths: ["/approvals", "/tasks"],
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
  private currentTurnId: string | null = null;
  private activeTurnPromise: Promise<void> | null = null;
  private pendingApproval: PendingApprovalMirror | null = null;
  private autoApprovalDrain: Promise<void> = Promise.resolve();
  private readonly autoApprovalAttempts = new Set<string>();
  private readonly localProviderIds = new Set<string>();
  private currentTurnStartedAt = 0;
  private currentTurnUsedTools = false;
  private currentPluginTurn: ActivePluginTurn | null = null;
  private readonly plugins: SessionPluginManager;
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
    this.store =
      options?.store ??
      new SessionStore({
        sessionId,
        modelProvider: this.config.llm.provider,
        model: this.config.llm.model,
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
        if (!this.currentTurnId) {
          return;
        }
        this.store.appendAssistantText(this.currentTurnId, chunk);
      },
      onThinking: (delta) => {
        if (!this.currentTurnId) {
          return;
        }
        this.store.appendAssistantThinking(this.currentTurnId, {
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
        if (!this.currentTurnId) {
          return;
        }

        if (event.kind === "started") {
          this.currentTurnUsedTools = true;
        }
        this.handleToolEvent(this.currentTurnId, event);
      },
      onTurnUsage: (usage) => {
        this.store.recordUsage({
          ...usage,
          turnId: this.currentTurnId ?? undefined,
        });
      },
      onProviderSnapshot: (update) => {
        syncProviderSnapshotToSession(this.store, update, this.pendingApproval, {
          localProviderIds: this.localProviderIds,
        });
        if (update.path === "/approvals") {
          this.scheduleAutoApprovals();
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
      startTurn: (request) => this.startPluginTurn(request),
      queueTurn: (request) => this.queuePluginTurn(request),
      drainQueue: () => this.startNextQueuedTurn(),
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
    this.scheduleAutoApprovals();
  }

  private buildLocalTools(): LocalRuntimeTool[] {
    return this.plugins.localTools(this.currentPluginTurn);
  }

  async sendMessage(text: string): Promise<SendMessageResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Message text cannot be empty.");
    }

    await this.start();
    if (this.requiresLlmProfile) {
      await this.refreshLlmState({ requireReady: true });
    }
    if (this.currentTurnId) {
      const queued = this.store.enqueueMessage(trimmed);
      const position =
        this.store.getSnapshot().queue.findIndex((message) => message.id === queued.id) + 1;
      this.audit({
        kind: "turn_queued",
        queuedMessageId: queued.id,
        position,
        source: "user",
      });
      return {
        status: "queued",
        queuedMessageId: queued.id,
        position,
      };
    }

    return this.startTurn(trimmed);
  }

  cancelQueuedMessage(queuedMessageId: string): { queuedMessageId: string; status: string } {
    this.store.removeQueuedMessage(queuedMessageId);
    this.audit({ kind: "turn_queue_cancelled", queuedMessageId });
    return {
      queuedMessageId,
      status: "cancelled",
    };
  }

  private startTurn(userMessage: string): { status: "started"; turnId: string } {
    const turnId = this.store.beginTurn(userMessage);
    this.currentTurnStartedAt = Date.now();
    this.currentTurnUsedTools = false;
    this.currentPluginTurn = null;
    this.currentTurnId = turnId;
    this.audit({
      kind: "turn_started",
      turnId,
      source: "user",
      continuation: false,
    });
    this.activeTurnPromise = this.runTurn(turnId, userMessage);
    return { status: "started", turnId };
  }

  private startPluginTurn(request: PluginTurnRequest): { status: "started"; turnId: string } {
    const turnId = this.store.beginTurn(request.text, {
      role: request.role ?? (request.continuation ? "system" : "user"),
      author: request.author,
    });
    this.currentTurnStartedAt = Date.now();
    this.currentTurnUsedTools = false;
    this.currentPluginTurn = {
      pluginId: request.pluginId,
      runId: request.runId,
      author: request.author,
      continuation: request.continuation === true,
      metadata: request.metadata,
    };
    this.currentTurnId = turnId;
    this.audit({
      kind: "turn_started",
      turnId,
      source: "plugin",
      pluginId: request.pluginId,
      pluginRunId: request.runId,
      author: request.author,
      continuation: request.continuation === true,
      ...(request.metadata ?? {}),
    });
    this.activeTurnPromise = this.runTurn(turnId, request.text);
    return { status: "started", turnId };
  }

  private queuePluginTurn(request: PluginTurnRequest): {
    status: "queued";
    queuedMessageId: string;
    position: number;
  } {
    const queued = this.store.enqueueMessage(request.text, {
      author: request.author,
      source: "plugin",
      pluginId: request.pluginId,
      pluginRunId: request.runId,
      goalId: typeof request.metadata?.goalId === "string" ? request.metadata.goalId : undefined,
      continuation: request.continuation === true,
    });
    const position =
      this.store.getSnapshot().queue.findIndex((message) => message.id === queued.id) + 1;
    return {
      status: "queued",
      queuedMessageId: queued.id,
      position,
    };
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
    const provider = llmProviderSchema.parse(String(params.provider ?? "").trim());
    const profileId = typeof params.profile_id === "string" ? params.profile_id : undefined;
    const label = typeof params.label === "string" ? params.label : undefined;
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
    const baseUrl = typeof params.base_url === "string" ? params.base_url : undefined;
    const apiKey = typeof params.api_key === "string" ? params.api_key : undefined;
    const makeDefault = typeof params.make_default === "boolean" ? params.make_default : undefined;

    const state = await this.llmProfileManager.saveProfile({
      profileId,
      label,
      provider,
      model,
      reasoningEffort,
      thinkingEnabled,
      thinkingDisplay,
      adapterId,
      baseUrl,
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
    if (mode === "normal") {
      this.autoApprovalAttempts.clear();
    }
    this.store.setApprovalMode(mode);
    this.scheduleAutoApprovals();
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
    let approval = this.store.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    if (!approval.canApprove || !approval.sourcePath) {
      throw new Error(`Approval cannot be approved: ${approvalId}`);
    }

    if (!approval.sourceApprovalId) {
      throw new Error(`Approval is missing source identifier: ${approvalId}`);
    }

    // If this approval is the one blocking the current model turn, wait for
    // the suspended turn to finish unwinding before resolving the hub
    // approval. The `approval_requested` event fires synchronously inside
    // agent.chat(); a fast approver can race the original chat()'s finally
    // block, leaving activeRunAbortController still set when resumeTurn()
    // asks for a new run loop. Unrelated approvals (e.g. background tasks)
    // must NOT wait — that would block them behind a long-running active turn.
    if (this.pendingApproval?.sourceApprovalId === approval.sourceApprovalId) {
      await this.activeTurnPromise;

      // Re-check after the await: pendingApproval may have been cleared by a
      // concurrent cancelTurn, or the approval may have been resolved already.
      const current = this.store.getApproval(approvalId);
      if (!current || current.status !== "pending") {
        return {
          approvalId,
          status: current?.status ?? "unknown",
        };
      }
      approval = current;
    }

    if (!approval.sourcePath || !approval.sourceApprovalId) {
      throw new Error(`Approval is missing source location: ${approvalId}`);
    }

    const resumePendingTurn = this.shouldResumePendingApproval(approval);
    const result = resumePendingTurn
      ? await this.agent.resolveApprovalDirect(approval.sourceApprovalId)
      : await this.agent.invokeProvider(approval.provider, approval.sourcePath, "approve");
    if (this.shouldResumePendingApproval(approval)) {
      const toolUseId = this.pendingToolUseId(approval);
      const resultKind = this.pendingApproval?.invocation.resultKind;
      this.pendingApproval = null;
      this.activeTurnPromise = this.resumeTurn(approval.turnId ?? this.currentTurnId ?? "", {
        block: buildToolResultBlock(toolUseId, result),
        status: result.status,
        summary: `${approval.provider}:${approval.action} ${approval.path}`,
        taskId:
          result.status === "accepted" &&
          result.data &&
          typeof result.data === "object" &&
          !Array.isArray(result.data) &&
          typeof (result.data as { taskId?: unknown }).taskId === "string"
            ? (result.data as { taskId: string }).taskId
            : undefined,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
        result: {
          kind: resultKind,
          data: result.data,
        },
      });
    }

    return {
      approvalId,
      status: result.status,
    };
  }

  private scheduleAutoApprovals(): void {
    if (this.store.getSnapshot().approvalPolicy.mode !== "auto") {
      return;
    }
    this.autoApprovalDrain = this.autoApprovalDrain
      .then(() => this.runAutoApprovalPass())
      .catch((error: unknown) => {
        this.audit({
          kind: "auto_approval_error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async runAutoApprovalPass(): Promise<void> {
    const snapshot = this.store.getSnapshot();
    const pendingIds = new Set(
      snapshot.approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => approval.id),
    );
    for (const approvalId of this.autoApprovalAttempts) {
      if (!pendingIds.has(approvalId)) {
        this.autoApprovalAttempts.delete(approvalId);
      }
    }
    if (snapshot.approvalPolicy.mode !== "auto") {
      return;
    }
    for (const approval of snapshot.approvals) {
      if (this.store.getSnapshot().approvalPolicy.mode !== "auto") {
        return;
      }
      if (
        approval.status !== "pending" ||
        !approval.canApprove ||
        this.autoApprovalAttempts.has(approval.id)
      ) {
        continue;
      }
      this.autoApprovalAttempts.add(approval.id);
      try {
        await this.approveApproval(approval.id);
      } catch (error) {
        this.audit({
          kind: "auto_approval_error",
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async rejectApproval(
    approvalId: string,
    reason?: string,
  ): Promise<{ approvalId: string; status: string }> {
    let approval = this.store.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    if (!approval.canReject || !approval.sourcePath) {
      throw new Error(`Approval cannot be rejected: ${approvalId}`);
    }

    if (!approval.sourceApprovalId) {
      throw new Error(`Approval is missing source identifier: ${approvalId}`);
    }

    // Mirror the approve path: only wait when this approval is what the
    // current model turn is blocked on, so unrelated/background approvals
    // don't queue behind a long-running active turn.
    if (this.pendingApproval?.sourceApprovalId === approval.sourceApprovalId) {
      await this.activeTurnPromise;

      const current = this.store.getApproval(approvalId);
      if (!current || current.status !== "pending") {
        return {
          approvalId,
          status: current?.status ?? "unknown",
        };
      }
      approval = current;
    }

    if (!approval.sourcePath || !approval.sourceApprovalId) {
      throw new Error(`Approval is missing source location: ${approvalId}`);
    }

    const resumePendingTurn = this.shouldResumePendingApproval(approval);
    const result = resumePendingTurn
      ? null
      : await this.agent.invokeProvider(
          approval.provider,
          approval.sourcePath,
          "reject",
          reason ? { reason } : undefined,
        );
    if (resumePendingTurn) {
      this.agent.rejectApprovalDirect(approval.sourceApprovalId, reason);
      const toolUseId = this.pendingToolUseId(approval);
      this.pendingApproval = null;
      this.activeTurnPromise = this.resumeTurn(approval.turnId ?? this.currentTurnId ?? "", {
        block: {
          type: "tool_result",
          toolUseId,
          content: reason ? `Approval rejected: ${reason}` : "Approval rejected.",
          isError: true,
        },
        status: "cancelled",
        summary: `${approval.provider}:${approval.action} ${approval.path}`,
        errorCode: "approval_rejected",
        errorMessage: reason ? `Approval rejected: ${reason}` : "Approval rejected.",
      });
    }

    return {
      approvalId,
      status: result?.status === "error" ? "error" : "rejected",
    };
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
    const snapshot = this.store.getSnapshot();
    if (!this.currentTurnId) {
      return false;
    }

    if (this.pendingApproval) {
      return true;
    }

    return (
      snapshot.turn.state === "running" &&
      (snapshot.turn.waitingOn === "model" || snapshot.turn.waitingOn === "tool")
    );
  }

  async cancelTurn(): Promise<{ status: string; turnId: string }> {
    const turnId = this.currentTurnId;
    if (!turnId) {
      throw new Error("No active turn to cancel.");
    }

    const message = "Turn cancelled by user.";
    if (this.pendingApproval) {
      const pendingApproval = this.pendingApproval;
      // Reject the underlying hub approval directly using the synchronously
      // known sourceApprovalId. The previous `if (sessionApprovalId)` guard
      // left a window where a quick cancel before the /approvals mirror
      // populated would skip rejection — leaving a live approval whose
      // execute callback could later run without a model resume.
      let approvalStatus: "rejected" | undefined;
      try {
        this.agent.rejectApprovalDirect(pendingApproval.sourceApprovalId, message);
        approvalStatus = "rejected";
      } catch {
        // Best-effort provider cleanup should not block ending the local turn.
      }

      const pluginTurn = this.currentPluginTurn;
      this.agent.clearPendingApproval();
      this.pendingApproval = null;
      this.currentTurnId = null;
      this.activeTurnPromise = null;
      this.store.cancelTurn(turnId, {
        message,
        toolUseId: pendingApproval.invocation.toolUseId,
        approvalId: pendingApproval.sessionApprovalId,
        approvalStatus,
      });
      this.audit({
        kind: "turn_cancelled",
        turnId,
        reason: "user",
        sourceApprovalId: pendingApproval.sourceApprovalId,
        sessionApprovalId: pendingApproval.sessionApprovalId,
        approvalStatus,
      });
      if (pluginTurn) {
        this.plugins.onTurnFailure({
          turnId,
          pluginTurn,
          message,
          cancelled: true,
        });
      }
      this.currentPluginTurn = null;
      this.startNextQueuedTurn();
      return {
        status: "cancelled",
        turnId,
      };
    }

    if (!this.agent.cancelActiveTurn()) {
      throw new Error("Turn cancellation is not available in the current phase.");
    }

    this.audit({ kind: "turn_cancel_requested", turnId, reason: "user" });
    return {
      status: "cancelling",
      turnId,
    };
  }

  async waitForIdle(): Promise<void> {
    let observedAutoApprovalDrain: Promise<void> | null = null;
    while (this.activeTurnPromise || observedAutoApprovalDrain !== this.autoApprovalDrain) {
      const activeTurn = this.activeTurnPromise;
      const autoApprovalDrain = this.autoApprovalDrain;
      observedAutoApprovalDrain = autoApprovalDrain;
      if (activeTurn) {
        await activeTurn;
      }
      await autoApprovalDrain;
    }
  }

  shutdown(): void {
    try {
      this.plugins.onShutdown();
    } catch (error) {
      console.warn("[sloppy] plugin shutdown hook failed:", error);
    } finally {
      this.agent.shutdown();
      this.started = false;
      this.currentTurnId = null;
      this.pendingApproval = null;
      this.activeTurnPromise = null;
      this.store.close();
      this.eventBus?.stop();
      this.eventBus = null;
    }
  }

  private audit(event: Record<string, unknown> & { kind: string }): void {
    this.eventBus?.publish(event);
  }

  private handleToolEvent(turnId: string, event: AgentToolEvent): void {
    switch (event.kind) {
      case "started": {
        this.store.recordToolStart(turnId, {
          toolUseId: event.invocation.toolUseId,
          summary: event.summary,
          provider: event.invocation.providerId,
          path: event.invocation.path,
          action: event.invocation.action,
          label: event.invocation.label,
          paramsPreview: previewToolParams(event.invocation.action, event.invocation.params),
        });
        break;
      }
      case "completed": {
        this.store.recordToolCompletion(turnId, {
          toolUseId: event.invocation.toolUseId,
          summary: event.summary,
          status: event.status,
          provider: event.invocation.providerId,
          path: event.invocation.path,
          action: event.invocation.action,
          label: event.invocation.label,
          taskId: event.taskId,
          errorMessage: event.errorMessage,
          result: boundToolResult(event.result),
        });
        break;
      }
      case "approval_requested": {
        if (!event.approvalId) {
          // Defensive: the hub always populates this on the
          // `approval_required` ResultMessage. Fail loudly rather than
          // silently fall back to tuple-matching.
          throw new Error(
            `approval_requested event missing approvalId for ${event.invocation.providerId}:${event.invocation.action}`,
          );
        }
        this.pendingApproval = {
          turnId,
          invocation: event.invocation,
          sourceApprovalId: event.approvalId,
        };
        this.store.recordApprovalRequested(turnId, {
          toolUseId: event.invocation.toolUseId,
          summary: event.summary,
          provider: event.invocation.providerId,
          path: event.invocation.path,
          action: event.invocation.action,
          label: event.invocation.label,
          reason: event.errorMessage,
        });
        break;
      }
    }
  }

  private shouldResumePendingApproval(approval: ApprovalItem): boolean {
    if (!this.pendingApproval || approval.status !== "pending") {
      return false;
    }

    // Match strictly on the hub-owned approval id. Tuple-matching is unsafe
    // when multiple approvals share (provider, path, action) — the model can
    // emit two of the same destructive call in one turn, and the user's
    // approve/reject would otherwise be applied to whichever happens to come
    // first in the mirrored tree.
    return (
      approval.provider === this.pendingApproval.invocation.providerId &&
      approval.sourceApprovalId === this.pendingApproval.sourceApprovalId
    );
  }

  private pendingToolUseId(approval: ApprovalItem): string {
    if (!this.pendingApproval || !this.shouldResumePendingApproval(approval)) {
      throw new Error(`Approval is not linked to the current pending turn: ${approval.id}`);
    }

    return this.pendingApproval.invocation.toolUseId;
  }

  private runTurn(turnId: string, userMessage: string): Promise<void> {
    const run = this.agent
      .chat(userMessage)
      .then((result) => {
        this.handleAgentResult(turnId, result);
      })
      .catch((error) => {
        this.handleTurnFailure(turnId, error);
      });
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (this.activeTurnPromise === tracked) {
        this.activeTurnPromise = null;
      }
    });
    return tracked;
  }

  private resumeTurn(turnId: string, result: ResolvedApprovalToolResult): Promise<void> {
    const run = this.agent
      .resumeWithToolResult(result)
      .then((nextResult) => {
        this.handleAgentResult(turnId, nextResult);
      })
      .catch((error) => {
        this.handleTurnFailure(turnId, error);
      });
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (this.activeTurnPromise === tracked) {
        this.activeTurnPromise = null;
      }
    });
    return tracked;
  }

  private handleAgentResult(turnId: string, result: AgentRunResult): void {
    if (result.status === "waiting_approval") {
      // `pendingApproval` is set synchronously by the `approval_requested`
      // tool event fired earlier in the same loop iteration (which carries
      // the hub-owned approvalId). If it's somehow missing here, fail loudly
      // rather than silently fall back to a half-populated record without a
      // sourceApprovalId.
      if (!this.pendingApproval) {
        throw new Error(
          `Agent reported waiting_approval without a pending approval record (turn ${turnId}).`,
        );
      }
      this.audit({
        kind: "turn_waiting_approval",
        turnId,
        sourceApprovalId: this.pendingApproval.sourceApprovalId,
        sessionApprovalId: this.pendingApproval.sessionApprovalId,
        toolUseId: this.pendingApproval.invocation.toolUseId,
      });
      return;
    }

    const pluginTurn = this.currentPluginTurn;
    const elapsedMs = this.currentTurnStartedAt > 0 ? Date.now() - this.currentTurnStartedAt : 0;
    if (pluginTurn) {
      this.plugins.onTurnComplete({
        turnId,
        pluginTurn,
        result,
        elapsedMs,
        usedTools: this.currentTurnUsedTools,
      });
    }
    this.pendingApproval = null;
    this.currentTurnId = null;
    this.currentPluginTurn = null;
    this.store.completeTurn(turnId, result.response);
    this.audit({
      kind: "turn_completed",
      turnId,
      pluginId: pluginTurn?.pluginId,
      pluginRunId: pluginTurn?.runId,
      continuation: pluginTurn?.continuation ?? false,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      thinkingTokens: result.usage?.thinkingTokens,
    });
    this.startNextQueuedTurn();
  }

  private failTurn(turnId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const pluginTurn = this.currentPluginTurn;
    this.pendingApproval = null;
    this.currentTurnId = null;
    this.store.failTurn(turnId, message);
    this.audit({ kind: "turn_failed", turnId, errorMessage: message });
    if (pluginTurn) {
      this.plugins.onTurnFailure({
        turnId,
        pluginTurn,
        message,
        cancelled: false,
      });
    }
    this.currentPluginTurn = null;
    this.startNextQueuedTurn();
  }

  private handleTurnFailure(turnId: string, error: unknown): void {
    if (isLlmAbortError(error)) {
      const pluginTurn = this.currentPluginTurn;
      this.pendingApproval = null;
      this.currentTurnId = null;
      this.store.cancelTurn(turnId, {
        message: "Turn cancelled by user.",
      });
      this.audit({ kind: "turn_cancelled", turnId, reason: "llm_abort" });
      if (pluginTurn) {
        this.plugins.onTurnFailure({
          turnId,
          pluginTurn,
          message: "Turn cancelled by user.",
          cancelled: true,
        });
      }
      this.currentPluginTurn = null;
      this.startNextQueuedTurn();
      return;
    }

    this.failTurn(turnId, error);
  }

  private startNextQueuedTurn(): void {
    if (this.currentTurnId) {
      return;
    }
    const next = this.store.dequeueMessage();
    if (!next) {
      const pluginTurn = this.plugins.nextTurn();
      if (pluginTurn) {
        this.startPluginTurn(pluginTurn);
      }
      return;
    }
    const pluginTurn = this.plugins.acceptQueuedTurn(next);
    if (pluginTurn) {
      this.startPluginTurn(pluginTurn);
      return;
    }
    if (next.source === "plugin") {
      this.startNextQueuedTurn();
      return;
    }
    this.startTurn(next.text);
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

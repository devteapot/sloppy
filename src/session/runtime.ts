import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { defaultConfigPromise } from "../config/load";
import { llmProviderSchema, type SloppyConfig } from "../config/schema";
import {
  Agent,
  type AgentCallbacks,
  type AgentRunResult,
  type AgentToolEvent,
  type AgentToolInvocation,
  type ResolvedApprovalToolResult,
  type RoleProfile,
} from "../core/agent";
import type { ExternalProviderState } from "../core/consumer";
import type { RoleRegistry } from "../core/role";
import {
  LlmConfigurationError,
  LlmProfileManager,
  type LlmStateSnapshot as RuntimeLlmStateSnapshot,
} from "../llm/profile-manager";
import type { ToolResultContentBlock } from "../llm/types";
import { isLlmAbortError } from "../llm/types";
import { type AgentEventBus, createAgentEventBus, mergeCallbacks } from "./event-bus";
import { buildMirroredItemId, SessionStore } from "./store";
import type {
  ApprovalItem,
  ExternalAppSnapshot,
  LlmStateSnapshot,
  SessionDigestAction,
  SessionOrchestrationGate,
  SessionOrchestrationGateStatus,
  SessionOrchestrationSummary,
  SessionTask,
  SessionTaskStatus,
} from "./types";

function hasAffordance(node: SlopNode, action: string): boolean {
  return (node.affordances ?? []).some((affordance) => affordance.action === action);
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberProperty(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordProperty(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringListProperty(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function booleanProperty(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectListProperty(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function requireOkData(result: ResultMessage, context: string): Record<string, unknown> {
  if (result.status === "error") {
    throw new Error(`${context} failed: ${result.error?.message ?? result.error?.code ?? "error"}`);
  }
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new Error(`${context} did not return an object result.`);
  }
  return result.data as Record<string, unknown>;
}

function normalizeGateStatus(value: unknown): SessionOrchestrationGateStatus {
  switch (value) {
    case "accepted":
    case "rejected":
    case "cancelled":
      return value;
    default:
      return "open";
  }
}

const DEFAULT_CONFIG = await defaultConfigPromise;
const MAX_PENDING_ORCHESTRATION_GATES = 5;

function normalizeTaskStatus(status: unknown): SessionTaskStatus {
  switch (status) {
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "superseded":
      return "superseded";
    default:
      return "running";
  }
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

function parseApprovalsTree(
  providerId: string,
  tree: SlopNode | null,
  pendingApproval: {
    turnId: string;
    invocation: AgentToolInvocation;
    sourceApprovalId: string;
  } | null,
): ApprovalItem[] {
  if (!tree?.children) {
    return [];
  }

  return tree.children.map((node) => {
    const properties = node.properties ?? {};
    const item: ApprovalItem = {
      id: buildMirroredItemId("approval", providerId, node.id),
      status:
        properties.status === "approved" ||
        properties.status === "rejected" ||
        properties.status === "expired"
          ? properties.status
          : "pending",
      provider: providerId,
      path: typeof properties.path === "string" ? properties.path : "/",
      action: typeof properties.action === "string" ? properties.action : "unknown",
      reason:
        typeof properties.reason === "string" ? properties.reason : "Provider approval requested.",
      createdAt:
        typeof properties.created_at === "string"
          ? properties.created_at
          : new Date().toISOString(),
      resolvedAt: typeof properties.resolved_at === "string" ? properties.resolved_at : undefined,
      paramsPreview:
        typeof properties.params_preview === "string" ? properties.params_preview : undefined,
      dangerous: typeof properties.dangerous === "boolean" ? properties.dangerous : undefined,
      sourceApprovalId: node.id,
      sourcePath: `/approvals/${node.id}`,
      canApprove: hasAffordance(node, "approve"),
      canReject: hasAffordance(node, "reject"),
    };

    // Strict id-match. Tuple-matching (provider/path/action) was racy when
    // multiple approvals exist for the same affordance — could resume the
    // wrong turn. The approval id is now plumbed through `AgentToolEvent`
    // synchronously, so this match is unambiguous.
    if (
      pendingApproval &&
      item.status === "pending" &&
      item.provider === pendingApproval.invocation.providerId &&
      item.sourceApprovalId === pendingApproval.sourceApprovalId
    ) {
      item.turnId = pendingApproval.turnId;
    }

    return item;
  });
}

function parseTasksTree(providerId: string, tree: SlopNode | null): SessionTask[] {
  if (!tree?.children) {
    return [];
  }

  return tree.children.map((node) => {
    const properties = node.properties ?? {};
    const sourceTaskId =
      typeof properties.provider_task_id === "string"
        ? properties.provider_task_id
        : typeof properties.task_id === "string"
          ? properties.task_id
          : node.id;

    return {
      id: buildMirroredItemId("task", providerId, sourceTaskId),
      status: normalizeTaskStatus(properties.status),
      provider: providerId,
      providerTaskId: sourceTaskId,
      startedAt:
        typeof properties.started_at === "string"
          ? properties.started_at
          : typeof properties.startedAt === "string"
            ? properties.startedAt
            : new Date().toISOString(),
      updatedAt:
        typeof properties.updated_at === "string"
          ? properties.updated_at
          : new Date().toISOString(),
      message:
        typeof properties.message === "string"
          ? properties.message
          : typeof properties.summary === "string"
            ? properties.summary
            : "Provider task update",
      progress: typeof properties.progress === "number" ? properties.progress : undefined,
      error: typeof properties.error === "string" ? properties.error : undefined,
      sourceTaskId,
      sourcePath: `/tasks/${node.id}`,
      canCancel: hasAffordance(node, "cancel"),
    } satisfies SessionTask;
  });
}

function parseOrchestrationRootTree(
  providerId: string,
  tree: SlopNode | null,
): Partial<SessionOrchestrationSummary> {
  const properties = tree?.properties ?? {};
  const taskCounts = recordProperty(properties.task_counts) ?? {};
  const messageCounts = recordProperty(properties.message_counts) ?? {};
  const driftMetrics = recordProperty(properties.drift_metrics) ?? {};
  const progressMetrics = recordProperty(driftMetrics.progress) ?? {};
  const coherenceMetrics = recordProperty(driftMetrics.coherence) ?? {};
  const intentMetrics = recordProperty(driftMetrics.intent) ?? {};
  const scheduled = numberProperty(taskCounts.scheduled) ?? 0;
  const running = numberProperty(taskCounts.running) ?? 0;
  const verifying = numberProperty(taskCounts.verifying) ?? 0;
  return {
    available: true,
    provider: providerId,
    planId: stringProperty(properties.plan_id),
    planStatus: stringProperty(properties.plan_status) ?? "none",
    planVersion: numberProperty(properties.plan_version),
    activeSliceCount: scheduled + running + verifying,
    completedSliceCount: numberProperty(taskCounts.completed) ?? 0,
    failedSliceCount: numberProperty(taskCounts.failed) ?? 0,
    precedentResolvedCount: numberProperty(messageCounts.precedent_resolved),
    semanticPrecedentResolvedCount: numberProperty(messageCounts.semantic_precedent_resolved),
    precedentEscalatedCount: numberProperty(messageCounts.precedent_escalated),
    openDriftEventCount: numberProperty(properties.open_drift_event_count),
    blockingDriftEventCount: numberProperty(properties.blocking_drift_event_count),
    progressCriteriaTotal: numberProperty(progressMetrics.criteria_total),
    progressCriteriaSatisfied: numberProperty(progressMetrics.criteria_satisfied),
    progressCriteriaUnknown: numberProperty(progressMetrics.criteria_unknown),
    progressPriorDistance: numberProperty(progressMetrics.prior_distance),
    progressCurrentDistance: numberProperty(progressMetrics.current_distance),
    progressVelocity: numberProperty(progressMetrics.velocity),
    goalRevisionPressure: numberProperty(intentMetrics.goal_revision_pressure),
    latestGoalRevisionMagnitude: stringProperty(intentMetrics.latest_goal_revision_magnitude),
    coherenceBreaches: stringListProperty(coherenceMetrics.breaches),
    coherenceThresholds: recordProperty(coherenceMetrics.thresholds),
  };
}

function parseOrchestrationGatesTree(
  providerId: string,
  tree: SlopNode | null,
): Partial<SessionOrchestrationSummary> {
  const gates = tree?.children ?? [];
  const openGates = gates
    .filter((node) => node.properties?.status === "open")
    .sort((left, right) => {
      const leftCreated = stringProperty(left.properties?.created_at) ?? "";
      const rightCreated = stringProperty(right.properties?.created_at) ?? "";
      return leftCreated.localeCompare(rightCreated);
    });
  const pendingGates: SessionOrchestrationGate[] = openGates
    .slice(0, MAX_PENDING_ORCHESTRATION_GATES)
    .map((node) => {
      const properties = node.properties ?? {};
      const summary =
        stringProperty(properties.summary) ??
        stringProperty((node as { summary?: unknown }).summary) ??
        "Orchestration gate pending.";
      const canResolve = hasAffordance(node, "resolve_gate");
      return {
        id: buildMirroredItemId("gate", providerId, node.id),
        sourceGateId: node.id,
        gateType: stringProperty(properties.gate_type),
        status: normalizeGateStatus(properties.status),
        subjectRef: stringProperty(properties.subject_ref),
        summary,
        evidenceRefs: stringListProperty(properties.evidence_refs),
        createdAt: stringProperty(properties.created_at) ?? new Date().toISOString(),
        version: numberProperty(properties.version),
        canAccept: canResolve,
        canReject: canResolve,
      };
    });
  const latest = openGates.at(-1);
  return {
    available: true,
    provider: providerId,
    pendingGateCount: openGates.length,
    pendingGates,
    latestBlockingGateId: latest?.id,
    latestBlockingGateType: stringProperty(latest?.properties?.gate_type),
    latestBlockingGateSummary:
      stringProperty(latest?.properties?.summary) ??
      stringProperty((latest as { summary?: unknown } | undefined)?.summary),
  };
}

function parseOrchestrationAuditTree(
  providerId: string,
  tree: SlopNode | null,
): Partial<SessionOrchestrationSummary> {
  const audits = tree?.children ?? [];
  const latest = audits.at(-1);
  const status = latest?.properties?.status;
  return {
    available: true,
    provider: providerId,
    finalAuditId: latest?.id,
    finalAuditStatus: status === "passed" || status === "failed" ? status : "none",
  };
}

function parseDigestAction(value: unknown): SessionDigestAction | null {
  const record = recordProperty(value);
  if (!record) {
    return null;
  }
  const id = stringProperty(record.id);
  const actionPath = stringProperty(record.action_path);
  const actionName = stringProperty(record.action_name);
  if (!id || !actionPath || !actionName) {
    return null;
  }
  return {
    id,
    kind: stringProperty(record.kind),
    label: stringProperty(record.label) ?? actionName,
    targetRef: stringProperty(record.target_ref),
    actionPath,
    actionName,
    params: recordProperty(record.params) ?? {},
    urgency:
      record.urgency === "low" || record.urgency === "normal" || record.urgency === "high"
        ? record.urgency
        : undefined,
  };
}

function parseOrchestrationDigestsTree(
  providerId: string,
  tree: SlopNode | null,
): Partial<SessionOrchestrationSummary> {
  const properties = tree?.properties ?? {};
  const latestDigestId = stringProperty(properties.latest_digest_id);
  const latest =
    latestDigestId && tree?.children
      ? tree.children.find((node) => node.id === latestDigestId)
      : tree?.children?.at(-1);
  const latestProps = latest?.properties ?? {};
  const rawActions = Array.isArray(latestProps.actions) ? latestProps.actions : [];
  const pendingDeliveries = objectListProperty(properties.pending_deliveries);
  const latestDeliveryError = pendingDeliveries
    .map((delivery) => stringProperty(delivery.last_error))
    .filter((error): error is string => error !== undefined)
    .at(-1);
  return {
    available: true,
    provider: providerId,
    latestDigestId,
    latestDigestStatus: stringProperty(properties.latest_status),
    pendingDigestDeliveryCount: numberProperty(properties.pending_delivery_count),
    latestDigestDeliveryError: latestDeliveryError,
    latestDigestActions: rawActions
      .map((actionValue) => parseDigestAction(actionValue))
      .filter((action): action is SessionDigestAction => action !== null),
  };
}

export interface SessionAgent {
  start(): Promise<void>;
  chat(userMessage: string): Promise<AgentRunResult>;
  resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult>;
  invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage>;
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

export type ExternalSessionAgentState = {
  provider: string;
  model: string;
  profileId?: string;
  label?: string;
  message?: string;
};

function toSessionLlmState(state: RuntimeLlmStateSnapshot): LlmStateSnapshot {
  return {
    status: state.status,
    message: state.message,
    activeProfileId: state.activeProfileId,
    selectedProvider: state.selectedProvider,
    selectedModel: state.selectedModel,
    secureStoreKind: state.secureStoreKind,
    secureStoreStatus: state.secureStoreStatus,
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      apiKeyEnv: profile.apiKeyEnv,
      baseUrl: profile.baseUrl,
      isDefault: profile.isDefault,
      hasKey: profile.hasKey,
      keySource: profile.keySource,
      ready: profile.ready,
      managed: profile.managed,
      origin: profile.origin,
      canDeleteProfile: profile.canDeleteProfile,
      canDeleteApiKey: profile.canDeleteApiKey,
    })),
  };
}

function toExternalAgentLlmState(agent: ExternalSessionAgentState): LlmStateSnapshot {
  const profileId = agent.profileId ?? `external-${agent.provider}`;
  const label = agent.label ?? `${agent.provider} ${agent.model}`;
  return {
    status: "ready",
    message: agent.message ?? `Ready to chat with ${label}.`,
    activeProfileId: profileId,
    selectedProvider: agent.provider,
    selectedModel: agent.model,
    secureStoreKind: "none",
    secureStoreStatus: "unsupported",
    profiles: [
      {
        id: profileId,
        label,
        provider: agent.provider,
        model: agent.model,
        isDefault: true,
        hasKey: false,
        keySource: "not_required",
        ready: true,
        managed: false,
        origin: "fallback",
        canDeleteProfile: false,
        canDeleteApiKey: false,
      },
    ],
  };
}

function toSessionApps(states: ExternalProviderState[]): ExternalAppSnapshot[] {
  return states.map((state) => ({
    id: state.id,
    name: state.name,
    transport: state.transport,
    status: state.status,
    lastError: state.lastError,
  }));
}

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
  },
): SessionAgent {
  return new Agent({
    config,
    llmProfileManager,
    llmProfileId: extras?.llmProfileId,
    llmModelOverride: extras?.llmModelOverride,
    ignoredProviderIds,
    role,
    roleId: extras?.roleId,
    roleRegistry: extras?.roleRegistry,
    publishEvent: extras?.publishEvent,
    mirrorProviderPaths: ["/approvals", "/tasks", "/orchestration", "/gates", "/audit", "/digests"],
    ...callbacks,
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
  private pendingApproval: {
    turnId: string;
    invocation: AgentToolInvocation;
    /** Hub approval id, known synchronously when the event fires. */
    sourceApprovalId: string;
    /** Mirrored session-scoped approval id; populated when /approvals syncs. */
    sessionApprovalId?: string;
  } | null = null;

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
    requiresLlmProfile?: boolean;
    externalAgentState?: ExternalSessionAgentState;
    llmProfileId?: string;
    llmModelOverride?: string;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.requiresLlmProfile = options?.requiresLlmProfile ?? true;
    this.externalAgentState = options?.externalAgentState;
    this.llmProfileManager =
      options?.llmProfileManager ??
      new LlmProfileManager({
        config: this.config,
      });
    this.store =
      options?.store ??
      new SessionStore({
        sessionId: options?.sessionId ?? crypto.randomUUID(),
        modelProvider: this.config.llm.provider,
        model: this.config.llm.model,
        title: options?.title,
        workspaceRoot: this.config.providers.filesystem.root,
      });

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
      onToolEvent: (event) => {
        if (!this.currentTurnId) {
          return;
        }

        this.handleToolEvent(this.currentTurnId, event);
      },
      onProviderSnapshot: (update) => {
        if (update.path === "/approvals") {
          const approvals = parseApprovalsTree(
            update.providerId,
            update.tree,
            this.pendingApproval,
          );
          const matchedApproval = approvals.find(
            (approval) => approval.turnId === this.pendingApproval?.turnId,
          );
          if (matchedApproval && this.pendingApproval && !this.pendingApproval.sessionApprovalId) {
            this.pendingApproval.sessionApprovalId = matchedApproval.id;
          }
          this.store.syncProviderApprovals(update.providerId, approvals);
          return;
        }

        if (update.path === "/orchestration") {
          this.store.syncOrchestrationSummary(
            parseOrchestrationRootTree(update.providerId, update.tree),
          );
          return;
        }

        if (update.path === "/gates") {
          this.store.syncOrchestrationSummary(
            parseOrchestrationGatesTree(update.providerId, update.tree),
          );
          return;
        }

        if (update.path === "/audit") {
          this.store.syncOrchestrationSummary(
            parseOrchestrationAuditTree(update.providerId, update.tree),
          );
          return;
        }

        if (update.path === "/digests") {
          this.store.syncOrchestrationSummary(
            parseOrchestrationDigestsTree(update.providerId, update.tree),
          );
          return;
        }

        if (update.path !== "/tasks") {
          return;
        }

        this.store.syncProviderTasks(
          update.providerId,
          parseTasksTree(update.providerId, update.tree),
        );
      },
      onExternalProviderStates: (states) => {
        const currentApps = this.store.getSnapshot().apps;
        const nextConnectedAppIds = new Set(
          states.filter((state) => state.status === "connected").map((state) => state.id),
        );

        for (const app of currentApps) {
          if (app.status === "connected" && !nextConnectedAppIds.has(app.id)) {
            this.store.clearProviderMirrors(app.id);
          }
        }

        this.store.syncApps(toSessionApps(states));
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
          },
        ));
    this.agent = agentFactory(finalCallbacks, this.config, this.llmProfileManager);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.agent.start();
    await this.refreshLlmState();
    this.started = true;
  }

  async sendMessage(text: string): Promise<{ turnId: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Message text cannot be empty.");
    }

    if (this.currentTurnId) {
      throw new Error("A turn is already running for this session.");
    }

    await this.start();
    if (this.requiresLlmProfile) {
      await this.refreshLlmState({ requireReady: true });
    }
    const turnId = this.store.beginTurn(trimmed);
    this.currentTurnId = turnId;
    this.activeTurnPromise = this.runTurn(turnId, trimmed);
    return { turnId };
  }

  async saveLlmProfile(params: Record<string, unknown>): Promise<{ status: string }> {
    const provider = llmProviderSchema.parse(String(params.provider ?? "").trim());
    const profileId = typeof params.profile_id === "string" ? params.profile_id : undefined;
    const label = typeof params.label === "string" ? params.label : undefined;
    const model = typeof params.model === "string" ? params.model : undefined;
    const baseUrl = typeof params.base_url === "string" ? params.base_url : undefined;
    const apiKey = typeof params.api_key === "string" ? params.api_key : undefined;
    const makeDefault = typeof params.make_default === "boolean" ? params.make_default : undefined;

    const state = await this.llmProfileManager.saveProfile({
      profileId,
      label,
      provider,
      model,
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

  async approveApproval(approvalId: string): Promise<{ approvalId: string; status: string }> {
    const approval = this.store.getApproval(approvalId);
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
    }

    // Resolve through the hub-owned approval queue directly so we get the raw
    // inner ResultMessage from the underlying invoke (status / task_id /
    // data). Going via `agent.invokeProvider("/approvals/{id}", "approve")`
    // would let the SLOP server wrap that inner result a second time, hiding
    // `accepted` + task identity for async-approved actions. The provider
    // action stays in place as the public surface for UI/model callers.
    const result = await this.agent.resolveApprovalDirect(approval.sourceApprovalId);
    if (this.shouldResumePendingApproval(approval)) {
      const toolUseId = this.pendingToolUseId(approval);
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
      });
    }

    return {
      approvalId,
      status: result.status,
    };
  }

  async rejectApproval(
    approvalId: string,
    reason?: string,
  ): Promise<{ approvalId: string; status: string }> {
    const approval = this.store.getApproval(approvalId);
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
    }

    // Reject through the hub-owned queue directly to mirror the approve path.
    // The provider action `/approvals/{id}.reject` remains the public surface
    // for UI/model callers.
    this.agent.rejectApprovalDirect(approval.sourceApprovalId, reason);
    if (this.shouldResumePendingApproval(approval)) {
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
      status: "rejected",
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

  async acceptOrchestrationGate(
    gateId: string,
    resolution?: string,
  ): Promise<{ gateId: string; sourceGateId: string; status: string }> {
    return this.resolveOrchestrationGate(gateId, "accepted", resolution);
  }

  async rejectOrchestrationGate(
    gateId: string,
    resolution?: string,
  ): Promise<{ gateId: string; sourceGateId: string; status: string }> {
    return this.resolveOrchestrationGate(gateId, "rejected", resolution);
  }

  async startSpecDrivenGoal(params: Record<string, unknown>): Promise<{
    goal_id: string;
    goal_version: number;
    spec_id: string;
    spec_version: number;
    spec_gate_id: string;
    plan_revision_id?: string;
    plan_gate_id?: string;
    task_ids?: string[];
    pending_gate_ids: string[];
    message_ids: string[];
  }> {
    await this.start();

    const intent = stringProperty(params.intent);
    if (!intent) {
      throw new Error("start_spec_driven_goal requires intent.");
    }
    const title = stringProperty(params.title) ?? "Spec-driven goal";
    const requirements = objectListProperty(params.requirements);
    const slices = objectListProperty(params.slices);
    const autoAcceptSpec = booleanProperty(params.auto_accept_spec) ?? false;
    const autoAcceptPlan = booleanProperty(params.auto_accept_plan) ?? false;

    const goal = requireOkData(
      await this.agent.invokeProvider("orchestration", "/goals", "create_goal", {
        title,
        intent,
      }),
      "create_goal",
    );
    const goalId = stringProperty(goal.id);
    const goalVersion = numberProperty(goal.version);
    if (!goalId || goalVersion === undefined) {
      throw new Error("create_goal returned incomplete goal refs.");
    }

    const specBody =
      stringProperty(params.spec_body) ?? [`# ${title}`, "", "## Intent", intent, ""].join("\n");
    const spec = requireOkData(
      await this.agent.invokeProvider("spec", "/specs", "create_spec", {
        title: `${title} spec`,
        body: specBody,
        goal_id: goalId,
        goal_version: goalVersion,
      }),
      "create_spec",
    );
    const specId = stringProperty(spec.id);
    const draftSpecVersion = numberProperty(spec.version);
    if (!specId || draftSpecVersion === undefined) {
      throw new Error("create_spec returned incomplete spec refs.");
    }

    const messageIds: string[] = [];
    const specMessage = requireOkData(
      await this.agent.invokeProvider(
        "orchestration",
        "/orchestration",
        "submit_protocol_message",
        {
          kind: "SpecRevisionProposal",
          from_role: "spec-agent",
          to_role: "user",
          summary: `Spec agent drafted ${specId} for goal ${goalId}.`,
          artifact_refs: [`goal:${goalId}:v${goalVersion}`, `spec:${specId}:v${draftSpecVersion}`],
        },
      ),
      "submit spec proposal message",
    );
    const specMessageId = stringProperty(specMessage.id);
    if (specMessageId) {
      messageIds.push(specMessageId);
    }

    let currentSpecVersion = draftSpecVersion;
    for (const requirement of requirements) {
      const text = stringProperty(requirement.text);
      if (!text) {
        continue;
      }
      const requirementParams: Record<string, unknown> = { text };
      const priority = stringProperty(requirement.priority);
      const tags = stringListProperty(requirement.tags);
      const criterionKind = stringProperty(requirement.criterion_kind);
      const verificationHint = stringProperty(requirement.verification_hint);
      if (priority) requirementParams.priority = priority;
      if (tags.length > 0) requirementParams.tags = tags;
      if (criterionKind) requirementParams.criterion_kind = criterionKind;
      if (verificationHint) requirementParams.verification_hint = verificationHint;
      requireOkData(
        await this.agent.invokeProvider(
          "spec",
          `/specs/${specId}`,
          "add_requirement",
          requirementParams,
        ),
        "add_requirement",
      );
      currentSpecVersion += 1;
    }

    const specGate = requireOkData(
      await this.agent.invokeProvider("orchestration", "/gates", "open_gate", {
        gate_type: "spec_accept",
        subject_ref: `spec:${specId}:v${currentSpecVersion}`,
        summary: `Accept ${specId} v${currentSpecVersion} for goal ${goalId}.`,
        evidence_refs: [`goal:${goalId}:v${goalVersion}`, `spec:${specId}:v${currentSpecVersion}`],
      }),
      "open spec_accept gate",
    );
    const specGateId = stringProperty(specGate.id);
    if (!specGateId) {
      throw new Error("open_gate returned no spec gate id.");
    }

    let acceptedSpecVersion = currentSpecVersion;
    const pendingGateIds: string[] = [specGateId];
    if (autoAcceptSpec) {
      await this.agent.invokeProvider("orchestration", `/gates/${specGateId}`, "resolve_gate", {
        status: "accepted",
        resolution: "Accepted by start_spec_driven_goal.",
      });
      const acceptedSpec = requireOkData(
        await this.agent.invokeProvider("spec", `/specs/${specId}`, "accept_spec", {
          gate_id: specGateId,
        }),
        "accept_spec",
      );
      acceptedSpecVersion = numberProperty(acceptedSpec.version) ?? currentSpecVersion;
      const index = pendingGateIds.indexOf(specGateId);
      if (index >= 0) {
        pendingGateIds.splice(index, 1);
      }
    }

    let planRevisionId: string | undefined;
    let planGateId: string | undefined;
    let taskIds: string[] | undefined;
    if (autoAcceptSpec && slices.length > 0) {
      const planMessage = requireOkData(
        await this.agent.invokeProvider(
          "orchestration",
          "/orchestration",
          "submit_protocol_message",
          {
            kind: "PlanRevisionProposal",
            from_role: "planner",
            to_role: "user",
            summary: `Planner proposed ${slices.length} slice(s) for ${specId}.`,
            artifact_refs: [
              `goal:${goalId}:v${goalVersion}`,
              `spec:${specId}:v${acceptedSpecVersion}`,
            ],
          },
        ),
        "submit plan proposal message",
      );
      const planMessageId = stringProperty(planMessage.id);
      if (planMessageId) {
        messageIds.push(planMessageId);
      }

      const revision = requireOkData(
        await this.agent.invokeProvider("orchestration", "/orchestration", "create_plan_revision", {
          query: title,
          strategy: stringProperty(params.strategy),
          max_agents: numberProperty(params.max_agents),
          goal_id: goalId,
          goal_version: goalVersion,
          spec_id: specId,
          spec_version: acceptedSpecVersion,
          planned_commit: stringProperty(params.planned_commit),
          slice_gate_resolver: stringProperty(params.slice_gate_resolver),
          budget: recordProperty(params.budget),
          slices,
        }),
        "create_plan_revision",
      );
      planRevisionId = stringProperty(revision.id);
      planGateId = stringProperty(revision.gate_id);
      if (planGateId) {
        pendingGateIds.push(planGateId);
      }

      if (autoAcceptPlan && planRevisionId && planGateId) {
        await this.agent.invokeProvider("orchestration", `/gates/${planGateId}`, "resolve_gate", {
          status: "accepted",
          resolution: "Accepted by start_spec_driven_goal.",
        });
        const acceptedPlan = requireOkData(
          await this.agent.invokeProvider(
            "orchestration",
            "/orchestration",
            "accept_plan_revision",
            {
              revision_id: planRevisionId,
              gate_id: planGateId,
            },
          ),
          "accept_plan_revision",
        );
        taskIds = stringListProperty(acceptedPlan.task_ids);
        const index = pendingGateIds.indexOf(planGateId);
        if (index >= 0) {
          pendingGateIds.splice(index, 1);
        }
      }
    }

    return {
      goal_id: goalId,
      goal_version: goalVersion,
      spec_id: specId,
      spec_version: acceptedSpecVersion,
      spec_gate_id: specGateId,
      plan_revision_id: planRevisionId,
      plan_gate_id: planGateId,
      task_ids: taskIds,
      pending_gate_ids: pendingGateIds,
      message_ids: messageIds,
    };
  }

  async runDigestAction(actionId: string): Promise<{
    actionId: string;
    status: string;
  }> {
    const action = this.store
      .getSnapshot()
      .orchestration.latestDigestActions.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new Error(`Unknown digest action: ${actionId}`);
    }
    const providerId = this.store.getSnapshot().orchestration.provider;
    if (!providerId) {
      throw new Error(`Digest action is missing downstream provider: ${actionId}`);
    }
    const result = await this.agent.invokeProvider(
      providerId,
      action.actionPath,
      action.actionName,
      action.params,
    );
    return {
      actionId,
      status: result.status,
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

    return snapshot.turn.state === "running" && snapshot.turn.waitingOn === "model";
  }

  private async resolveOrchestrationGate(
    gateId: string,
    status: "accepted" | "rejected",
    resolution?: string,
  ): Promise<{ gateId: string; sourceGateId: string; status: string }> {
    const gate = this.store.getOrchestrationGate(gateId);
    if (!gate) {
      throw new Error(`Unknown or non-open orchestration gate: ${gateId}`);
    }

    if (gate.status !== "open") {
      throw new Error(`Orchestration gate is no longer open: ${gateId}`);
    }

    const providerId = this.store.getSnapshot().orchestration.provider;
    if (!providerId) {
      throw new Error(`Orchestration gate is missing downstream provider: ${gateId}`);
    }

    if (!gate.sourceGateId) {
      throw new Error(`Orchestration gate is missing source identifier: ${gateId}`);
    }

    const canResolve = status === "accepted" ? gate.canAccept : gate.canReject;
    if (!canResolve) {
      throw new Error(`Orchestration gate cannot be ${status}: ${gateId}`);
    }

    const params: Record<string, unknown> = { status };
    if (resolution !== undefined) {
      params.resolution = resolution;
    }
    if (gate.version !== undefined) {
      params.expected_version = gate.version;
    }

    const result = await this.agent.invokeProvider(
      providerId,
      `/gates/${gate.sourceGateId}`,
      "resolve_gate",
      params,
    );
    return {
      gateId,
      sourceGateId: gate.sourceGateId,
      status: result.status,
    };
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
      return {
        status: "cancelled",
        turnId,
      };
    }

    if (!this.agent.cancelActiveTurn()) {
      throw new Error("Turn cancellation is not available in the current phase.");
    }

    return {
      status: "cancelling",
      turnId,
    };
  }

  async waitForIdle(): Promise<void> {
    await this.activeTurnPromise;
  }

  shutdown(): void {
    this.agent.shutdown();
    this.started = false;
    this.currentTurnId = null;
    this.pendingApproval = null;
    this.activeTurnPromise = null;
    this.store.close();
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
          taskId: event.taskId,
          errorMessage: event.errorMessage,
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
    return approval.sourceApprovalId === this.pendingApproval.sourceApprovalId;
  }

  private pendingToolUseId(approval: ApprovalItem): string {
    if (!this.pendingApproval || !this.shouldResumePendingApproval(approval)) {
      throw new Error(`Approval is not linked to the current pending turn: ${approval.id}`);
    }

    return this.pendingApproval.invocation.toolUseId;
  }

  private runTurn(turnId: string, userMessage: string): Promise<void> {
    return this.agent
      .chat(userMessage)
      .then((result) => {
        this.handleAgentResult(turnId, result);
      })
      .catch((error) => {
        this.handleTurnFailure(turnId, error);
      })
      .finally(() => {
        this.activeTurnPromise = null;
      });
  }

  private resumeTurn(turnId: string, result: ResolvedApprovalToolResult): Promise<void> {
    return this.agent
      .resumeWithToolResult(result)
      .then((nextResult) => {
        this.handleAgentResult(turnId, nextResult);
      })
      .catch((error) => {
        this.handleTurnFailure(turnId, error);
      })
      .finally(() => {
        this.activeTurnPromise = null;
      });
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
      return;
    }

    this.pendingApproval = null;
    this.currentTurnId = null;
    this.store.completeTurn(turnId, result.response);
  }

  private failTurn(turnId: string, error: unknown): void {
    this.pendingApproval = null;
    this.currentTurnId = null;
    this.store.failTurn(turnId, error instanceof Error ? error.message : String(error));
  }

  private handleTurnFailure(turnId: string, error: unknown): void {
    if (isLlmAbortError(error)) {
      this.pendingApproval = null;
      this.currentTurnId = null;
      this.store.cancelTurn(turnId, {
        message: "Turn cancelled by user.",
      });
      return;
    }

    this.failTurn(turnId, error);
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
    this.config = this.llmProfileManager.getConfig();
    this.agent.updateConfig?.(this.config);
    this.store.syncLlmState(toSessionLlmState(state));
  }
}

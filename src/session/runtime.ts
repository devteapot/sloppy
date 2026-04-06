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
} from "../core/agent";
import {
  LlmConfigurationError,
  LlmProfileManager,
  type LlmStateSnapshot as RuntimeLlmStateSnapshot,
} from "../llm/profile-manager";
import type { ToolResultContentBlock } from "../llm/types";
import { buildMirroredItemId, SessionStore } from "./store";
import type { ApprovalItem, LlmStateSnapshot, SessionTask, SessionTaskStatus } from "./types";

function hasAffordance(node: SlopNode, action: string): boolean {
  return (node.affordances ?? []).some((affordance) => affordance.action === action);
}

const DEFAULT_CONFIG = await defaultConfigPromise;

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
    sessionApprovalId?: string;
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

    if (
      pendingApproval &&
      item.status === "pending" &&
      item.provider === pendingApproval.invocation.providerId &&
      item.action === pendingApproval.invocation.action &&
      item.path === pendingApproval.invocation.path
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
  updateConfig?(config: SloppyConfig): void;
  shutdown(): void;
}

export type SessionAgentFactory = (
  callbacks: AgentCallbacks,
  config: SloppyConfig,
  llmProfileManager: LlmProfileManager,
) => SessionAgent;

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

function createDefaultSessionAgent(
  callbacks: AgentCallbacks,
  config: SloppyConfig,
  llmProfileManager: LlmProfileManager,
): SessionAgent {
  return new Agent({ config, llmProfileManager, ...callbacks });
}

export class SessionRuntime {
  config: SloppyConfig;
  readonly store: SessionStore;

  private agent: SessionAgent;
  private llmProfileManager: LlmProfileManager;
  private started = false;
  private currentTurnId: string | null = null;
  private activeTurnPromise: Promise<void> | null = null;
  private pendingApproval: {
    turnId: string;
    invocation: AgentToolInvocation;
    sessionApprovalId?: string;
  } | null = null;

  constructor(options?: {
    config?: SloppyConfig;
    sessionId?: string;
    title?: string;
    store?: SessionStore;
    agentFactory?: SessionAgentFactory;
    llmProfileManager?: LlmProfileManager;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
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

        this.store.syncProviderTasks(
          update.providerId,
          parseTasksTree(update.providerId, update.tree),
        );
      },
    };

    const agentFactory = options?.agentFactory ?? createDefaultSessionAgent;
    this.agent = agentFactory(callbacks, this.config, this.llmProfileManager);
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
    await this.refreshLlmState({ requireReady: true });
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

    const result = await this.agent.invokeProvider(
      approval.provider,
      approval.sourcePath,
      "approve",
    );
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

    await this.agent.invokeProvider(approval.provider, approval.sourcePath, "reject", {
      reason,
    });
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

  canCancelTurn(): boolean {
    return false;
  }

  async cancelTurn(): Promise<void> {
    throw new Error("Turn cancellation is not implemented yet.");
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
        this.pendingApproval = {
          turnId,
          invocation: event.invocation,
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

    if (this.pendingApproval.sessionApprovalId) {
      return this.pendingApproval.sessionApprovalId === approval.id;
    }

    return (
      approval.provider === this.pendingApproval.invocation.providerId &&
      approval.path === this.pendingApproval.invocation.path &&
      approval.action === this.pendingApproval.invocation.action
    );
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
        this.failTurn(turnId, error);
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
        this.failTurn(turnId, error);
      })
      .finally(() => {
        this.activeTurnPromise = null;
      });
  }

  private handleAgentResult(turnId: string, result: AgentRunResult): void {
    if (result.status === "waiting_approval") {
      this.pendingApproval = this.pendingApproval ?? {
        turnId,
        invocation: result.invocation,
      };
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

  private async refreshLlmState(options?: { requireReady?: boolean }): Promise<void> {
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

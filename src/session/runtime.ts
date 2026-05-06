import type { ResultMessage } from "@slop-ai/consumer/browser";

import { defaultConfigPromise } from "../config/load";
import { llmProviderSchema, llmReasoningEffortSchema, type SloppyConfig } from "../config/schema";
import type {
  AgentCallbacks,
  AgentRunResult,
  AgentToolEvent,
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
import type { ToolResultContentBlock } from "../llm/types";
import { isLlmAbortError } from "../llm/types";
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
import { ProfileSessionAgent } from "./profile-agent";
import { SessionStore } from "./store";
import type { ApprovalItem } from "./types";

export type { ExternalSessionAgentState } from "./llm-state";

const DEFAULT_CONFIG = await defaultConfigPromise;

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
    policyRules?: InvokePolicy[];
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.requiresLlmProfile = options?.requiresLlmProfile ?? true;
    this.externalAgentState = options?.externalAgentState;
    this.llmProfileManager =
      options?.llmProfileManager ??
      createRuntimeLlmProfileManager({
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
        syncProviderSnapshotToSession(this.store, update, this.pendingApproval);
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
    const reasoningEffort =
      typeof params.reasoning_effort === "string"
        ? llmReasoningEffortSchema.parse(params.reasoning_effort)
        : typeof params.reasoningEffort === "string"
          ? llmReasoningEffortSchema.parse(params.reasoningEffort)
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

import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { AgentRunResult, AgentToolEvent, ResolvedApprovalToolResult } from "../core/agent";
import { LlmRequestError } from "../llm/types";
import type { PendingApprovalMirror } from "./mirror-sync";
import type { ActivePluginTurn, PluginTurnRequest } from "./plugins/types";
import type {
  ApprovalResolutionResult,
  TurnCancelResult,
  TurnCoordinatorDeps,
  TurnCoordinatorSnapshot,
  TurnSubmission,
  TurnSubmissionResult,
} from "./turn-coordinator-types";
import type { ApprovalItem, ApprovalMode } from "./types";

export type {
  ApprovalResolutionResult,
  TurnAgentPort,
  TurnCancelResult,
  TurnCoordinatorDeps,
  TurnCoordinatorSnapshot,
  TurnSubmission,
  TurnSubmissionResult,
} from "./turn-coordinator-types";

export class TurnCoordinator {
  private currentTurnId: string | null = null;
  private activeTurnPromise: Promise<void> | null = null;
  private pendingApproval: PendingApprovalMirror | null = null;
  private autoApprovalDrain: Promise<void> = Promise.resolve();
  private readonly autoApprovalAttempts = new Set<string>();
  private readonly autoApprovalSourceAttempts = new Set<string>();
  private currentTurnStartedAt = 0;
  private currentTurnUsedTools = false;
  private currentPluginTurn: ActivePluginTurn | null = null;
  private stopped = false;

  constructor(private readonly deps: TurnCoordinatorDeps) {}

  snapshot(): TurnCoordinatorSnapshot {
    return {
      activeTurnId: this.currentTurnId,
      activePluginTurn: this.currentPluginTurn,
      pendingApproval: this.pendingApproval,
      canCancel: this.canCancel(),
      hasActiveRun: this.activeTurnPromise !== null,
    };
  }

  submit(request: TurnSubmission): TurnSubmissionResult {
    this.assertRunning();
    if (request.source === "user") {
      const trimmed = request.text.trim();
      if (!trimmed) {
        throw new Error("Message text cannot be empty.");
      }
      if (this.currentTurnId) {
        const queued = this.deps.store.enqueueMessage(trimmed);
        const position =
          this.deps.store.getSnapshot().queue.findIndex((message) => message.id === queued.id) + 1;
        this.deps.audit({
          kind: "turn_queued",
          queuedMessageId: queued.id,
          position,
          source: "user",
        });
        return { status: "queued", queuedMessageId: queued.id, position };
      }
      return this.startUserTurn(trimmed);
    }

    if (this.currentTurnId) {
      return this.queuePluginTurn(request.request);
    }
    return this.startPluginTurn(request.request);
  }

  cancelQueuedTurn(queuedMessageId: string): { queuedMessageId: string; status: string } {
    this.assertRunning();
    this.deps.store.removeQueuedMessage(queuedMessageId);
    this.deps.audit({ kind: "turn_queue_cancelled", queuedMessageId });
    return { queuedMessageId, status: "cancelled" };
  }

  drainQueue(): void {
    this.startNextQueuedTurn();
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.assertRunning();
    if (mode === "normal") {
      this.autoApprovalAttempts.clear();
      this.autoApprovalSourceAttempts.clear();
    }
    this.deps.store.setApprovalMode(mode);
    this.scheduleAutoApprovals();
  }

  scheduleAutoApprovals(): void {
    if (this.stopped || this.deps.store.getSnapshot().approvalPolicy.mode !== "auto") {
      return;
    }
    this.autoApprovalDrain = this.autoApprovalDrain
      .then(() => this.runAutoApprovalPass())
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.deps.audit({
          kind: "auto_approval_error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async runAutoApprovalPass(): Promise<void> {
    if (this.stopped) return;
    const snapshot = this.deps.store.getSnapshot();
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
    const pendingSourceKeys = new Set(
      snapshot.approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => this.approvalSourceKey(approval))
        .filter((key): key is string => key !== undefined),
    );
    if (this.pendingApproval) {
      pendingSourceKeys.add(this.pendingApprovalSourceKey(this.pendingApproval));
    }
    for (const sourceKey of this.autoApprovalSourceAttempts) {
      if (!pendingSourceKeys.has(sourceKey)) {
        this.autoApprovalSourceAttempts.delete(sourceKey);
      }
    }
    if (snapshot.approvalPolicy.mode !== "auto") {
      return;
    }

    const pendingApproval = this.pendingApproval;
    if (pendingApproval) {
      const sourceKey = this.pendingApprovalSourceKey(pendingApproval);
      const mirroredApproval = snapshot.approvals.find(
        (approval) =>
          approval.status === "pending" &&
          approval.provider === pendingApproval.invocation.providerId &&
          approval.sourceApprovalId === pendingApproval.sourceApprovalId,
      );
      if (!mirroredApproval && !this.autoApprovalSourceAttempts.has(sourceKey)) {
        this.autoApprovalSourceAttempts.add(sourceKey);
        try {
          await this.approvePendingTurnDirect(pendingApproval);
        } catch (error) {
          if (this.stopped) return;
          this.deps.audit({
            kind: "auto_approval_error",
            sourceApprovalId: pendingApproval.sourceApprovalId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const currentSnapshot = this.deps.store.getSnapshot();
    if (currentSnapshot.approvalPolicy.mode !== "auto") {
      return;
    }
    for (const approval of currentSnapshot.approvals) {
      if (this.stopped || this.deps.store.getSnapshot().approvalPolicy.mode !== "auto") {
        return;
      }
      const sourceKey = this.approvalSourceKey(approval);
      if (
        approval.status !== "pending" ||
        !approval.canApprove ||
        this.autoApprovalAttempts.has(approval.id) ||
        (sourceKey !== undefined && this.autoApprovalSourceAttempts.has(sourceKey))
      ) {
        continue;
      }
      this.autoApprovalAttempts.add(approval.id);
      if (sourceKey !== undefined) {
        this.autoApprovalSourceAttempts.add(sourceKey);
      }
      try {
        await this.resolveApproval(approval.id, "approve");
      } catch (error) {
        if (this.stopped) return;
        this.deps.audit({
          kind: "auto_approval_error",
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private approvalSourceKey(approval: ApprovalItem): string | undefined {
    return approval.sourceApprovalId
      ? JSON.stringify([approval.provider, approval.sourceApprovalId])
      : undefined;
  }

  private pendingApprovalSourceKey(approval: PendingApprovalMirror): string {
    return JSON.stringify([approval.invocation.providerId, approval.sourceApprovalId]);
  }

  async resolveApproval(
    approvalId: string,
    decision: "approve" | "reject",
    options?: { reason?: string },
  ): Promise<ApprovalResolutionResult> {
    this.assertRunning();
    return decision === "approve"
      ? this.approveApproval(approvalId)
      : this.rejectApproval(approvalId, options?.reason);
  }

  private async approveApproval(approvalId: string): Promise<ApprovalResolutionResult> {
    let approval = this.deps.store.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    if (!approval.canApprove || !approval.sourcePath) {
      throw new Error(`Approval cannot be approved: ${approvalId}`);
    }

    if (!approval.sourceApprovalId) {
      throw new Error(`Approval is missing source identifier: ${approvalId}`);
    }

    if (this.pendingApproval?.sourceApprovalId === approval.sourceApprovalId) {
      await this.activeTurnPromise;
      this.assertRunning();
      const current = this.deps.store.getApproval(approvalId);
      if (!current || current.status !== "pending") {
        return { approvalId, status: current?.status ?? "unknown" };
      }
      approval = current;
    }

    if (!approval.sourcePath || !approval.sourceApprovalId) {
      throw new Error(`Approval is missing source location: ${approvalId}`);
    }

    const resumePendingTurn = this.shouldResumePendingApproval(approval);
    const result = resumePendingTurn
      ? await this.deps.agent().resolveApprovalDirect(approval.sourceApprovalId)
      : await this.deps.agent().invokeProvider(approval.provider, approval.sourcePath, "approve");
    if (this.stopped) {
      return { approvalId, status: result.status };
    }
    if (this.shouldResumePendingApproval(approval)) {
      const pendingApproval = this.pendingApproval;
      if (pendingApproval) {
        this.resumeApprovedPendingTurn(pendingApproval, result, approval.turnId);
      }
    }

    return { approvalId, status: result.status };
  }

  private async approvePendingTurnDirect(pendingApproval: PendingApprovalMirror): Promise<void> {
    await this.activeTurnPromise;
    this.assertRunning();
    if (this.pendingApproval !== pendingApproval) {
      return;
    }

    const result = await this.deps.agent().resolveApprovalDirect(pendingApproval.sourceApprovalId);
    if (this.stopped || this.pendingApproval !== pendingApproval) {
      return;
    }
    this.resumeApprovedPendingTurn(pendingApproval, result, pendingApproval.turnId);
  }

  private resumeApprovedPendingTurn(
    pendingApproval: PendingApprovalMirror,
    result: ResultMessage,
    turnId?: string,
  ): void {
    const invocation = pendingApproval.invocation;
    this.pendingApproval = null;
    this.activeTurnPromise = this.resumeTurn(turnId ?? this.currentTurnId ?? "", {
      block: this.deps.buildToolResultBlock(invocation.toolUseId, result),
      status: result.status,
      summary: `${invocation.providerId}:${invocation.action} ${invocation.path}`,
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
      result: { kind: invocation.resultKind, data: result.data },
    });
  }

  private async rejectApproval(
    approvalId: string,
    reason?: string,
  ): Promise<ApprovalResolutionResult> {
    let approval = this.deps.store.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    if (!approval.canReject || !approval.sourcePath) {
      throw new Error(`Approval cannot be rejected: ${approvalId}`);
    }

    if (!approval.sourceApprovalId) {
      throw new Error(`Approval is missing source identifier: ${approvalId}`);
    }

    if (this.pendingApproval?.sourceApprovalId === approval.sourceApprovalId) {
      await this.activeTurnPromise;
      this.assertRunning();
      const current = this.deps.store.getApproval(approvalId);
      if (!current || current.status !== "pending") {
        return { approvalId, status: current?.status ?? "unknown" };
      }
      approval = current;
    }

    if (!approval.sourcePath || !approval.sourceApprovalId) {
      throw new Error(`Approval is missing source location: ${approvalId}`);
    }

    const resumePendingTurn = this.shouldResumePendingApproval(approval);
    const result = resumePendingTurn
      ? null
      : await this.deps
          .agent()
          .invokeProvider(
            approval.provider,
            approval.sourcePath,
            "reject",
            reason ? { reason } : undefined,
          );
    if (this.stopped) {
      return { approvalId, status: result?.status === "error" ? "error" : "rejected" };
    }
    if (resumePendingTurn) {
      this.deps.agent().rejectApprovalDirect(approval.sourceApprovalId, reason);
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

    return { approvalId, status: result?.status === "error" ? "error" : "rejected" };
  }

  async cancelActiveTurn(): Promise<TurnCancelResult> {
    this.assertRunning();
    const turnId = this.currentTurnId;
    if (!turnId) {
      throw new Error("No active turn to cancel.");
    }

    const message = "Turn cancelled by user.";
    if (this.pendingApproval) {
      const pendingApproval = this.pendingApproval;
      let approvalStatus: "rejected" | undefined;
      try {
        this.deps.agent().rejectApprovalDirect(pendingApproval.sourceApprovalId, message);
        approvalStatus = "rejected";
      } catch {
        // Best-effort provider cleanup should not block ending the local turn.
      }

      const pluginTurn = this.currentPluginTurn;
      this.deps.agent().clearPendingApproval();
      this.pendingApproval = null;
      this.currentTurnId = null;
      this.activeTurnPromise = null;
      this.deps.store.cancelTurn(turnId, {
        message,
        toolUseId: pendingApproval.invocation.toolUseId,
        approvalId: pendingApproval.sessionApprovalId,
        approvalStatus,
      });
      this.deps.audit({
        kind: "turn_cancelled",
        turnId,
        reason: "user",
        sourceApprovalId: pendingApproval.sourceApprovalId,
        sessionApprovalId: pendingApproval.sessionApprovalId,
        approvalStatus,
      });
      if (pluginTurn) {
        this.deps.plugins.onTurnFailure({ turnId, pluginTurn, message, cancelled: true });
      }
      this.currentPluginTurn = null;
      this.startNextQueuedTurn();
      return { status: "cancelled", turnId };
    }

    if (!this.deps.agent().cancelActiveTurn()) {
      throw new Error("Turn cancellation is not available in the current phase.");
    }

    this.deps.audit({ kind: "turn_cancel_requested", turnId, reason: "user" });
    return { status: "cancelling", turnId };
  }

  canCancel(): boolean {
    if (this.stopped) return false;
    const snapshot = this.deps.store.getSnapshot();
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
    this.stopped = true;
    this.currentTurnId = null;
    this.pendingApproval = null;
    this.activeTurnPromise = null;
    this.currentPluginTurn = null;
  }

  handleToolEvent(event: AgentToolEvent): void {
    if (this.stopped) return;
    const turnId = this.currentTurnId;
    if (!turnId) {
      return;
    }
    if (event.kind === "started") {
      this.currentTurnUsedTools = true;
    }
    switch (event.kind) {
      case "started": {
        this.deps.store.recordToolStart(turnId, {
          toolUseId: event.invocation.toolUseId,
          summary: event.summary,
          provider: event.invocation.providerId,
          path: event.invocation.path,
          action: event.invocation.action,
          label: event.invocation.label,
          paramsPreview: this.deps.previewToolParams(
            event.invocation.action,
            event.invocation.params,
          ),
        });
        break;
      }
      case "completed": {
        this.deps.store.recordToolCompletion(turnId, {
          toolUseId: event.invocation.toolUseId,
          summary: event.summary,
          status: event.status,
          provider: event.invocation.providerId,
          path: event.invocation.path,
          action: event.invocation.action,
          label: event.invocation.label,
          taskId: event.taskId,
          errorMessage: event.errorMessage,
          result: this.deps.boundToolResult(event.result),
        });
        break;
      }
      case "approval_requested": {
        if (!event.approvalId) {
          throw new Error(
            `approval_requested event missing approvalId for ${event.invocation.providerId}:${event.invocation.action}`,
          );
        }
        this.pendingApproval = {
          turnId,
          invocation: event.invocation,
          sourceApprovalId: event.approvalId,
        };
        this.deps.store.recordApprovalRequested(turnId, {
          toolUseId: event.invocation.toolUseId,
          summary: event.summary,
          provider: event.invocation.providerId,
          path: event.invocation.path,
          action: event.invocation.action,
          label: event.invocation.label,
          reason: event.errorMessage,
        });
        this.scheduleAutoApprovals();
        break;
      }
    }
  }

  private startUserTurn(userMessage: string): { status: "started"; turnId: string } {
    const turnId = this.deps.store.beginTurn(userMessage);
    this.currentTurnStartedAt = Date.now();
    this.currentTurnUsedTools = false;
    this.currentPluginTurn = null;
    this.currentTurnId = turnId;
    this.deps.audit({ kind: "turn_started", turnId, source: "user", continuation: false });
    this.activeTurnPromise = this.runTurn(turnId, userMessage);
    return { status: "started", turnId };
  }

  startPluginTurn(request: PluginTurnRequest): { status: "started"; turnId: string } {
    this.assertRunning();
    const turnId = this.deps.store.beginTurn(request.text, {
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
    this.deps.audit({
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

  queuePluginTurn(request: PluginTurnRequest): {
    status: "queued";
    queuedMessageId: string;
    position: number;
  } {
    this.assertRunning();
    const queued = this.deps.store.enqueueMessage(request.text, {
      author: request.author,
      source: "plugin",
      pluginId: request.pluginId,
      pluginRunId: request.runId,
      goalId: typeof request.metadata?.goalId === "string" ? request.metadata.goalId : undefined,
      continuation: request.continuation === true,
    });
    const position =
      this.deps.store.getSnapshot().queue.findIndex((message) => message.id === queued.id) + 1;
    return { status: "queued", queuedMessageId: queued.id, position };
  }

  private shouldResumePendingApproval(approval: ApprovalItem): boolean {
    if (!this.pendingApproval || approval.status !== "pending") {
      return false;
    }
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
    const run = this.deps
      .agent()
      .chat(userMessage)
      .then((result) => this.handleAgentResult(turnId, result))
      .catch((error) => this.handleTurnFailure(turnId, error));
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (this.activeTurnPromise === tracked) {
        this.activeTurnPromise = null;
      }
    });
    return tracked;
  }

  private resumeTurn(turnId: string, result: ResolvedApprovalToolResult): Promise<void> {
    const run = this.deps
      .agent()
      .resumeWithToolResult(result)
      .then((nextResult) => this.handleAgentResult(turnId, nextResult))
      .catch((error) => this.handleTurnFailure(turnId, error));
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (this.activeTurnPromise === tracked) {
        this.activeTurnPromise = null;
      }
    });
    return tracked;
  }

  private handleAgentResult(turnId: string, result: AgentRunResult): void {
    if (this.stopped) return;
    if (result.status === "waiting_approval") {
      if (!this.pendingApproval) {
        throw new Error(
          `Agent reported waiting_approval without a pending approval record (turn ${turnId}).`,
        );
      }
      this.deps.audit({
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
      this.deps.plugins.onTurnComplete({
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
    this.deps.store.completeTurn(turnId, result.response);
    this.deps.audit({
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
    if (this.stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    const pluginTurn = this.currentPluginTurn;
    this.pendingApproval = null;
    this.currentTurnId = null;
    const details =
      error instanceof LlmRequestError
        ? {
            errorCode: error.code,
            retryable: error.retryable,
            requestId: error.requestId,
            retryAfterMs: error.retryAfterMs,
            httpStatus: error.status,
            partialOutput: error.partialOutput,
          }
        : undefined;
    this.deps.store.failTurn(turnId, message, details);
    this.deps.audit({ kind: "turn_failed", turnId, errorMessage: message, ...details });
    if (pluginTurn) {
      this.deps.plugins.onTurnFailure({ turnId, pluginTurn, message, cancelled: false });
    }
    this.currentPluginTurn = null;
    this.startNextQueuedTurn();
  }

  private handleTurnFailure(turnId: string, error: unknown): void {
    if (this.stopped) return;
    if (this.deps.isAbortError(error)) {
      const pluginTurn = this.currentPluginTurn;
      this.pendingApproval = null;
      this.currentTurnId = null;
      this.deps.store.cancelTurn(turnId, { message: "Turn cancelled by user." });
      this.deps.audit({ kind: "turn_cancelled", turnId, reason: "llm_abort" });
      if (pluginTurn) {
        this.deps.plugins.onTurnFailure({
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
    if (this.stopped) return;
    if (this.currentTurnId) {
      return;
    }
    const next = this.deps.store.dequeueMessage();
    if (!next) {
      const pluginTurn = this.deps.plugins.nextTurn();
      if (pluginTurn) {
        this.startPluginTurn(pluginTurn);
      }
      return;
    }
    const pluginTurn = this.deps.plugins.acceptQueuedTurn(next);
    if (pluginTurn) {
      this.startPluginTurn(pluginTurn);
      return;
    }
    if (next.source === "plugin") {
      this.startNextQueuedTurn();
      return;
    }
    this.startUserTurn(next.text);
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("Turn coordinator has been shut down.");
    }
  }
}

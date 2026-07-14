import type {
  ActivityStatus,
  AgentSessionSnapshot,
  ApprovalItem,
  ApprovalMode,
  ExternalAppSnapshot,
  LlmStateSnapshot,
  QueuedSessionMessage,
  SessionExtensionRecord,
  SessionSnapshotProjector,
  SessionStoreChangeListener,
  SessionStoreEventType,
  SessionStoreGranularListener,
  SessionTask,
  TokenAccountingSource,
  ToolCallResult,
} from "../types";
import * as activity from "./activity";
import * as approvalPolicy from "./approval-policy";
import * as apps from "./apps";
import * as extensions from "./extensions";
import { now } from "./helpers";
import { ListenerRegistry } from "./listeners";
import * as llm from "./llm";
import * as mirrors from "./mirrors";
import {
  loadPersistedSessionSnapshot,
  persistSessionSnapshot,
  recoverPersistedSessionSnapshot,
  type SessionSnapshotMigrator,
  type SessionSnapshotRecoverer,
} from "./persistence";
import * as queue from "./queue";
import {
  cloneSnapshot,
  createInitialState,
  createStateFromSnapshot,
  type SessionStoreState,
} from "./state";
import * as transcript from "./transcript";
import * as turn from "./turn";
import * as usage from "./usage";

export { buildMirroredItemId } from "./helpers";

export class SessionStore {
  private state: SessionStoreState;
  private registry = new ListenerRegistry();
  private persistencePath?: string;
  private readonly extensionEventTypes: Record<string, SessionStoreEventType[]>;
  private readonly snapshotProjections: readonly SessionSnapshotProjector[];

  constructor(options: {
    sessionId: string;
    modelProvider: string;
    model: string;
    title?: string;
    workspaceRoot?: string;
    workspaceId?: string;
    projectId?: string;
    launchScope?: {
      key: string;
      root: string;
    };
    persistencePath?: string;
    snapshotMigrators?: readonly SessionSnapshotMigrator[];
    snapshotRecoverers?: readonly SessionSnapshotRecoverer[];
    /**
     * Plugin-registered projectors that derive projected snapshot fields
     * (e.g. `goal`) on every snapshot read. Callers constructing a store
     * outside SessionRuntime must register projections themselves.
     */
    snapshotProjections?: readonly SessionSnapshotProjector[];
    extensionEventTypes?: Record<string, readonly SessionStoreEventType[]>;
  }) {
    this.persistencePath = options.persistencePath;
    this.snapshotProjections = options.snapshotProjections ?? [];
    this.extensionEventTypes = Object.fromEntries(
      Object.entries(options.extensionEventTypes ?? {}).map(([namespace, eventTypes]) => [
        namespace,
        [...eventTypes],
      ]),
    );
    const persisted = options.persistencePath
      ? loadPersistedSessionSnapshot(options.persistencePath, {
          migrators: options.snapshotMigrators,
        })
      : null;
    this.state = persisted
      ? createStateFromSnapshot(
          recoverPersistedSessionSnapshot(persisted, options.persistencePath ?? "", {
            recoverers: options.snapshotRecoverers,
          }),
          this.snapshotProjections,
        )
      : createInitialState({ ...options, startedAt: now() });
    if (this.persistencePath && !persisted) {
      this.state.snapshot.session.persistencePath = this.persistencePath;
    }
    this.persist();
  }

  getSnapshot(): AgentSessionSnapshot {
    return cloneSnapshot(this.state.snapshot, this.snapshotProjections);
  }

  getApproval(approvalId: string): ApprovalItem | undefined {
    const approval = this.state.snapshot.approvals.find((item) => item.id === approvalId);
    return approval ? { ...approval } : undefined;
  }

  getTask(taskId: string): SessionTask | undefined {
    const task = this.state.snapshot.tasks.find((item) => item.id === taskId);
    return task ? { ...task } : undefined;
  }

  registerClient(clientId: string): void {
    const time = now();
    const existingIndex = this.state.snapshot.session.connectedClients.findIndex(
      (client) => client.clientId === clientId,
    );
    if (existingIndex !== -1) {
      this.state.snapshot.session.connectedClients[existingIndex].connectedAt = time;
    } else {
      this.state.snapshot.session.connectedClients.push({ clientId, connectedAt: time });
    }
    this.state.snapshot.session.clientCount = this.state.snapshot.session.connectedClients.length;
    this.state.snapshot.session.lastActivityAt = time;
    this.state.sessionChanged = true;
    this.emit();
  }

  unregisterClient(clientId: string): void {
    const time = now();
    this.state.snapshot.session.connectedClients =
      this.state.snapshot.session.connectedClients.filter((client) => client.clientId !== clientId);
    this.state.snapshot.session.clientCount = this.state.snapshot.session.connectedClients.length;
    this.state.snapshot.session.lastActivityAt = time;
    this.state.sessionChanged = true;
    this.emit();
  }

  onChange(listener: SessionStoreChangeListener): () => void {
    return this.registry.onChange(listener);
  }

  onTurnChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("turn", fn);
  }

  onGoalChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("goal", fn);
  }

  onQueueChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("queue", fn);
  }

  onTranscriptChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("transcript", fn);
  }

  onActivityChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("activity", fn);
  }

  onApprovalsChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("approvals", fn);
  }

  onTasksChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("tasks", fn);
  }

  onAppsChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("apps", fn);
  }

  onExtensionsChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("extensions", fn);
  }

  onLlmChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("llm", fn);
  }

  onUsageChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("usage", fn);
  }

  onSessionChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("session", fn);
  }

  syncLlmState(state: LlmStateSnapshot): void {
    llm.syncLlmState(this.state, state);
    this.emit();
  }

  recordUsage(options: {
    turnId?: string;
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    inputTokenSource: TokenAccountingSource;
    outputTokenSource: TokenAccountingSource;
    thinkingTokenSource?: TokenAccountingSource;
    stateContextTokens?: number;
    stateContextTokenSource?: TokenAccountingSource;
    modelContextWindowTokens?: number;
    availableContextTokens?: number;
  }): void {
    usage.recordUsage(this.state, options);
    this.emit();
  }

  syncUsageModelContext(options: { modelContextWindowTokens?: number }): void {
    usage.syncModelContext(this.state, options);
    this.emit();
  }

  setConfigRestartRequired(required: boolean, reason?: string): void {
    if (required) {
      this.state.snapshot.session.configRequiresRestart = true;
      this.state.snapshot.session.configRestartReason = reason;
    } else {
      delete this.state.snapshot.session.configRequiresRestart;
      delete this.state.snapshot.session.configRestartReason;
    }
    this.state.sessionChanged = true;
    this.emit();
  }

  beginTurn(
    userText: string,
    options?: {
      role?: "user" | "assistant" | "system";
      author?: string;
    },
  ): string {
    const turnId = turn.beginTurn(this.state, userText, options);
    this.emit();
    return turnId;
  }

  upsertExtension(record: SessionExtensionRecord, options?: { touchSession?: boolean }): void {
    extensions.upsertExtension(this.state, record, options);
    this.markExtensionEvents([record.namespace]);
    this.emit();
  }

  patchExtension(
    namespace: string,
    patch: (record: SessionExtensionRecord) => SessionExtensionRecord,
    options?: extensions.ExtensionPatchOptions,
  ): extensions.PatchExtensionResult {
    const result = extensions.patchExtension(this.state, namespace, patch, options);
    this.markExtensionEvents([namespace]);
    this.emit();
    return result;
  }

  clearExtension(namespace: string): boolean {
    const removed = extensions.clearExtension(this.state, namespace);
    if (removed) {
      this.markExtensionEvents([namespace]);
      this.emit();
    }
    return removed;
  }

  sweepExtensions(options?: { now?: string }): { removed: string[] } {
    const result = extensions.sweepExtensions(this.state, options);
    if (result.removed.length > 0) {
      this.markExtensionEvents(result.removed);
      this.emit();
    }
    return result;
  }

  enqueueMessage(
    text: string,
    options?: {
      author?: string;
      source?: "user" | "plugin";
      pluginId?: string;
      pluginRunId?: string;
      goalId?: string;
      continuation?: boolean;
    },
  ): QueuedSessionMessage {
    const message = queue.enqueueMessage(this.state, text, options);
    this.emit();
    return message;
  }

  dequeueMessage(): QueuedSessionMessage | undefined {
    const message = queue.dequeueMessage(this.state);
    if (message) {
      this.emit();
    }
    return message;
  }

  removeQueuedMessage(queuedMessageId: string): QueuedSessionMessage {
    const message = queue.removeQueuedMessage(this.state, queuedMessageId);
    this.emit();
    return message;
  }

  appendAssistantText(turnId: string, chunk: string): void {
    if (transcript.appendAssistantText(this.state, turnId, chunk)) {
      this.emit();
    }
  }

  appendAssistantThinking(
    turnId: string,
    options: {
      blockId?: string;
      provider?: string;
      model?: string;
      format: "raw" | "summary";
      display: "visible" | "hidden";
      delta?: string;
      text?: string;
      startedAt?: string;
      completedAt?: string;
      elapsedMs?: number;
      tokenCount?: number;
      tokenCountSource?: "reported" | "unavailable";
      done?: boolean;
    },
  ): void {
    if (transcript.appendAssistantThinking(this.state, turnId, options)) {
      this.emit();
    }
  }

  appendAssistantMedia(
    turnId: string,
    options: {
      mime: string;
      name?: string;
      uri?: string;
      summary?: string;
      preview?: string;
    },
  ): void {
    transcript.appendAssistantMedia(this.state, turnId, options);
    this.emit();
  }

  recordToolStart(
    turnId: string,
    options: {
      toolUseId: string;
      summary: string;
      provider?: string;
      path?: string;
      action?: string;
      label?: string;
      paramsPreview?: string;
    },
  ): void {
    activity.recordToolStart(this.state, turnId, options);
    this.emit();
  }

  recordToolCompletion(
    turnId: string,
    options: {
      toolUseId: string;
      summary: string;
      status: ActivityStatus;
      provider?: string;
      path?: string;
      action?: string;
      label?: string;
      taskId?: string;
      errorMessage?: string;
      result?: ToolCallResult;
    },
  ): void {
    activity.recordToolCompletion(this.state, turnId, options);
    this.emit();
  }

  recordApprovalRequested(
    turnId: string,
    options: {
      toolUseId: string;
      summary: string;
      provider?: string;
      path?: string;
      action?: string;
      label?: string;
      reason: string;
    },
  ): void {
    activity.recordApprovalRequested(this.state, turnId, options);
    this.emit();
  }

  syncProviderApprovals(providerId: string, approvals: ApprovalItem[]): void {
    mirrors.syncProviderApprovals(this.state, providerId, approvals);
    this.emit();
  }

  setApprovalMode(mode: ApprovalMode): void {
    approvalPolicy.setApprovalMode(this.state, mode);
    this.emit();
  }

  syncApps(items: ExternalAppSnapshot[]): void {
    apps.syncApps(this.state, items);
    this.emit();
  }

  cancelTurn(
    turnId: string,
    options?: {
      message?: string;
      toolUseId?: string;
      approvalId?: string;
      approvalStatus?: "approved" | "rejected" | "expired";
    },
  ): void {
    turn.cancelTurn(this.state, turnId, options);
    this.emit();
  }

  syncProviderTasks(providerId: string, tasks: SessionTask[]): void {
    mirrors.syncProviderTasks(this.state, providerId, tasks);
    this.emit();
  }

  clearProviderMirrors(providerId: string): void {
    if (mirrors.clearProviderMirrors(this.state, providerId)) {
      this.emit();
    }
  }

  completeTurn(turnId: string, finalText: string): void {
    turn.completeTurn(this.state, turnId, finalText, (tid, createdAt) =>
      transcript.getOrCreateAssistantMessage(this.state, tid, createdAt),
    );
    this.emit();
  }

  failTurn(turnId: string, message: string, details?: turn.ModelErrorDetails): void {
    turn.failTurn(this.state, turnId, message, details);
    this.emit();
  }

  close(): void {
    this.state.snapshot.session.status = "closed";
    this.state.snapshot.session.updatedAt = now();
    this.state.sessionChanged = true;
    this.emit();
  }

  trimResolvedApprovals(limit?: number): void {
    if (mirrors.trimResolvedApprovals(this.state, limit)) {
      this.emit();
    }
  }

  trimResolvedTasks(limit?: number): void {
    if (mirrors.trimResolvedTasks(this.state, limit)) {
      this.emit();
    }
  }

  private markExtensionEvents(namespaces: Iterable<string>): void {
    for (const namespace of namespaces) {
      for (const eventType of this.extensionEventTypes[namespace] ?? []) {
        this.markEventType(eventType);
      }
    }
  }

  private markEventType(eventType: SessionStoreEventType): void {
    switch (eventType) {
      case "turn":
        this.state.turnChanged = true;
        break;
      case "transcript":
        this.state.transcriptChanged = true;
        break;
      case "activity":
        this.state.activityChanged = true;
        break;
      case "approvals":
        this.state.approvalsChanged = true;
        break;
      case "tasks":
        this.state.tasksChanged = true;
        break;
      case "apps":
        this.state.appsChanged = true;
        break;
      case "llm":
        this.state.llmChanged = true;
        break;
      case "usage":
        this.state.usageChanged = true;
        break;
      case "session":
        this.state.sessionChanged = true;
        break;
      case "goal":
        this.state.snapshot.goal = null;
        this.state.goalChanged = true;
        break;
      case "extensions":
        this.state.extensionsChanged = true;
        break;
      case "queue":
        this.state.queueChanged = true;
        break;
    }
  }

  private emit(): void {
    this.persist();
    const snapshot = this.getSnapshot();
    this.registry.emit(this.state, snapshot);
  }

  private persist(): void {
    if (!this.persistencePath) {
      return;
    }
    try {
      persistSessionSnapshot(this.persistencePath, this.state.snapshot);
    } catch (error) {
      console.warn(
        `[sloppy] failed to persist session snapshot ${this.persistencePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

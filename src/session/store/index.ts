import type {
  ActivityStatus,
  AgentSessionSnapshot,
  ApprovalItem,
  ExternalAppSnapshot,
  LlmStateSnapshot,
  SessionStoreChangeListener,
  SessionStoreGranularListener,
  SessionTask,
} from "../types";
import * as activity from "./activity";
import * as apps from "./apps";
import { now } from "./helpers";
import { ListenerRegistry } from "./listeners";
import * as llm from "./llm";
import * as mirrors from "./mirrors";
import { cloneSnapshot, createInitialState, type SessionStoreState } from "./state";
import * as transcript from "./transcript";
import * as turn from "./turn";

export { buildMirroredItemId } from "./helpers";

export class SessionStore {
  private state: SessionStoreState;
  private registry = new ListenerRegistry();

  constructor(options: {
    sessionId: string;
    modelProvider: string;
    model: string;
    title?: string;
    workspaceRoot?: string;
  }) {
    this.state = createInitialState({ ...options, startedAt: now() });
  }

  getSnapshot(): AgentSessionSnapshot {
    return cloneSnapshot(this.state.snapshot);
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

  onLlmChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("llm", fn);
  }

  onSessionChange(fn: SessionStoreGranularListener): () => void {
    return this.registry.subscribeGranular("session", fn);
  }

  syncLlmState(state: LlmStateSnapshot): void {
    llm.syncLlmState(this.state, state);
    this.emit();
  }

  beginTurn(userText: string): string {
    const turnId = turn.beginTurn(this.state, userText);
    this.emit();
    return turnId;
  }

  appendAssistantText(turnId: string, chunk: string): void {
    if (transcript.appendAssistantText(this.state, turnId, chunk)) {
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
      taskId?: string;
      errorMessage?: string;
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

  failTurn(turnId: string, message: string): void {
    turn.failTurn(this.state, turnId, message);
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

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.registry.emit(this.state, snapshot);
  }
}

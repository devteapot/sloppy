import type {
  ActivityItem,
  ActivityStatus,
  AgentSessionSnapshot,
  AgentTurnPhase,
  ApprovalItem,
  ExternalAppSnapshot,
  LlmStateSnapshot,
  SessionStoreChangeListener,
  SessionStoreEventType,
  SessionStoreGranularListener,
  SessionTask,
  TranscriptMessage,
  TurnStateSnapshot,
} from "./types";

function now(): string {
  return new Date().toISOString();
}

function buildId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function buildMirroredItemId(prefix: string, providerId: string, sourceId: string): string {
  const cleanProviderId = providerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanSourceId = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefix}-${cleanProviderId}-${cleanSourceId}`;
}

function deriveTitle(userText: string): string {
  const truncated = userText.slice(0, 60);
  const trimmed = truncated.trim();
  if (!trimmed) {
    return "New Session";
  }
  const stripped = trimmed.replace(/[^a-zA-Z0-9 '-]/g, "");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return "New Session";
  }
  const titled = words
    .map((word) => {
      const cleaned = word.replace(/[^a-zA-Z0-9'-]/g, "");
      if (cleaned.length === 0) {
        return "";
      }
      const firstChar = cleaned.charAt(0);
      const rest = cleaned.slice(1);
      return firstChar.toUpperCase() + rest;
    })
    .filter((w) => w.length > 0);
  if (titled.length === 0) {
    return "New Session";
  }
  return titled.join(" ");
}

function cloneSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  return {
    session: {
      ...snapshot.session,
      connectedClients: snapshot.session.connectedClients.map(
        (client) => ({ ...client }),
      ),
    },
    llm: {
      ...snapshot.llm,
      profiles: snapshot.llm.profiles.map((profile) => ({ ...profile })),
    },
    turn: { ...snapshot.turn },
    transcript: snapshot.transcript.map((message) => ({
      ...message,
      content: message.content.map((block) => ({ ...block })),
    })),
    activity: snapshot.activity.map((item) => ({ ...item })),
    approvals: snapshot.approvals.map((item) => ({ ...item })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    apps: snapshot.apps.map((app) => ({ ...app })),
  };
}

function compareApps(left: ExternalAppSnapshot, right: ExternalAppSnapshot): number {
  const nameComparison = left.name.localeCompare(right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.id.localeCompare(right.id);
}

export class SessionStore {
  private snapshot: AgentSessionSnapshot;
  private listeners = new Set<SessionStoreChangeListener>();
  private granularListeners = new Map<
    SessionStoreEventType,
    Set<SessionStoreGranularListener>
  >();
  private activeAssistantMessageId: string | null = null;
  private activeModelActivityId: string | null = null;
  private activeApprovalActivityId: string | null = null;
  private toolActivityIds = new Map<string, string>();
  private turnChanged = false;
  private transcriptChanged = false;
  private activityChanged = false;
  private approvalsChanged = false;
  private tasksChanged = false;
  private appsChanged = false;
  private llmChanged = false;
  private sessionChanged = false;

  constructor(options: {
    sessionId: string;
    modelProvider: string;
    model: string;
    title?: string;
    workspaceRoot?: string;
  }) {
    const startedAt = now();
    this.snapshot = {
      session: {
        sessionId: options.sessionId,
        status: "active",
        modelProvider: options.modelProvider,
        model: options.model,
        startedAt,
        updatedAt: startedAt,
        lastActivityAt: startedAt,
        clientCount: 0,
        connectedClients: [],
        title: options.title,
        workspaceRoot: options.workspaceRoot,
      },
      llm: {
        status: "needs_credentials",
        message: "Add an API key to start the agent.",
        activeProfileId: "default",
        selectedProvider: options.modelProvider,
        selectedModel: options.model,
        secureStoreKind: "none",
        secureStoreStatus: "unsupported",
        profiles: [],
      },
      turn: {
        turnId: null,
        state: "idle",
        phase: "none",
        iteration: 0,
        startedAt: null,
        updatedAt: startedAt,
        message: "Idle",
      },
      transcript: [],
      activity: [],
      approvals: [],
      tasks: [],
      apps: [],
    };
  }

  getSnapshot(): AgentSessionSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getApproval(approvalId: string): ApprovalItem | undefined {
    const approval = this.snapshot.approvals.find((item) => item.id === approvalId);
    return approval ? { ...approval } : undefined;
  }

  getTask(taskId: string): SessionTask | undefined {
    const task = this.snapshot.tasks.find((item) => item.id === taskId);
    return task ? { ...task } : undefined;
  }

  registerClient(clientId: string): void {
    const time = now();
    const existingIndex = this.snapshot.session.connectedClients.findIndex(
      (client) => client.clientId === clientId,
    );
    if (existingIndex !== -1) {
      this.snapshot.session.connectedClients[existingIndex].connectedAt = time;
    } else {
      this.snapshot.session.connectedClients.push({ clientId, connectedAt: time });
    }
    this.snapshot.session.clientCount = this.snapshot.session.connectedClients.length;
    this.snapshot.session.lastActivityAt = time;
    this.sessionChanged = true;
    this.emitChange();
  }

  unregisterClient(clientId: string): void {
    const time = now();
    this.snapshot.session.connectedClients = this.snapshot.session.connectedClients.filter(
      (client) => client.clientId !== clientId,
    );
    this.snapshot.session.clientCount = this.snapshot.session.connectedClients.length;
    this.snapshot.session.lastActivityAt = time;
    this.sessionChanged = true;
    this.emitChange();
  }

  onChange(listener: SessionStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onTurnChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("turn", fn);
  }

  onTranscriptChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("transcript", fn);
  }

  onActivityChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("activity", fn);
  }

  onApprovalsChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("approvals", fn);
  }

  onTasksChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("tasks", fn);
  }

  onAppsChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("apps", fn);
  }

  onLlmChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("llm", fn);
  }

  onSessionChange(fn: SessionStoreGranularListener): () => void {
    return this.subscribeGranular("session", fn);
  }

  private subscribeGranular(
    eventType: SessionStoreEventType,
    fn: SessionStoreGranularListener,
  ): () => void {
    let set = this.granularListeners.get(eventType);
    if (!set) {
      set = new Set();
      this.granularListeners.set(eventType, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  syncLlmState(state: LlmStateSnapshot): void {
    this.snapshot.llm = {
      ...state,
      profiles: state.profiles.map((profile) => ({ ...profile })),
    };
    this.snapshot.session.modelProvider = state.selectedProvider;
    this.snapshot.session.model = state.selectedModel;
    this.snapshot.session.updatedAt = now();
    this.llmChanged = true;
    this.sessionChanged = true;
    this.emitChange();
  }

  beginTurn(userText: string): string {
    if (this.snapshot.turn.state !== "idle" && this.snapshot.turn.state !== "error") {
      throw new Error("A turn is already running for this session.");
    }

    const time = now();
    const turnId = buildId("turn");
    const userMessage: TranscriptMessage = {
      id: buildId("msg"),
      role: "user",
      state: "complete",
      turnId,
      createdAt: time,
      author: "user",
      content: [
        {
          id: buildId("block"),
          type: "text",
          mime: "text/plain",
          text: userText,
        },
      ],
    };

    if (this.snapshot.session.title === undefined) {
      this.snapshot.session.title = deriveTitle(userText);
    }

    const modelActivityId = buildId("activity");
    this.snapshot.transcript.push(userMessage);
    this.snapshot.activity.push({
      id: modelActivityId,
      kind: "model_call",
      status: "running",
      summary: "Running model turn",
      startedAt: time,
      updatedAt: time,
      turnId,
    });
    this.activeModelActivityId = modelActivityId;
    this.activeAssistantMessageId = null;
    this.updateTurn({
      turnId,
      state: "running",
      phase: "model",
      iteration: 1,
      startedAt: time,
      updatedAt: time,
      message: "Generating response",
      lastError: undefined,
      waitingOn: "model",
    });
    this.snapshot.session.lastError = undefined;
    this.snapshot.session.lastActivityAt = time;
    this.trimResolvedApprovals();
    this.trimResolvedTasks();
    this.turnChanged = true;
    this.transcriptChanged = true;
    this.activityChanged = true;
    this.sessionChanged = true;
    this.emitChange();
    return turnId;
  }

  appendAssistantText(turnId: string, chunk: string): void {
    if (!chunk) {
      return;
    }

    const time = now();
    let message =
      this.activeAssistantMessageId === null
        ? undefined
        : this.snapshot.transcript.find((entry) => entry.id === this.activeAssistantMessageId);

    if (!message) {
      message = {
        id: buildId("msg"),
        role: "assistant",
        state: "streaming",
        turnId,
        createdAt: time,
        author: this.snapshot.session.model,
        content: [
          {
            id: buildId("block"),
            type: "text",
            mime: "text/plain",
            text: chunk,
          },
        ],
      };
      this.snapshot.transcript.push(message);
      this.activeAssistantMessageId = message.id;
    } else {
      const [firstBlock] = message.content;
      if (!firstBlock) {
        message.content.push({
          id: buildId("block"),
          type: "text",
          mime: "text/plain",
          text: chunk,
        });
      } else if (firstBlock.type === "text") {
        firstBlock.text += chunk;
      } else {
        message.content.push({
          id: buildId("block"),
          type: "text",
          mime: "text/plain",
          text: chunk,
        });
      }
      message.state = "streaming";
      message.error = undefined;
    }

    this.updateTurnPhase("model", "Generating response", "model", time);
    this.turnChanged = true;
    this.transcriptChanged = true;
    this.emitChange();
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
    const time = now();
    let message =
      this.activeAssistantMessageId === null
        ? undefined
        : this.snapshot.transcript.find((entry) => entry.id === this.activeAssistantMessageId);

    if (!message) {
      message = {
        id: buildId("msg"),
        role: "assistant",
        state: "complete",
        turnId,
        createdAt: time,
        author: this.snapshot.session.model,
        content: [
          {
            id: buildId("block"),
            type: "media",
            mime: options.mime,
            name: options.name,
            uri: options.uri,
            summary: options.summary,
            preview: options.preview,
          },
        ],
      };
      this.snapshot.transcript.push(message);
      this.activeAssistantMessageId = message.id;
    } else {
      message.content.push({
        id: buildId("block"),
        type: "media",
        mime: options.mime,
        name: options.name,
        uri: options.uri,
        summary: options.summary,
        preview: options.preview,
      });
      message.state = "complete";
      message.error = undefined;
    }

    this.updateTurnPhase("model", "Generating response", "model", time);
    this.turnChanged = true;
    this.transcriptChanged = true;
    this.emitChange();
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
    const time = now();
    const activityId = buildId("activity");
    this.snapshot.activity.push({
      id: activityId,
      kind: "tool_call",
      status: "running",
      summary: options.summary,
      startedAt: time,
      updatedAt: time,
      turnId,
      provider: options.provider,
      path: options.path,
      action: options.action,
      toolUseId: options.toolUseId,
    });
    this.toolActivityIds.set(options.toolUseId, activityId);
    this.updateTurnPhase("tool_use", options.summary, "tool", time);
    this.activityChanged = true;
    this.turnChanged = true;
    this.emitChange();
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
    const time = now();
    const linkedActivityId = this.toolActivityIds.get(options.toolUseId);
    if (linkedActivityId) {
      this.updateActivity(linkedActivityId, {
        status: options.status,
        updatedAt: time,
        completedAt: time,
        taskId: options.taskId,
      });
    }

    this.snapshot.activity.push({
      id: buildId("activity"),
      kind: "tool_result",
      status: options.status,
      summary: options.summary,
      startedAt: time,
      updatedAt: time,
      completedAt: time,
      turnId,
      provider: options.provider,
      path: options.path,
      action: options.action,
      taskId: options.taskId,
      toolUseId: options.toolUseId,
    });

    if (options.status === "accepted" && options.provider && options.taskId) {
      const taskItemId = buildMirroredItemId("task", options.provider, options.taskId);
      const existingTask = this.snapshot.tasks.find((task) => task.id === taskItemId);
      const task: SessionTask = {
        id: taskItemId,
        status: existingTask?.status ?? "running",
        provider: options.provider,
        providerTaskId: options.taskId,
        startedAt: existingTask?.startedAt ?? time,
        updatedAt: time,
        message: existingTask?.message ?? "Waiting for provider task update",
        linkedActivityId: linkedActivityId ?? existingTask?.linkedActivityId,
        error: existingTask?.error,
        sourceTaskId: options.taskId,
        sourcePath: existingTask?.sourcePath ?? `/tasks/${options.taskId}`,
        canCancel: existingTask?.canCancel,
        turnId,
      };
      this.upsertTask(task);
    }

    this.updateTurnPhase("model", "Continuing after tool result", "model", time);
    this.activityChanged = true;
    this.tasksChanged = options.status === "accepted";
    this.turnChanged = true;
    this.emitChange();
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
    const time = now();
    const activityId = buildId("activity");
    this.snapshot.activity.push({
      id: activityId,
      kind: "approval",
      status: "running",
      summary: options.reason,
      startedAt: time,
      updatedAt: time,
      turnId,
      provider: options.provider,
      path: options.path,
      action: options.action,
      toolUseId: options.toolUseId,
    });
    this.activeApprovalActivityId = activityId;
    this.updateTurn({
      ...this.snapshot.turn,
      turnId,
      state: "waiting_approval",
      phase: "awaiting_result",
      updatedAt: time,
      message: options.reason,
      waitingOn: "approval",
    });
    this.activityChanged = true;
    this.approvalsChanged = true;
    this.turnChanged = true;
    this.emitChange();
  }

  syncProviderApprovals(providerId: string, approvals: ApprovalItem[]): void {
    const time = now();
    const currentById = new Map(
      this.snapshot.approvals
        .filter((item) => item.provider === providerId)
        .map((item) => [item.id, item] as const),
    );
    for (const approval of approvals) {
      const previous = currentById.get(approval.id);
      if (previous?.status === approval.status || approval.status === "pending") {
        continue;
      }

      this.snapshot.activity.push({
        id: buildId("activity"),
        kind: "approval",
        status:
          approval.status === "approved"
            ? "ok"
            : approval.status === "rejected"
              ? "cancelled"
              : "error",
        summary: approval.reason,
        startedAt: approval.createdAt,
        updatedAt: approval.resolvedAt ?? time,
        completedAt: approval.resolvedAt ?? time,
        turnId: approval.turnId,
        provider: approval.provider,
        path: approval.path,
        action: approval.action,
        approvalId: approval.id,
      });

      if (this.activeApprovalActivityId) {
        this.updateActivity(this.activeApprovalActivityId, {
          status:
            approval.status === "approved"
              ? "ok"
              : approval.status === "rejected"
                ? "cancelled"
                : "error",
          updatedAt: approval.resolvedAt ?? time,
          completedAt: approval.resolvedAt ?? time,
          approvalId: approval.id,
        });
        this.activeApprovalActivityId = null;
      }
    }

    this.snapshot.approvals = [
      ...this.snapshot.approvals.filter((item) => item.provider !== providerId),
      ...approvals,
    ];
    this.snapshot.session.updatedAt = time;
    this.approvalsChanged = true;
    this.emitChange();
  }

  syncApps(apps: ExternalAppSnapshot[]): void {
    this.snapshot.apps = apps.map((app) => ({ ...app })).sort(compareApps);
    this.snapshot.session.updatedAt = now();
    this.appsChanged = true;
    this.sessionChanged = true;
    this.emitChange();
  }

  cancelTurn(
    _turnId: string,
    options?: {
      message?: string;
      toolUseId?: string;
      approvalId?: string;
      approvalStatus?: "approved" | "rejected" | "expired";
    },
  ): void {
    const time = now();
    const message = options?.message ?? "Turn cancelled by user.";

    if (this.activeModelActivityId) {
      this.updateActivity(this.activeModelActivityId, {
        status: "cancelled",
        summary: message,
        updatedAt: time,
        completedAt: time,
      });
    }

    if (options?.toolUseId) {
      const toolActivityId = this.toolActivityIds.get(options.toolUseId);
      if (toolActivityId) {
        this.updateActivity(toolActivityId, {
          status: "cancelled",
          summary: message,
          updatedAt: time,
          completedAt: time,
        });
        this.toolActivityIds.delete(options.toolUseId);
      }
    }

    if (this.activeApprovalActivityId) {
      this.updateActivity(this.activeApprovalActivityId, {
        status: "cancelled",
        summary: message,
        updatedAt: time,
        completedAt: time,
        approvalId: options?.approvalId,
      });
      this.activeApprovalActivityId = null;
    }

    if (options?.approvalId && options.approvalStatus) {
      const approval = this.snapshot.approvals.find((item) => item.id === options.approvalId);
      if (approval && approval.status === "pending") {
        approval.status = options.approvalStatus;
        approval.resolvedAt = time;
        approval.canApprove = false;
        approval.canReject = false;
      }
    }

    const assistantMessage =
      this.activeAssistantMessageId === null
        ? undefined
        : this.snapshot.transcript.find((entry) => entry.id === this.activeAssistantMessageId);
    if (assistantMessage) {
      assistantMessage.state = "complete";
      assistantMessage.error = undefined;
    }

    this.activeAssistantMessageId = null;
    this.activeModelActivityId = null;
    this.snapshot.session.lastError = undefined;
    this.updateTurn({
      turnId: null,
      state: "idle",
      phase: "none",
      iteration: this.snapshot.turn.iteration,
      startedAt: null,
      updatedAt: time,
      message,
      lastError: undefined,
      waitingOn: null,
    });
    this.activityChanged = true;
    this.turnChanged = true;
    this.transcriptChanged = true;
    this.emitChange();
  }

  syncProviderTasks(providerId: string, tasks: SessionTask[]): void {
    const time = now();
    const currentById = new Map(
      this.snapshot.tasks
        .filter((item) => item.provider === providerId)
        .map((item) => [item.id, item] as const),
    );
    const mergedTasks = tasks.map((task) => {
      const previous = currentById.get(task.id);
      return {
        ...previous,
        ...task,
        linkedActivityId: task.linkedActivityId ?? previous?.linkedActivityId,
        turnId: task.turnId ?? previous?.turnId,
      } satisfies SessionTask;
    });

    this.snapshot.tasks = [
      ...this.snapshot.tasks.filter((item) => item.provider !== providerId),
      ...mergedTasks,
    ];
    this.snapshot.session.updatedAt = time;
    this.tasksChanged = true;
    this.emitChange();
  }

  clearProviderMirrors(providerId: string): void {
    const nextApprovals = this.snapshot.approvals.filter((item) => item.provider !== providerId);
    const nextTasks = this.snapshot.tasks.filter((item) => item.provider !== providerId);
    if (
      nextApprovals.length === this.snapshot.approvals.length &&
      nextTasks.length === this.snapshot.tasks.length
    ) {
      return;
    }

    this.snapshot.approvals = nextApprovals;
    this.snapshot.tasks = nextTasks;
    this.snapshot.session.updatedAt = now();
    this.approvalsChanged = true;
    this.tasksChanged = true;
    this.emitChange();
  }

  completeTurn(turnId: string, finalText: string): void {
    const time = now();
    const message = this.getOrCreateAssistantMessage(turnId, time);
    const [firstBlock] = message.content;
    if (firstBlock && firstBlock.type === "text") {
      firstBlock.text = finalText;
    }
    message.state = "complete";
    message.error = undefined;

    if (this.activeModelActivityId) {
      this.updateActivity(this.activeModelActivityId, {
        status: "ok",
        summary: "Completed model turn",
        updatedAt: time,
        completedAt: time,
      });
    }

    this.activeAssistantMessageId = null;
    this.activeModelActivityId = null;
    this.activeApprovalActivityId = null;
    this.updateTurn({
      turnId: null,
      state: "idle",
      phase: "none",
      iteration: this.snapshot.turn.iteration,
      startedAt: null,
      updatedAt: time,
      message: "Idle",
      lastError: undefined,
      waitingOn: null,
    });
    this.activityChanged = true;
    this.turnChanged = true;
    this.transcriptChanged = true;
    this.emitChange();
  }

  failTurn(turnId: string, message: string): void {
    const time = now();
    if (this.activeModelActivityId) {
      this.updateActivity(this.activeModelActivityId, {
        status: "error",
        summary: message,
        updatedAt: time,
        completedAt: time,
      });
    }

    this.snapshot.activity.push({
      id: buildId("activity"),
      kind: "error",
      status: "error",
      summary: message,
      startedAt: time,
      updatedAt: time,
      completedAt: time,
      turnId,
    });

    const assistantMessage =
      this.activeAssistantMessageId === null
        ? undefined
        : this.snapshot.transcript.find((entry) => entry.id === this.activeAssistantMessageId);
    if (assistantMessage) {
      assistantMessage.state = "error";
      assistantMessage.error = message;
    }

    this.snapshot.session.lastError = message;
    this.activeAssistantMessageId = null;
    this.activeModelActivityId = null;
    this.activeApprovalActivityId = null;
    this.updateTurn({
      turnId,
      state: "error",
      phase: "complete",
      iteration: this.snapshot.turn.iteration,
      startedAt: this.snapshot.turn.startedAt,
      updatedAt: time,
      message,
      lastError: message,
      waitingOn: null,
    });
    this.activityChanged = true;
    this.turnChanged = true;
    this.transcriptChanged = true;
    this.sessionChanged = true;
    this.emitChange();
  }

  close(): void {
    this.snapshot.session.status = "closed";
    this.snapshot.session.updatedAt = now();
    this.sessionChanged = true;
    this.emitChange();
  }

  private getOrCreateAssistantMessage(turnId: string, createdAt: string): TranscriptMessage {
    const existing =
      this.activeAssistantMessageId === null
        ? undefined
        : this.snapshot.transcript.find((entry) => entry.id === this.activeAssistantMessageId);
    if (existing) {
      return existing;
    }

    const message: TranscriptMessage = {
      id: buildId("msg"),
      role: "assistant",
      state: "streaming",
      turnId,
      createdAt,
      author: this.snapshot.session.model,
      content: [
        {
          id: buildId("block"),
          type: "text",
          mime: "text/plain",
          text: "",
        },
      ],
    };
    this.snapshot.transcript.push(message);
    this.activeAssistantMessageId = message.id;
    return message;
  }

  private upsertTask(task: SessionTask): void {
    const existingIndex = this.snapshot.tasks.findIndex((entry) => entry.id === task.id);
    if (existingIndex === -1) {
      this.snapshot.tasks.push(task);
      return;
    }

    this.snapshot.tasks[existingIndex] = {
      ...this.snapshot.tasks[existingIndex],
      ...task,
    };
  }

  private updateActivity(id: string, patch: Partial<ActivityItem>): void {
    const item = this.snapshot.activity.find((entry) => entry.id === id);
    if (!item) {
      return;
    }

    Object.assign(item, patch);
  }

  private updateTurn(next: TurnStateSnapshot): void {
    this.snapshot.turn = next;
    this.snapshot.session.updatedAt = next.updatedAt;
    this.snapshot.session.lastActivityAt = next.updatedAt;
  }

  private updateTurnPhase(
    phase: AgentTurnPhase,
    message: string,
    waitingOn: TurnStateSnapshot["waitingOn"],
    updatedAt: string,
  ): void {
    this.snapshot.turn = {
      ...this.snapshot.turn,
      state: "running",
      phase,
      message,
      waitingOn,
      updatedAt,
    };
    this.snapshot.session.updatedAt = updatedAt;
    this.snapshot.session.lastActivityAt = updatedAt;
  }

  trimResolvedApprovals(limit?: number): void {
    const maxResolved = limit ?? this.snapshot.session.maxResolvedApprovals ?? 50;
    const pending = this.snapshot.approvals.filter((item) => item.status === "pending");
    const resolved = this.snapshot.approvals
      .filter((item) => item.status !== "pending")
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    if (resolved.length <= maxResolved) {
      return;
    }
    const toKeep = resolved.slice(0, maxResolved);
    this.snapshot.approvals = [...toKeep, ...pending];
    this.approvalsChanged = true;
    this.emitChange();
  }

  trimResolvedTasks(limit?: number): void {
    const maxResolved = limit ?? this.snapshot.session.maxResolvedTasks ?? 50;
    const running = this.snapshot.tasks.filter((item) => item.status === "running");
    const resolved = this.snapshot.tasks
      .filter((item) => item.status !== "running")
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
    if (resolved.length <= maxResolved) {
      return;
    }
    const toKeep = resolved.slice(0, maxResolved);
    this.snapshot.tasks = [...toKeep, ...running];
    this.tasksChanged = true;
    this.emitChange();
  }

  private emitChange(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }

    const changedTypes: SessionStoreEventType[] = [];
    if (this.turnChanged) changedTypes.push("turn");
    if (this.transcriptChanged) changedTypes.push("transcript");
    if (this.activityChanged) changedTypes.push("activity");
    if (this.approvalsChanged) changedTypes.push("approvals");
    if (this.tasksChanged) changedTypes.push("tasks");
    if (this.appsChanged) changedTypes.push("apps");
    if (this.llmChanged) changedTypes.push("llm");
    if (this.sessionChanged) changedTypes.push("session");

    for (const eventType of changedTypes) {
      const listeners = this.granularListeners.get(eventType);
      if (listeners) {
        for (const fn of listeners) {
          fn({ type: eventType, snapshot });
        }
      }
    }

    this.turnChanged = false;
    this.transcriptChanged = false;
    this.activityChanged = false;
    this.approvalsChanged = false;
    this.tasksChanged = false;
    this.appsChanged = false;
    this.llmChanged = false;
    this.sessionChanged = false;
  }
}

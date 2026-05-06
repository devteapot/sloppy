import { join, resolve } from "node:path";

import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import { defaultConfigPromise } from "../config/load";
import { llmProviderSchema, llmReasoningEffortSchema, type SloppyConfig } from "../config/schema";
import type {
  AgentCallbacks,
  AgentRunResult,
  AgentToolEvent,
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
import type { ToolResultContentBlock } from "../llm/types";
import { isLlmAbortError } from "../llm/types";
import { createDelegationWaitTool } from "../runtime/delegation/wait-tool";
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

function runtimeConfigFingerprint(config: SloppyConfig): string {
  return JSON.stringify({
    agent: config.agent,
    maxToolResultSize: config.maxToolResultSize,
    providers: config.providers,
  });
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
  const absoluteDir = resolve(config.providers.filesystem.root, dir);
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

// Render `{oldText, newText}` / `{old_string, new_string}` pairs (single
// or arrayed under `edits`) as a unified-style diff so the TUI's diff
// colorizer (lines starting with `+` / `-`) lights up.
function renderEditDiff(params: Record<string, unknown>): string | undefined {
  const pairs = collectEditPairs(params);
  if (pairs.length === 0) return undefined;
  const blocks: string[] = [];
  pairs.forEach((pair, index) => {
    if (index > 0) blocks.push("@@");
    for (const line of pair.oldText.split(/\r?\n/)) blocks.push(`-${line}`);
    for (const line of pair.newText.split(/\r?\n/)) blocks.push(`+${line}`);
  });
  return blocks.join("\n");
}

function collectEditPairs(
  params: Record<string, unknown>,
): Array<{ oldText: string; newText: string }> {
  const pairs: Array<{ oldText: string; newText: string }> = [];
  const single = readEditPair(params);
  if (single) pairs.push(single);
  const list = params.edits;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        const pair = readEditPair(entry as Record<string, unknown>);
        if (pair) pairs.push(pair);
      }
    }
  }
  return pairs;
}

function readEditPair(
  source: Record<string, unknown>,
): { oldText: string; newText: string } | null {
  const oldText = pickString(source, ["oldText", "old_string", "old", "search"]);
  const newText = pickString(source, ["newText", "new_string", "new", "replace"]);
  if (oldText === null || newText === null) return null;
  return { oldText, newText };
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return null;
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

function buildGoalStartPrompt(objective: string): string {
  return [
    "Start working toward this persistent session goal.",
    "",
    objective,
    "",
    "Continue until the objective is genuinely complete or you are blocked. Keep the core runtime lean: use existing SLOP provider state and affordances, and prefer reusable skill updates over hardcoded runtime policy when the work discovers a repeatable procedure.",
    "Use the slop_goal_update tool to report meaningful progress, blockers, or completion with concrete evidence.",
  ].join("\n");
}

function buildGoalContinuationPrompt(goal: {
  objective: string;
  totalTokens: number;
  tokenBudget?: number;
}): string {
  const budget =
    goal.tokenBudget === undefined
      ? "No token budget is configured."
      : `Token usage so far is ${goal.totalTokens}/${goal.tokenBudget}.`;
  return [
    "Continue the active persistent session goal from the current runtime state.",
    "",
    goal.objective,
    "",
    budget,
    "Use the slop_goal_update tool to report meaningful progress, blockers, or completion with concrete evidence. If the goal is now complete, mark it complete before your concise completion summary. If work remains, take the next concrete action. If you are blocked, report the blocker.",
  ].join("\n");
}

function compactEvidence(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
    .filter((item) => item.length > 0)
    .slice(0, 12);
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
  queryProvider?(
    providerId: string,
    path: string,
    options?: {
      depth?: number;
      maxNodes?: number;
      window?: [number, number];
    },
  ): Promise<SlopNode>;
  retryProvider?(providerId: string): Promise<boolean>;
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
  private currentTurnStartedAt = 0;
  private currentTurnUsedTools = false;
  private currentTurnContinuation = false;
  private currentTurnGoalId: string | null = null;
  private readonly startedRuntimeConfigFingerprint: string;

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
    sessionPersistencePath?: string | false;
  }) {
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.startedRuntimeConfigFingerprint = runtimeConfigFingerprint(this.config);
    this.requiresLlmProfile = options?.requiresLlmProfile ?? true;
    this.externalAgentState = options?.externalAgentState;
    this.llmProfileManager =
      options?.llmProfileManager ??
      createRuntimeLlmProfileManager({
        config: this.config,
      });
    const sessionId = options?.sessionId ?? crypto.randomUUID();
    this.store =
      options?.store ??
      new SessionStore({
        sessionId,
        modelProvider: this.config.llm.provider,
        model: this.config.llm.model,
        title: options?.title,
        workspaceRoot: this.config.providers.filesystem.root,
        workspaceId: this.config.workspaces?.activeWorkspaceId,
        projectId: this.config.workspaces?.activeProjectId,
        persistencePath: resolveSessionPersistencePath(
          this.config,
          sessionId,
          options?.sessionPersistencePath,
        ),
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

        if (event.kind === "started") {
          this.currentTurnUsedTools = true;
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
            localTools: () => this.buildLocalTools(),
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

  private buildLocalTools(): LocalRuntimeTool[] {
    const tools: LocalRuntimeTool[] = [];
    if (this.config.providers.builtin.delegation) {
      tools.push(createDelegationWaitTool());
    }

    const goal = this.store.getSnapshot().goal;
    if (!goal || goal.status === "complete" || goal.goalId !== this.currentTurnGoalId) {
      return tools;
    }

    tools.push({
      providerId: "session",
      path: "/goal",
      tool: {
        type: "function",
        function: {
          name: "slop_goal_update",
          description:
            "Report progress for the active persistent session goal. Use status=progress for evidence of forward movement, status=blocked when work cannot continue, and status=complete only when the objective is genuinely achieved.",
          parameters: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["progress", "blocked", "complete"],
                description: "Goal report status.",
              },
              message: {
                type: "string",
                description: "Concise progress, blocker, or completion message.",
              },
              evidence: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional concrete evidence such as file paths changed, tests run, audit logs, or blockers observed.",
              },
            },
            required: ["status", "message"],
            additionalProperties: false,
          },
        },
      },
      execute: (params) => this.reportGoalUpdate(params, goal.goalId),
    });

    return tools;
  }

  private reportGoalUpdate(
    params: Record<string, unknown>,
    expectedGoalId: string,
  ): {
    status: "ok" | "error";
    summary: string;
    content: unknown;
    isError?: boolean;
  } {
    const goal = this.store.getSnapshot().goal;
    if (!goal || goal.goalId !== expectedGoalId || this.currentTurnGoalId !== expectedGoalId) {
      return {
        status: "error",
        summary: "Goal update no longer matches the active goal turn.",
        content: {
          status: "error",
          error: {
            code: "goal_mismatch",
            message:
              "The goal update was produced by a stale goal turn and was not applied to the current goal.",
          },
        },
        isError: true,
      };
    }

    const reportStatus = typeof params.status === "string" ? params.status : "";
    if (reportStatus !== "progress" && reportStatus !== "blocked" && reportStatus !== "complete") {
      return {
        status: "error",
        summary: "Goal update status must be progress, blocked, or complete.",
        content: {
          status: "error",
          error: {
            code: "invalid_goal_status",
            message: "Goal update status must be progress, blocked, or complete.",
          },
        },
        isError: true,
      };
    }

    const message = typeof params.message === "string" ? params.message.trim() : "";
    if (!message) {
      return {
        status: "error",
        summary: "Goal update message cannot be empty.",
        content: {
          status: "error",
          error: {
            code: "invalid_goal_message",
            message: "Goal update message cannot be empty.",
          },
        },
        isError: true,
      };
    }

    const evidence = compactEvidence(params.evidence);
    if (reportStatus === "progress") {
      this.store.updateGoalStatus("active", {
        message,
        evidence,
        source: "model",
      });
    } else if (reportStatus === "blocked") {
      this.store.updateGoalStatus("paused", {
        message: `Blocked: ${message}`,
        evidence,
        source: "model",
      });
    } else {
      this.store.updateGoalStatus("complete", {
        message,
        evidence,
        source: "model",
      });
    }

    const updated = this.store.getSnapshot().goal;
    return {
      status: "ok",
      summary: `Goal ${reportStatus}: ${message}`,
      content: {
        status: "ok",
        data: {
          goal_id: updated?.goalId,
          status: updated?.status,
          message: updated?.message,
          evidence_count: updated?.evidence?.length ?? 0,
          update_source: updated?.updateSource,
          completion_source: updated?.completionSource,
        },
      },
    };
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
    this.currentTurnContinuation = false;
    this.currentTurnGoalId = null;
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

  private startGoalTurn(
    userMessage: string,
    continuation: boolean,
    goalId = this.store.getSnapshot().goal?.goalId,
  ): { status: "started"; turnId: string } {
    const turnId = this.store.beginTurn(userMessage, {
      role: continuation ? "system" : "user",
      author: continuation ? "goal" : "user",
    });
    this.currentTurnStartedAt = Date.now();
    this.currentTurnUsedTools = false;
    this.currentTurnContinuation = continuation;
    this.currentTurnGoalId = goalId ?? null;
    this.currentTurnId = turnId;
    this.audit({
      kind: "turn_started",
      turnId,
      source: "goal",
      goalId,
      continuation,
    });
    this.activeTurnPromise = this.runTurn(turnId, userMessage);
    return { status: "started", turnId };
  }

  async createGoal(params: Record<string, unknown>): Promise<{
    status: "started" | "queued";
    goalId: string;
    turnId?: string;
    queuedMessageId?: string;
    position?: number;
  }> {
    const objective = typeof params.objective === "string" ? params.objective.trim() : "";
    if (!objective) {
      throw new Error("Goal objective cannot be empty.");
    }

    const tokenBudget =
      typeof params.token_budget === "number" && Number.isFinite(params.token_budget)
        ? Math.max(1, Math.floor(params.token_budget))
        : undefined;

    await this.start();
    if (this.requiresLlmProfile) {
      await this.refreshLlmState({ requireReady: true });
    }

    const goalId = this.store.createGoal({
      objective,
      tokenBudget,
      message: "Goal active.",
    });
    this.audit({
      kind: "goal_created",
      goalId,
      tokenBudget,
    });
    const prompt = buildGoalStartPrompt(objective);

    if (this.currentTurnId) {
      const queued = this.store.enqueueMessage(prompt, {
        author: "goal",
        goalId,
        continuation: false,
      });
      const position =
        this.store.getSnapshot().queue.findIndex((message) => message.id === queued.id) + 1;
      this.audit({
        kind: "turn_queued",
        queuedMessageId: queued.id,
        position,
        source: "goal",
        goalId,
        continuation: false,
      });
      return {
        status: "queued",
        goalId,
        queuedMessageId: queued.id,
        position,
      };
    }

    const started = this.startGoalTurn(prompt, false, goalId);
    return {
      status: "started",
      goalId,
      turnId: started.turnId,
    };
  }

  pauseGoal(message?: string): { status: string } {
    const goalId = this.store.getSnapshot().goal?.goalId;
    this.store.updateGoalStatus("paused", { message, source: "user" });
    this.audit({ kind: "goal_status", goalId, status: "paused", source: "user" });
    return { status: "paused" };
  }

  resumeGoal(message?: string): { status: string } {
    const goalId = this.store.getSnapshot().goal?.goalId;
    this.store.updateGoalStatus("active", { message, source: "user" });
    this.audit({ kind: "goal_status", goalId, status: "active", source: "user" });
    this.startNextQueuedTurn();
    return { status: "active" };
  }

  completeGoal(message?: string): { status: string } {
    const goalId = this.store.getSnapshot().goal?.goalId;
    this.store.updateGoalStatus("complete", { message, source: "user" });
    this.audit({ kind: "goal_status", goalId, status: "complete", source: "user" });
    return { status: "complete" };
  }

  clearGoal(): { status: string } {
    const goalId = this.store.getSnapshot().goal?.goalId;
    this.store.clearGoal();
    this.audit({ kind: "goal_cleared", goalId });
    return { status: "cleared" };
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

  async retryProvider(providerId: string): Promise<{ providerId: string; connected: boolean }> {
    await this.start();
    if (!this.agent.retryProvider) {
      throw new Error("Provider reconnect is not available for this session agent.");
    }
    return {
      providerId,
      connected: await this.agent.retryProvider(providerId),
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
      this.pauseActiveGoal("Goal paused after turn cancellation.");
      this.currentTurnGoalId = null;
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
    while (this.activeTurnPromise) {
      await this.activeTurnPromise;
    }
  }

  shutdown(): void {
    this.agent.shutdown();
    this.started = false;
    this.currentTurnId = null;
    this.pendingApproval = null;
    this.activeTurnPromise = null;
    this.store.close();
    this.eventBus?.stop();
    this.eventBus = null;
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

    const goalId = this.currentTurnGoalId;
    const continuation = this.currentTurnContinuation;
    this.accountGoalTurn(turnId, result);
    this.pendingApproval = null;
    this.currentTurnId = null;
    this.currentTurnGoalId = null;
    this.store.completeTurn(turnId, result.response);
    this.audit({
      kind: "turn_completed",
      turnId,
      goalId,
      continuation,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    });
    this.startNextQueuedTurn();
  }

  private failTurn(turnId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.pendingApproval = null;
    this.currentTurnId = null;
    this.store.failTurn(turnId, message);
    this.audit({ kind: "turn_failed", turnId, errorMessage: message });
    this.pauseActiveGoal(`Goal paused after turn failure: ${message}`);
    this.currentTurnGoalId = null;
    this.startNextQueuedTurn();
  }

  private handleTurnFailure(turnId: string, error: unknown): void {
    if (isLlmAbortError(error)) {
      this.pendingApproval = null;
      this.currentTurnId = null;
      this.store.cancelTurn(turnId, {
        message: "Turn cancelled by user.",
      });
      this.audit({ kind: "turn_cancelled", turnId, reason: "llm_abort" });
      this.pauseActiveGoal("Goal paused after turn cancellation.");
      this.currentTurnGoalId = null;
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
      this.startGoalContinuationTurn();
      return;
    }
    if (next.author === "goal") {
      const goal = this.store.getSnapshot().goal;
      if (goal && goal.status === "active" && goal.goalId === next.goalId) {
        this.startGoalTurn(next.text, next.continuation === true, next.goalId);
        return;
      }
      this.startNextQueuedTurn();
      return;
    }
    this.startTurn(next.text);
  }

  private startGoalContinuationTurn(): void {
    if (this.currentTurnId) {
      return;
    }
    const goal = this.store.getSnapshot().goal;
    if (!goal || goal.status !== "active") {
      return;
    }
    this.startGoalTurn(buildGoalContinuationPrompt(goal), true, goal.goalId);
  }

  private pauseActiveGoal(message: string): void {
    const goal = this.store.getSnapshot().goal;
    if (goal?.status === "active" && goal.goalId === this.currentTurnGoalId) {
      this.store.updateGoalStatus("paused", { message, source: "runtime" });
      this.audit({
        kind: "goal_status",
        goalId: goal.goalId,
        status: "paused",
        source: "runtime",
      });
    }
  }

  private accountGoalTurn(turnId: string, result: AgentRunResult): void {
    const goal = this.store.getSnapshot().goal;
    if (!goal || goal.goalId !== this.currentTurnGoalId) {
      return;
    }
    const elapsedMs = this.currentTurnStartedAt > 0 ? Date.now() - this.currentTurnStartedAt : 0;
    this.store.accountGoalTurn({
      turnId,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      elapsedMs,
      continuation: this.currentTurnContinuation,
      usedTools: this.currentTurnUsedTools,
    });
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
  }
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { action, type NodeDescriptor } from "@slop-ai/server";

import type { LocalRuntimeTool } from "../../core/agent";
import type {
  ActivePluginTurn,
  PluginRuntimeContext,
  PluginTurnCompleteEvent,
  PluginTurnFailureEvent,
  PluginTurnRequest,
  SessionRuntimePlugin,
} from "./types";

const PERSISTENT_GOAL_PLUGIN_ID = "persistent-goal";
const PERSISTENT_GOAL_SKILL_NAME = "persistent-goal";

function renderGoalSkillSection(skillContent: string): string {
  return ["", "Loaded persistent-goal skill:", "", skillContent].join("\n");
}

function buildGoalStartPrompt(objective: string, skillContent: string): string {
  return [
    "Start working toward this persistent session goal.",
    "",
    objective,
    "",
    "Continue until the objective is genuinely complete or you are blocked. Keep the core runtime lean: use existing SLOP provider state and affordances, and prefer reusable skill updates over hardcoded runtime policy when the work discovers a repeatable procedure.",
    "Use the slop_goal_update tool to report meaningful progress, blockers, or completion with concrete evidence.",
    renderGoalSkillSection(skillContent),
  ].join("\n");
}

function buildGoalContinuationPrompt(
  goal: {
    objective: string;
    totalTokens: number;
    tokenBudget?: number;
  },
  skillContent: string,
): string {
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
    renderGoalSkillSection(skillContent),
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

function goalRunMetadata(goalId: string): Record<string, unknown> {
  return { goalId };
}

function goalTurnRequest(options: {
  goalId: string;
  text: string;
  continuation: boolean;
}): PluginTurnRequest {
  return {
    pluginId: PERSISTENT_GOAL_PLUGIN_ID,
    runId: options.goalId,
    text: options.text,
    author: "goal",
    role: options.continuation ? "system" : "user",
    continuation: options.continuation,
    metadata: goalRunMetadata(options.goalId),
  };
}

function buildGoalDescriptor(
  ctx: PluginRuntimeContext,
  controls: {
    createGoal(params: Record<string, unknown>): Promise<{
      status: "started" | "queued";
      goalId: string;
      turnId?: string;
      queuedMessageId?: string;
      position?: number;
    }>;
    pauseGoal(message?: string): { status: string };
    resumeGoal(message?: string): { status: string };
    completeGoal(message?: string): { status: string };
    clearGoal(): { status: string };
  },
): NodeDescriptor {
  const goal = ctx.snapshot().goal;
  const baseActions = {
    create_goal: action(
      {
        objective: "string",
        token_budget: {
          type: "number",
          optional: true,
          description: "Optional total token budget for this goal.",
        },
      },
      async (params) => controls.createGoal(params),
      {
        label: "Create Goal",
        description:
          "Create or replace the persistent session goal and start or queue the first goal turn.",
        estimate: "instant",
      },
    ),
  };

  if (!goal) {
    return {
      type: "control",
      props: {
        exists: false,
        status: "none",
        message: "No active goal.",
      },
      summary: "Persistent session goal state.",
      actions: baseActions,
    };
  }

  return {
    type: "control",
    props: {
      exists: true,
      goal_id: goal.goalId,
      objective: goal.objective,
      status: goal.status,
      created_at: goal.createdAt,
      updated_at: goal.updatedAt,
      completed_at: goal.completedAt,
      token_budget: goal.tokenBudget,
      input_tokens: goal.inputTokens,
      output_tokens: goal.outputTokens,
      total_tokens: goal.totalTokens,
      elapsed_ms: goal.elapsedMs,
      continuation_count: goal.continuationCount,
      last_turn_id: goal.lastTurnId,
      message: goal.message,
      evidence: goal.evidence ?? [],
      update_source: goal.updateSource,
      completion_source: goal.completionSource,
    },
    summary: goal.objective,
    actions: {
      ...baseActions,
      ...(goal.status === "active"
        ? {
            pause_goal: action(
              {
                message: {
                  type: "string",
                  description: "Optional pause reason.",
                },
              },
              async ({ message }) =>
                controls.pauseGoal(typeof message === "string" ? message : undefined),
              {
                label: "Pause Goal",
                description: "Pause automatic goal continuation.",
                estimate: "instant",
              },
            ),
          }
        : {}),
      ...(goal.status === "paused" || goal.status === "budget_limited"
        ? {
            resume_goal: action(
              {
                message: {
                  type: "string",
                  description: "Optional resume note.",
                },
              },
              async ({ message }) =>
                controls.resumeGoal(typeof message === "string" ? message : undefined),
              {
                label: "Resume Goal",
                description: "Resume automatic goal continuation.",
                estimate: "instant",
              },
            ),
          }
        : {}),
      ...(goal.status !== "complete"
        ? {
            complete_goal: action(
              {
                message: {
                  type: "string",
                  description: "Optional completion note.",
                },
              },
              async ({ message }) =>
                controls.completeGoal(typeof message === "string" ? message : undefined),
              {
                label: "Complete Goal",
                description: "Mark the persistent session goal complete.",
                estimate: "instant",
              },
            ),
          }
        : {}),
      clear_goal: action(async () => controls.clearGoal(), {
        label: "Clear Goal",
        description: "Remove the persistent session goal state.",
        dangerous: true,
        estimate: "instant",
      }),
    },
  };
}

function buildGoalUpdateTool(
  ctx: PluginRuntimeContext,
  activeTurn: ActivePluginTurn,
): LocalRuntimeTool[] {
  const goal = ctx.snapshot().goal;
  const goalExtension = ctx.snapshot().extensions.goal;
  if (!goal || goal.status === "complete" || goal.goalId !== activeTurn.runId) {
    return [];
  }

  return [
    {
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
      execute: (params) => reportGoalUpdate(ctx, params, activeTurn.runId, goalExtension?.revision),
    },
  ];
}

function reportGoalUpdate(
  ctx: PluginRuntimeContext,
  params: Record<string, unknown>,
  expectedGoalId: string,
  expectedRevision: number | undefined,
): {
  status: "ok" | "error";
  summary: string;
  content: unknown;
  isError?: boolean;
} {
  const goal = ctx.snapshot().goal;
  if (!goal || goal.goalId !== expectedGoalId) {
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
  try {
    if (reportStatus === "progress") {
      ctx.store.updateGoalStatus(
        "active",
        {
          message,
          evidence,
          source: "model",
        },
        { expectedGoalId, expectedRevision },
      );
    } else if (reportStatus === "blocked") {
      ctx.store.updateGoalStatus(
        "paused",
        {
          message: `Blocked: ${message}`,
          evidence,
          source: "model",
        },
        { expectedGoalId, expectedRevision },
      );
    } else {
      ctx.store.updateGoalStatus(
        "complete",
        {
          message,
          evidence,
          source: "model",
        },
        { expectedGoalId, expectedRevision },
      );
    }
  } catch {
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

  const updated = ctx.snapshot().goal;
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

export function createPersistentGoalPlugin(): SessionRuntimePlugin {
  let goalSkillContent: string | null = null;

  async function loadSkillContent(ctx: PluginRuntimeContext): Promise<string> {
    if (goalSkillContent) {
      return goalSkillContent;
    }

    try {
      const result = await ctx.invokeProvider("skills", "/session", "skill_view", {
        name: PERSISTENT_GOAL_SKILL_NAME,
      });
      if (result.status === "ok") {
        const data = (result as { data?: unknown }).data;
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const content = (data as Record<string, unknown>).content;
          if (typeof content === "string" && content.trim().length > 0) {
            goalSkillContent = content;
            return content;
          }
        }
      }
    } catch {
      // Fall back to bundled skill below.
    }

    const builtinSkillsDir = ctx.config().providers.skills.builtinSkillsDir ?? "skills";
    const path = join(builtinSkillsDir, "runtime", PERSISTENT_GOAL_SKILL_NAME, "SKILL.md");
    try {
      const content = readFileSync(path, "utf8");
      if (content.trim().length > 0) {
        goalSkillContent = content;
        return content;
      }
    } catch {
      // handled below
    }

    throw new Error(
      "Cannot create a persistent goal because the persistent-goal skill could not be resolved.",
    );
  }

  function skillContentForContinuation(ctx: PluginRuntimeContext): string | null {
    if (goalSkillContent) {
      return goalSkillContent;
    }
    const builtinSkillsDir = ctx.config().providers.skills.builtinSkillsDir ?? "skills";
    const path = join(builtinSkillsDir, "runtime", PERSISTENT_GOAL_SKILL_NAME, "SKILL.md");
    try {
      const content = readFileSync(path, "utf8");
      if (content.trim().length > 0) {
        goalSkillContent = content;
        return content;
      }
    } catch {
      return null;
    }
    return null;
  }

  async function createGoal(
    ctx: PluginRuntimeContext,
    params: Record<string, unknown>,
  ): Promise<{
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

    await ctx.ensureReady();
    const skillContent = await loadSkillContent(ctx);
    const goalId = ctx.store.createGoal({
      objective,
      tokenBudget,
      message: "Goal active.",
    });
    ctx.audit({
      kind: "goal_created",
      goalId,
      tokenBudget,
    });

    const request = goalTurnRequest({
      goalId,
      text: buildGoalStartPrompt(objective, skillContent),
      continuation: false,
    });

    if (ctx.snapshot().turn.turnId) {
      const queued = ctx.queueTurn(request);
      ctx.audit({
        kind: "turn_queued",
        queuedMessageId: queued.queuedMessageId,
        position: queued.position,
        source: "goal",
        goalId,
        continuation: false,
      });
      return {
        status: "queued",
        goalId,
        queuedMessageId: queued.queuedMessageId,
        position: queued.position,
      };
    }

    const started = ctx.startTurn(request);
    return {
      status: "started",
      goalId,
      turnId: started.turnId,
    };
  }

  function pauseGoal(ctx: PluginRuntimeContext, message?: string): { status: string } {
    const goalId = ctx.snapshot().goal?.goalId;
    ctx.store.updateGoalStatus("paused", { message, source: "user" });
    ctx.audit({ kind: "goal_status", goalId, status: "paused", source: "user" });
    return { status: "paused" };
  }

  function resumeGoal(ctx: PluginRuntimeContext, message?: string): { status: string } {
    const goalId = ctx.snapshot().goal?.goalId;
    ctx.store.updateGoalStatus("active", { message, source: "user" });
    ctx.audit({ kind: "goal_status", goalId, status: "active", source: "user" });
    ctx.drainQueue();
    return { status: "active" };
  }

  function completeGoal(ctx: PluginRuntimeContext, message?: string): { status: string } {
    const goalId = ctx.snapshot().goal?.goalId;
    ctx.store.updateGoalStatus("complete", { message, source: "user" });
    ctx.audit({ kind: "goal_status", goalId, status: "complete", source: "user" });
    return { status: "complete" };
  }

  function clearGoal(ctx: PluginRuntimeContext): { status: string } {
    const goalId = ctx.snapshot().goal?.goalId;
    ctx.store.clearGoal();
    ctx.audit({ kind: "goal_cleared", goalId });
    return { status: "cleared" };
  }

  function pauseActiveGoal(
    ctx: PluginRuntimeContext,
    pluginTurn: ActivePluginTurn,
    message: string,
  ): void {
    const goal = ctx.snapshot().goal;
    if (goal?.status === "active" && goal.goalId === pluginTurn.runId) {
      ctx.store.updateGoalStatus("paused", { message, source: "runtime" });
      ctx.audit({
        kind: "goal_status",
        goalId: goal.goalId,
        status: "paused",
        source: "runtime",
      });
    }
  }

  return {
    id: PERSISTENT_GOAL_PLUGIN_ID,
    version: "1.0.0",
    description: "Persistent long-running session objective controls.",
    sessionNodes: () => [
      {
        path: "/goal",
        build: (nodeCtx) =>
          buildGoalDescriptor(nodeCtx, {
            createGoal: (params) => createGoal(nodeCtx, params),
            pauseGoal: (message) => pauseGoal(nodeCtx, message),
            resumeGoal: (message) => resumeGoal(nodeCtx, message),
            completeGoal: (message) => completeGoal(nodeCtx, message),
            clearGoal: () => clearGoal(nodeCtx),
          }),
      },
    ],
    localTools: (ctx, activeTurn) =>
      activeTurn?.pluginId === PERSISTENT_GOAL_PLUGIN_ID
        ? buildGoalUpdateTool(ctx, activeTurn)
        : [],
    acceptQueuedTurn: (message, ctx) => {
      const goalId = message.pluginRunId ?? message.goalId;
      if (!goalId) {
        return null;
      }
      const goal = ctx.snapshot().goal;
      if (!goal || goal.status !== "active" || goal.goalId !== goalId) {
        return null;
      }
      return goalTurnRequest({
        goalId,
        text: message.text,
        continuation: message.continuation === true,
      });
    },
    nextTurn: (ctx) => {
      const goal = ctx.snapshot().goal;
      if (!goal || goal.status !== "active") {
        return null;
      }
      const skillContent = skillContentForContinuation(ctx);
      if (!skillContent) {
        ctx.store.updateGoalStatus("paused", {
          message: "Goal paused because the persistent-goal skill could not be resolved.",
          source: "runtime",
        });
        ctx.audit({
          kind: "goal_status",
          goalId: goal.goalId,
          status: "paused",
          source: "runtime",
        });
        return null;
      }
      return goalTurnRequest({
        goalId: goal.goalId,
        text: buildGoalContinuationPrompt(goal, skillContent),
        continuation: true,
      });
    },
    onTurnComplete: (event: PluginTurnCompleteEvent, ctx) => {
      const goal = ctx.snapshot().goal;
      if (!goal || goal.goalId !== event.pluginTurn.runId) {
        return;
      }
      ctx.store.accountGoalTurn({
        turnId: event.turnId,
        inputTokens: event.result.usage?.inputTokens,
        outputTokens: event.result.usage?.outputTokens,
        elapsedMs: event.elapsedMs,
        continuation: event.pluginTurn.continuation,
        usedTools: event.usedTools,
      });
    },
    onTurnFailure: (event: PluginTurnFailureEvent, ctx) => {
      pauseActiveGoal(
        ctx,
        event.pluginTurn,
        event.cancelled
          ? "Goal paused after turn cancellation."
          : `Goal paused after turn failure: ${event.message}`,
      );
    },
    tui: {
      subscriptions: [{ path: "/goal", depth: 1 }],
      commands: [
        {
          id: "goal",
          name: "goal",
          signature: "<objective>|pause|resume|complete|clear",
          description: "Persistent session goal controls",
        },
      ],
      palette: [
        {
          id: "goal:show",
          label: "Show Goal",
          description: "Show persistent goal status",
          path: "/goal",
          action: "show",
        },
      ],
      status: [{ id: "goal", path: "/goal", renderer: "goal-status" }],
      notifications: [
        {
          id: "goal-complete",
          path: "/goal",
          prop: "status",
          to: "complete",
          message: "Goal complete.",
        },
      ],
    },
  };
}

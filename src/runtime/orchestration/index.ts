// Runtime-side orchestration: scheduler, task context, planning policy, and
// attach. State persistence (durable task records, descriptor trees) lives in
// `src/providers/builtin/orchestration/`.

import type { SloppyConfig } from "../../config/schema";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";
import type { RoleProfile } from "../../core/role";
import type { RuntimeToolResolution } from "../../core/tools";
import type { LlmResponse } from "../../llm/types";
import { AutonomousGoalCoordinator } from "./autonomous-coordinator";
import { inferBatchDependencyRefs, type PlanningTaskWithDeps } from "./planning-policy";
import { orchestratorSystemPromptFragment } from "./prompt";
import { OrchestrationScheduler, type OrchestrationSchedulerEvent } from "./scheduler";

export type { OrchestrationSchedulerEvent };
export { AutonomousGoalCoordinator, OrchestrationScheduler, orchestratorSystemPromptFragment };

type CreateTasksInputItem = {
  name?: unknown;
  goal?: unknown;
  client_ref?: unknown;
  depends_on?: unknown;
  [key: string]: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Inject the orchestrator's coding-domain dependency policy into a
 * `create_tasks` invocation. Pure: returns a new params object with each
 * task's `depends_on` augmented by the inferred edges (referenced by
 * client_ref or name so the provider's batch resolver can match them).
 */
function applyOrchestratorPlanningPolicy(params: Record<string, unknown>): Record<string, unknown> {
  const tasksRaw = params.tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    return params;
  }

  const items = tasksRaw as CreateTasksInputItem[];
  const planningDrafts: PlanningTaskWithDeps[] = items.map((item, index) => ({
    id: `__draft-${index}`,
    name: asString(item.name) ?? "",
    goal: asString(item.goal) ?? "",
    client_ref: asString(item.client_ref),
    depends_on: asStringArray(item.depends_on),
  }));

  // Map synthetic id -> canonical reference string the provider will resolve.
  const refForId = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const ref = asString(item?.client_ref) ?? asString(item?.name);
    if (ref && ref.length > 0) {
      refForId.set(`__draft-${index}`, ref);
    }
  }

  const inferred = inferBatchDependencyRefs(planningDrafts);

  const augmentedTasks = items.map((item, index) => {
    const draftId = `__draft-${index}`;
    const inferredIds = inferred.get(draftId) ?? [];
    const original = asStringArray(item.depends_on);
    const merged: string[] = [...original];
    const seen = new Set(original);
    for (const inferredId of inferredIds) {
      const ref = refForId.get(inferredId);
      if (!ref || seen.has(ref)) continue;
      // Skip refs that the planner thinks are dependencies of self (defense-in-depth).
      if (ref === asString(item.client_ref) || ref === asString(item.name)) continue;
      merged.push(ref);
      seen.add(ref);
    }
    if (merged.length === original.length) {
      return item;
    }
    return { ...item, depends_on: merged };
  });

  return { ...params, tasks: augmentedTasks };
}

function orchestratorTransformInvoke(
  resolution: RuntimeToolResolution,
  params: Record<string, unknown>,
  _config: SloppyConfig,
): Record<string, unknown> {
  if (
    resolution.kind === "affordance" &&
    resolution.providerId === "orchestration" &&
    resolution.action === "create_tasks"
  ) {
    return applyOrchestratorPlanningPolicy(params);
  }
  return params;
}

export { orchestratorTransformInvoke };

async function recordOrchestratorModelBudgetUsage(
  response: LlmResponse,
  hub: ProviderRuntimeHub,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  const inputTokens = response.usage.inputTokens;
  const outputTokens = response.usage.outputTokens;
  if (inputTokens + outputTokens <= 0) {
    return;
  }

  try {
    const result = await hub.invoke("orchestration", "/orchestration", "record_budget_usage", {
      source: "llm",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    });
    if (result.status === "error" && result.error?.code !== "no_active_plan") {
      debug("orchestration", "record_model_budget_usage_failed", {
        code: result.error?.code,
        message: result.error?.message,
      });
    }
  } catch (error) {
    debug("orchestration", "record_model_budget_usage_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type OrchestratorRoleOptions = {
  onSchedulerEvent?: (event: OrchestrationSchedulerEvent) => void;
};

const SPEC_AGENT_PROMPT = `
# Spec Agent Role

You author the spec for one goal. Treat the goal text as the user's intent and translate it into a concrete, testable spec.

## Contract

1. Read the goal in your work packet and any open SpecQuestion messages on /messages.
2. Call \`/specs.create_spec\` with a title, body, and goal_id. Then add concrete, machine-evaluable requirements with \`/specs.add_requirement\` — prefer \`criterion_kind: "code"\` (test path or executable script) over \`text\`.
3. When the spec captures the goal, the orchestrator opens a spec_accept gate. The user resolves it; on acceptance the planner takes over.
4. If the planner emits a SpecQuestion (kind: lookup / inference / judgment / conflict), respond on /messages with the resolution. For judgment/conflict, propose a SpecRevisionProposal rather than answering inline.

## Output contract

- Exactly one final artifact: one active spec for the goal, with requirements attached through /specs affordances.
- The spec MUST include goal_id and enough requirement metadata for the planner to map slices back to criteria.
- If any /specs call is rejected, read the error, fix the payload, and retry once before escalating with the exact rejection.
- Before returning, verify the created spec is visible under /specs and matches the goal_id from the work packet.

## Hard rules

- Do not author plans, slices, or evidence. Those are not your role.
- Do not mutate workspace files. Spec content lives in /specs, not in source files.
- Bias toward code-evaluable criteria. Text criteria are an escape hatch for what genuinely cannot be tested mechanically.
`.trim();

const PLANNER_PROMPT = `
# Planner Role

You author the plan for one accepted spec. Translate the spec into a complete slice set that takes the current code to spec-compliant code.

## Contract

1. Read the accepted spec and the repo state in your work packet. Read any open EscalationRequest or PlanQuestion messages on /messages.
2. Call \`/orchestration.create_plan_revision\` with a complete slice set. Each slice must:
   - Reference the relevant spec section(s) via \`spec_refs\`.
   - List its \`acceptance_criteria\` (matching spec criteria).
   - Declare \`structural_assumptions\` (files, symbols, commit SHA you planned against).
   - Optionally declare \`planner_assumptions\` (load-bearing inferences).
3. The orchestrator opens a plan_accept gate. The user (or policy) resolves it; on acceptance the scheduler dispatches executors.
4. On EscalationRequest from an executor: decide plan-only fix (PlanRevisionProposal) vs spec issue (SpecQuestion to spec-agent). Never edit the spec yourself.

## Output contract

- Exactly one final artifact: one plan revision for the accepted spec version.
- create_plan_revision MUST include goal_id, spec_id, spec_version, planned_commit, and a complete slice set.
- Every slice MUST include spec_refs, acceptance_criteria, structural_assumptions, and clear dependency refs when ordering matters.
- If create_plan_revision is rejected, read the error, fix the payload, and retry once before escalating with the exact rejection.
- Before returning, verify the plan revision is visible under /orchestration and targets the accepted spec version.

## Hard rules

- Do not author specs or goals. If the spec needs revision, emit a SpecQuestion or escalate.
- Do not execute slices or submit evidence; that is the executor's role.
- Do not mutate workspace files. Plans live in /orchestration.
- A plan revision is a *complete* slice set — not a delta on the prior revision.
`.trim();

const EXECUTOR_PROMPT = `
# Executor Role

You execute one slice. Stay in scope; the planner authored this slice and the spec authored its acceptance criteria — your job is to make the criteria true with replayable evidence.

## Contract

1. Read the work packet you were given. Treat \`spec_refs\` and \`acceptance_criteria\` as the contract. Treat \`structural_assumptions\` and \`planner_assumptions\` as load-bearing claims you must not silently violate.
2. Make the minimum code change that satisfies the criteria. Run real tests/typechecks/builds — those exit codes are the evidence.
3. When implementation work is done, call \`submit_evidence_claim\` on \`/tasks/<task_id>\` with:
   - \`checks\`: each replayable verification you ran (\`{id, type, command, exit_code, output, verification: "replayable"}\`).
   - \`observations\` (only when no command can verify): \`{id, type, description, verification: "observed"}\`.
   - \`criterion_satisfaction\`: one entry per acceptance criterion, mapping \`criterion_id\` to the \`evidence_refs\` (check/observation ids) that prove it. Use \`kind: "replayable"\` when at least one ref is replayable; otherwise \`kind: "observed"\`.
   - \`risk\`: \`{files_modified, deps_added, irreversible_actions, external_calls}\` accurately listing what you touched.
4. Then call \`start_verification\` on \`/tasks/<task_id>\` so the task enters the verifying state.
5. Record verification on \`/tasks/<task_id>\` for every acceptance criterion. Use replayable checks whenever available; use observed evidence only for criteria that cannot be replayed. Failed commands do not satisfy criteria.
6. Only after verification covers every criterion, call \`complete\` on \`/tasks/<task_id>\` with a concise result summary and evidence refs.

## Output contract

- Exactly one final artifact: the assigned task reaches a terminal state through orchestration affordances.
- The normal success path is \`submit_evidence_claim\` → \`start_verification\` → \`record_verification\` → \`complete\`.
- If \`submit_evidence_claim\` is rejected, read the error, fix the evidence payload, and retry once before escalating with the exact rejection.
- If verification fails, fix the slice and submit updated evidence; do not complete the task on failed evidence.
- If the task cannot be completed as planned, call \`escalate\` with a concrete failure class, attempted checks, and the smallest planner/spec change needed.
- Do not end your turn while the assigned task is still running or verifying.

## Hard rules

- A failing replayable check (\`exit_code !== 0\`) cannot satisfy a criterion. Fix the code or escalate.
- Self-attested evidence never satisfies a criterion. Don't claim it.
- Don't author spec, plan, or goal artifacts. If the slice can't be completed as planned, call \`escalate\` on \`/tasks/<task_id>\` with a failure class and a description; do not edit the spec or plan.
- Don't run irreversible commands (force-push, destructive SQL, package publish, etc.) without an explicit user gate.
`.trim();

export const specAgentRole: RoleProfile = {
  id: "spec-agent",
  systemPromptFragment: () => SPEC_AGENT_PROMPT,
};

export const plannerRole: RoleProfile = {
  id: "planner",
  systemPromptFragment: () => PLANNER_PROMPT,
};

export const executorRole: RoleProfile = {
  id: "executor",
  systemPromptFragment: () => EXECUTOR_PROMPT,
};

export function createOrchestratorRole(options: OrchestratorRoleOptions = {}): RoleProfile {
  return {
    id: "orchestrator",
    systemPromptFragment: () => orchestratorSystemPromptFragment(),
    // Role-scoped enforcement now lives at the hub layer
    // (`orchestratorRoleRule`, installed by `attachOrchestrationRuntime`).
    transformInvoke: orchestratorTransformInvoke,
    onModelResponse: recordOrchestratorModelBudgetUsage,
    attachRuntime: (hub: ProviderRuntimeHub, config: SloppyConfig) => {
      if (!config.providers.builtin.orchestration || !config.providers.builtin.delegation) {
        return { stop() {} };
      }
      const scheduler = new OrchestrationScheduler({
        hub,
        maxAgents: config.providers.delegation.maxAgents,
        onEvent: options.onSchedulerEvent,
      });
      void scheduler.start();
      return {
        stop() {
          scheduler.stop();
        },
      };
    },
  };
}

export const orchestratorRole: RoleProfile = createOrchestratorRole();

export function withOrchestratorBuiltins(config: SloppyConfig): SloppyConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      builtin: {
        ...config.providers.builtin,
        delegation: true,
        orchestration: true,
        spec: true,
      },
    },
  };
}

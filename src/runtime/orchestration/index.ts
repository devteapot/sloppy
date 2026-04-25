// Runtime-side orchestration: scheduler, task context, planning policy, and
// attach. State persistence (durable task records, descriptor trees) lives in
// `src/providers/builtin/orchestration/`.

import type { SloppyConfig } from "../../config/schema";
import type { ConsumerHub } from "../../core/consumer";
import type { RoleProfile } from "../../core/role";
import type { RuntimeToolResolution } from "../../core/tools";
import { inferBatchDependencyRefs, type PlanningTaskWithDeps } from "./planning-policy";
import { orchestratorSystemPromptFragment } from "./prompt";
import { OrchestrationScheduler, type OrchestrationSchedulerEvent } from "./scheduler";

export type { OrchestrationSchedulerEvent };
export { OrchestrationScheduler, orchestratorSystemPromptFragment };

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

export type OrchestratorRoleOptions = {
  onSchedulerEvent?: (event: OrchestrationSchedulerEvent) => void;
};

export function createOrchestratorRole(options: OrchestratorRoleOptions = {}): RoleProfile {
  return {
    id: "orchestrator",
    systemPromptFragment: () => orchestratorSystemPromptFragment(),
    // Role-scoped enforcement now lives at the hub layer
    // (`orchestratorRoleRule`, installed by `attachOrchestrationRuntime`).
    transformInvoke: orchestratorTransformInvoke,
    attachRuntime: (hub: ConsumerHub, config: SloppyConfig) => {
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

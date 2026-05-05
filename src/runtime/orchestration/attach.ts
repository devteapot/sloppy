import type { SloppyConfig } from "../../config/schema";
import type { ProviderRuntimeHub } from "../../core/hub";
import {
  executorRoleRule,
  orchestratorRoleRule,
  plannerRoleRule,
  specAgentRoleRule,
} from "../../core/policy/rules";
import type { RuntimeContext } from "../../core/role";
import { BUILTIN_PROVIDER_IDS } from "../../providers/builtin/ids";
import { AutonomousGoalCoordinator } from "./autonomous-coordinator";
import { createOrchestratorRole, executorRole, plannerRole, specAgentRole } from "./index";
import { createOrchestrationTaskContext } from "./task-context";

/**
 * Wires the orchestration extension into the agent runtime: registers the
 * "orchestrator" role on the role registry, and (when delegation is also
 * available) attaches a TaskContext factory so spawned sub-agents inherit
 * orchestration lifecycle behavior.
 */
export function attachOrchestrationRuntime(
  hub: ProviderRuntimeHub,
  config: SloppyConfig,
  ctx?: RuntimeContext,
): { stop(): void } {
  if (!ctx) {
    return { stop() {} };
  }

  ctx.roleRegistry.register("orchestrator", (factoryCtx) =>
    createOrchestratorRole({
      onSchedulerEvent: (event) => factoryCtx.publishEvent(event),
    }),
  );
  ctx.roleRegistry.register("spec-agent", () => specAgentRole);
  ctx.roleRegistry.register("planner", () => plannerRole);
  ctx.roleRegistry.register("executor", () => executorRole);

  // Install the role-scoped policy at the hub layer. This replaces the
  // legacy in-loop `RoleProfile.toolPolicy` enforcement; the rule activates
  // only when the run loop tags an invocation with `roleId === "orchestrator"`.
  hub.addPolicyRule(orchestratorRoleRule);
  hub.addPolicyRule(executorRoleRule);
  hub.addPolicyRule(specAgentRoleRule);
  hub.addPolicyRule(plannerRoleRule);

  ctx.delegationHooks?.setTaskContextFactory((spawn) => {
    if (spawn.roleId !== "executor" || !spawn.externalTaskId) {
      return undefined;
    }
    return createOrchestrationTaskContext({
      hub,
      providerId: BUILTIN_PROVIDER_IDS.orchestration,
      taskId: spawn.externalTaskId,
      spawnId: spawn.id,
      spawnName: spawn.name,
      spawnGoal: spawn.goal,
    });
  });

  const autonomousCoordinator =
    config.providers?.builtin?.orchestration &&
    config.providers?.builtin?.delegation &&
    config.providers?.builtin?.spec
      ? new AutonomousGoalCoordinator({
          hub,
          orchestrationProviderId: BUILTIN_PROVIDER_IDS.orchestration,
          delegationProviderId: BUILTIN_PROVIDER_IDS.delegation,
          specProviderId: BUILTIN_PROVIDER_IDS.spec,
        })
      : undefined;
  void autonomousCoordinator?.start();

  return {
    stop() {
      void autonomousCoordinator?.stop();
      ctx.roleRegistry.unregister("orchestrator");
      ctx.roleRegistry.unregister("spec-agent");
      ctx.roleRegistry.unregister("planner");
      ctx.roleRegistry.unregister("executor");
      ctx.delegationHooks?.setTaskContextFactory(null);
    },
  };
}

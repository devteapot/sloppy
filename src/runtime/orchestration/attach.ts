import type { SloppyConfig } from "../../config/schema";
import type { ConsumerHub } from "../../core/consumer";
import type { RuntimeContext } from "../../core/role";
import { createOrchestratorRole } from "./index";
import { createOrchestrationTaskContext } from "./task-context";

const ORCHESTRATION_PROVIDER_ID = "orchestration";

/**
 * Wires the orchestration extension into the agent runtime: registers the
 * "orchestrator" role on the role registry, and (when delegation is also
 * available) attaches a TaskContext factory so spawned sub-agents inherit
 * orchestration lifecycle behavior.
 */
export function attachOrchestrationRuntime(
  hub: ConsumerHub,
  _config: SloppyConfig,
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

  ctx.delegationHooks?.setTaskContextFactory((spawn) =>
    createOrchestrationTaskContext({
      hub,
      providerId: ORCHESTRATION_PROVIDER_ID,
      taskId: spawn.externalTaskId,
      spawnId: spawn.id,
      spawnName: spawn.name,
      spawnGoal: spawn.goal,
    }),
  );

  return {
    stop() {
      ctx.roleRegistry.unregister("orchestrator");
      ctx.delegationHooks?.setTaskContextFactory(null);
    },
  };
}

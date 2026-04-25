import type { SloppyConfig } from "../../config/schema";
import type { ConsumerHub } from "../../core/consumer";
import type { RoleProfile } from "../../core/role";
import { orchestratorSystemPromptFragment } from "./prompt";
import { OrchestrationScheduler, type OrchestrationSchedulerEvent } from "./scheduler";
import { orchestratorToolPolicy } from "./tool-policy";

export type { OrchestrationSchedulerEvent };
export { OrchestrationScheduler, orchestratorSystemPromptFragment, orchestratorToolPolicy };

export type OrchestratorRoleOptions = {
  onSchedulerEvent?: (event: OrchestrationSchedulerEvent) => void;
};

export function createOrchestratorRole(options: OrchestratorRoleOptions = {}): RoleProfile {
  return {
    id: "orchestrator",
    systemPromptFragment: () => orchestratorSystemPromptFragment(),
    toolPolicy: orchestratorToolPolicy,
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

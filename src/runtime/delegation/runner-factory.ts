import type { SloppyConfig } from "../../config/schema";
import type { ConsumerHub } from "../../core/consumer";
import type { DelegationProvider } from "../../providers/builtin/delegation";
import { SubAgentRunner } from "./sub-agent";

export function attachSubAgentRunnerFactory(
  delegation: DelegationProvider,
  hub: ConsumerHub,
  config: SloppyConfig,
): void {
  delegation.setParentHub(hub);
  const orchestrationProviderId = config.providers.builtin.orchestration
    ? "orchestration"
    : undefined;

  delegation.setRunnerFactory((spawn, callbacks) => {
    const runner = new SubAgentRunner({
      id: spawn.id,
      name: spawn.name,
      goal: spawn.goal,
      model: spawn.model,
      parentHub: hub,
      parentConfig: config,
      orchestrationProviderId,
      orchestrationTaskId: spawn.orchestrationTaskId,
    });
    const unsubscribe = runner.onChange((event) => {
      callbacks.onUpdate({
        status: event.status,
        result: event.resultPreview,
        error: event.error,
        session_provider_id: runner.sessionProviderId,
        completed_at: event.completedAt,
      });
      if (
        event.status === "completed" ||
        event.status === "failed" ||
        event.status === "cancelled"
      ) {
        unsubscribe();
      }
    });
    return {
      async start() {
        await runner.start();
      },
      async cancel() {
        await runner.cancel();
      },
    };
  });
}

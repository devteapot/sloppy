import type { SloppyConfig } from "../../config/schema";
import type { ProviderRuntimeHub } from "../../core/hub";
import type { DelegationRuntimeHooks, TaskContextFactory } from "../../core/role";
import type { DelegationProvider } from "../../providers/builtin/delegation";
import type { SessionAgentFactory } from "../../session/runtime";
import { AcpSessionAgent } from "../acp";
import { SubAgentRunner } from "./sub-agent";

function parseAcpExecutionMode(mode: string | undefined): string | null {
  if (!mode || mode === "native") {
    return null;
  }
  if (!mode.startsWith("acp:")) {
    throw new Error(
      `Unsupported delegation execution_mode '${mode}'. Use 'native' or 'acp:<adapterId>'.`,
    );
  }
  const adapterId = mode.slice("acp:".length).trim();
  if (!adapterId) {
    throw new Error("ACP delegation execution_mode must include an adapter id.");
  }
  return adapterId;
}

export function attachSubAgentRunnerFactory(
  delegation: DelegationProvider,
  hub: ProviderRuntimeHub,
  config: SloppyConfig,
): DelegationRuntimeHooks {
  delegation.setParentHub(hub);

  let taskContextFactory: TaskContextFactory | null = null;

  delegation.setRunnerFactory((spawn, callbacks) => {
    const executionMode = spawn.executionMode ?? "native";
    const acpAdapterId = parseAcpExecutionMode(executionMode);
    const acpConfig = config.providers.delegation.acp;
    const acpAdapter = acpAdapterId ? acpConfig?.adapters[acpAdapterId] : undefined;
    if (acpAdapterId && !acpConfig?.enabled) {
      throw new Error(
        `ACP delegation adapter '${acpAdapterId}' requested but providers.delegation.acp.enabled is false.`,
      );
    }
    if (acpAdapterId && !acpAdapter) {
      throw new Error(`ACP delegation adapter '${acpAdapterId}' is not configured.`);
    }
    const agentFactory: SessionAgentFactory | undefined =
      acpAdapterId && acpAdapter
        ? (agentCallbacks) =>
            new AcpSessionAgent({
              adapterId: acpAdapterId,
              adapter: acpAdapter,
              callbacks: agentCallbacks,
              workspaceRoot: config.providers.filesystem.root,
              defaultTimeoutMs: acpConfig?.defaultTimeoutMs,
            })
        : undefined;

    const taskContext = taskContextFactory?.({
      id: spawn.id,
      name: spawn.name,
      goal: spawn.goal,
      externalTaskId: spawn.externalTaskId,
    });
    const runner = new SubAgentRunner({
      id: spawn.id,
      name: spawn.name,
      goal: spawn.goal,
      model: spawn.model,
      parentHub: hub,
      parentConfig: config,
      agentFactory,
      requiresLlmProfile: acpAdapterId ? false : undefined,
      externalAgentState: acpAdapterId
        ? {
            provider: "acp",
            model: acpAdapterId,
            profileId: `acp-${acpAdapterId}`,
            label: `ACP ${acpAdapterId}`,
            message: `Ready to chat with ACP adapter ${acpAdapterId}.`,
          }
        : undefined,
      taskContext,
      disableBuiltinProviders: taskContext?.disableBuiltinProviders
        ? [...taskContext.disableBuiltinProviders]
        : undefined,
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

  return {
    setTaskContextFactory(factory) {
      taskContextFactory = factory;
    },
  };
}

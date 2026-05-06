import type { SloppyConfig } from "../../config/schema";
import type { ProviderRuntimeHub } from "../../core/hub";
import type { LlmProfileManager } from "../../llm/profile-manager";
import type { DelegationProvider } from "../../providers/builtin/delegation";
import type { SessionAgentFactory } from "../../session/runtime";
import { AcpSessionAgent } from "../acp";
import { CliSessionAgent } from "../cli";
import { assertAcpSpawnAllowed } from "./acp-capabilities";
import { ExecutorResolver } from "./executor-resolver";
import { SubAgentRunner } from "./sub-agent";

export function attachSubAgentRunnerFactory(
  delegation: DelegationProvider,
  hub: ProviderRuntimeHub,
  config: SloppyConfig,
  llmProfileManager?: LlmProfileManager,
): void {
  delegation.setParentHub(hub);

  const resolver = new ExecutorResolver({ config });

  delegation.setRunnerFactory((spawn, callbacks) => {
    const executor = resolver.resolve(spawn.executor);

    let agentFactory: SessionAgentFactory | undefined;
    let requiresLlmProfile: boolean | undefined;
    let externalAgentState: ConstructorParameters<typeof SubAgentRunner>[0]["externalAgentState"];
    let llmProfileId: string | undefined;
    let llmModelOverride: string | undefined;

    if (executor.kind === "acp") {
      const adapter = executor.adapter;
      const adapterId = executor.adapterId;
      const adapterTimeoutMs = executor.timeoutMs ?? executor.defaultTimeoutMs;
      assertAcpSpawnAllowed({
        adapterId,
        adapter,
        capabilityMasks: spawn.capabilityMasks,
        routeEnvelope: spawn.routeEnvelope,
      });
      agentFactory = (agentCallbacks) =>
        new AcpSessionAgent({
          adapterId,
          adapter,
          callbacks: agentCallbacks,
          workspaceRoot: config.providers.filesystem.root,
          defaultTimeoutMs: adapterTimeoutMs,
        });
      requiresLlmProfile = false;
      externalAgentState = {
        provider: "acp",
        model: adapterId,
        profileId: `acp-${adapterId}`,
        label: `ACP ${adapterId}`,
        message: `Ready to chat with ACP adapter ${adapterId}.`,
      };
    } else if (executor.kind === "cli") {
      const adapter = executor.adapter;
      const adapterId = executor.adapterId;
      const adapterTimeoutMs = executor.timeoutMs ?? executor.defaultTimeoutMs;
      agentFactory = (agentCallbacks) =>
        new CliSessionAgent({
          adapterId,
          adapter,
          callbacks: agentCallbacks,
          workspaceRoot: config.providers.filesystem.root,
          defaultTimeoutMs: adapterTimeoutMs,
        });
      requiresLlmProfile = false;
      externalAgentState = {
        provider: "cli",
        model: adapterId,
        profileId: `cli-${adapterId}`,
        label: `CLI ${adapterId}`,
        message: `Ready to chat with CLI adapter ${adapterId}.`,
      };
    } else {
      llmProfileId = executor.profileId;
      llmModelOverride = executor.modelOverride;
    }

    const runner = new SubAgentRunner({
      id: spawn.id,
      name: spawn.name,
      goal: spawn.goal,
      parentHub: hub,
      parentConfig: config,
      agentFactory,
      llmProfileManager,
      llmProfileId,
      llmModelOverride,
      requiresLlmProfile,
      externalAgentState,
      capabilityMasks: spawn.capabilityMasks,
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

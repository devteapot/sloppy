import type { SloppyConfig } from "../../config/schema";
import { capabilityMaskRule, type RuntimeCapabilityMask } from "../../core/capability-policy";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";
import type { LlmProfileManager } from "../../llm/profile-manager";
import { InProcessTransport } from "../../providers/builtin/in-process";
import type { RegisteredProvider } from "../../providers/registry";
import { AgentSessionProvider } from "../../session/provider";
import {
  type ExternalSessionAgentState,
  type SendMessageResult,
  type SessionAgentFactory,
  SessionRuntime,
} from "../../session/runtime";
import type { AgentTurnState } from "../../session/types";

export type SubAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed";

export type SubAgentEvent = {
  id: string;
  status: SubAgentStatus;
  resultPreview?: string;
  error?: string;
  completedAt?: string;
  turnState?: AgentTurnState;
  turnPhase?: string;
  sessionProviderId: string;
  sessionProviderClosed: boolean;
};

type SubAgentListener = (event: SubAgentEvent) => void;

export interface SubAgentRunnerOptions {
  id: string;
  name: string;
  goal: string;
  parentHub: ProviderRuntimeHub;
  parentConfig: SloppyConfig;
  agentFactory?: SessionAgentFactory;
  llmProfileManager?: LlmProfileManager;
  llmProfileId?: string;
  llmModelOverride?: string;
  requiresLlmProfile?: boolean;
  externalAgentState?: ExternalSessionAgentState;
  capabilityMasks?: RuntimeCapabilityMask[];
  providerIdPrefix?: string;
  /**
   * Optional list of builtin provider keys (matching `config.providers.builtin`)
   * to force-disable in the child runtime.
   */
  disableBuiltinProviders?: string[];
}

export class SubAgentRunner {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly sessionProviderId: string;

  private parentHub: ProviderRuntimeHub;
  private runtime: SessionRuntime;
  private provider: AgentSessionProvider;
  private status: SubAgentStatus = "pending";
  private listeners = new Set<SubAgentListener>();
  private unsubscribeStore: (() => void) | null = null;
  private resultText?: string;
  private errorMessage?: string;
  private completedAt?: string;
  private registered = false;
  private sawTurnInFlight = false;
  private sessionProviderClosed = false;

  constructor(options: SubAgentRunnerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.goal = options.goal;
    this.parentHub = options.parentHub;
    this.sessionProviderId = `${options.providerIdPrefix ?? "sub-agent"}-${options.id}`;

    // Sub-agents do leaf work. Strip planning-layer providers (named by the
    // caller via `disableBuiltinProviders`) when a parent wants a narrower
    // child runtime. The child runtime is constructed with the default role,
    // and the parent hub federates its session tree back via AgentSessionProvider.
    const disableSet = new Set(options.disableBuiltinProviders ?? []);
    // Leaf child runtimes should not inherit the parent's self-restructuring
    // plane unless a caller deliberately builds a custom child runtime.
    for (const key of ["delegation", "metaRuntime", "cron", "messaging"]) {
      disableSet.add(key);
    }
    const overriddenBuiltins: Record<string, boolean> = {
      ...(options.parentConfig.providers.builtin as Record<string, boolean>),
    };
    for (const key of disableSet) {
      overriddenBuiltins[key] = false;
    }
    const childConfig = {
      ...options.parentConfig,
      providers: {
        ...options.parentConfig.providers,
        builtin: overriddenBuiltins as typeof options.parentConfig.providers.builtin,
      },
    };

    this.runtime = new SessionRuntime({
      config: childConfig,
      sessionId: this.sessionProviderId,
      title: options.name,
      agentFactory: options.agentFactory,
      llmProfileManager: options.llmProfileManager,
      llmProfileId: options.llmProfileId,
      llmModelOverride: options.llmModelOverride,
      requiresLlmProfile: options.requiresLlmProfile,
      externalAgentState: options.externalAgentState,
      policyRules:
        options.capabilityMasks && options.capabilityMasks.length > 0
          ? [capabilityMaskRule(options.capabilityMasks)]
          : undefined,
      parentActorId: "parent",
    });

    this.provider = new AgentSessionProvider(this.runtime, {
      providerId: this.sessionProviderId,
      providerName: `Sub-agent: ${options.name}`,
    });
  }

  onChange(listener: SubAgentListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): SubAgentEvent {
    const turn = this.runtime.store.getSnapshot().turn;
    return {
      id: this.id,
      status: this.status,
      resultPreview: this.resultText,
      error: this.errorMessage,
      completedAt: this.completedAt,
      turnState: turn.state,
      turnPhase: turn.phase,
      sessionProviderId: this.sessionProviderId,
      sessionProviderClosed: this.sessionProviderClosed,
    };
  }

  async start(): Promise<void> {
    const registered: RegisteredProvider = {
      id: this.sessionProviderId,
      name: `Sub-agent: ${this.name}`,
      kind: "builtin",
      transport: new InProcessTransport(this.provider.server),
      transportLabel: "in-process",
      stop: () => this.provider.stop(),
    };

    this.unsubscribeStore = this.runtime.store.onChange(() => {
      this.syncFromStore();
    });

    try {
      await this.runtime.start();
      const added = await this.parentHub.addProvider(registered);
      this.registered = added;

      debug("sub-agent", "start", {
        id: this.id,
        name: this.name,
        sessionProviderId: this.sessionProviderId,
        registered: added,
      });

      this.transition("running");
      await this.runtime.sendMessage(this.goal);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.completedAt = new Date().toISOString();
      this.sessionProviderClosed = true;
      this.transition("failed");
      this.teardown();
    }
  }

  async cancel(): Promise<void> {
    if (
      this.status === "completed" ||
      this.status === "failed" ||
      this.status === "cancelled" ||
      this.status === "closed"
    ) {
      return;
    }

    try {
      await this.runtime.cancelTurn();
    } catch {
      // best-effort: runtime may not have an active turn
    }

    this.completedAt = new Date().toISOString();
    this.sessionProviderClosed = true;
    this.transition("cancelled");
    this.teardown();
  }

  async sendMessage(text: string): Promise<SendMessageResult> {
    if (this.status === "failed" || this.status === "cancelled" || this.status === "closed") {
      throw new Error(`Cannot send a follow-up to agent ${this.id} in status ${this.status}.`);
    }
    if (this.sessionProviderClosed) {
      throw new Error(`Cannot send a follow-up to closed agent session ${this.id}.`);
    }

    const result = await this.runtime.sendMessage(text);
    this.syncFromStore();
    return result;
  }

  getResult(): string | undefined {
    return this.resultText;
  }

  async close(): Promise<void> {
    if (this.status === "closed") {
      return;
    }

    if (this.status === "pending" || this.status === "running") {
      try {
        await this.runtime.cancelTurn();
      } catch {
        // best-effort: the child may already be between turns
      }
    }

    this.completedAt ??= new Date().toISOString();
    this.sessionProviderClosed = true;
    this.transition("closed");
    this.teardown();
  }

  shutdown(): void {
    this.teardown();
  }

  private teardown(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;

    if (this.registered) {
      this.parentHub.removeProvider(this.sessionProviderId);
      this.registered = false;
    }
    this.sessionProviderClosed = true;

    try {
      this.runtime.shutdown();
    } catch {
      // ignore shutdown errors
    }
  }

  private syncFromStore(): void {
    if (this.status === "cancelled" || this.status === "failed" || this.status === "closed") {
      return;
    }

    const snapshot = this.runtime.store.getSnapshot();
    const turnState = snapshot.turn.state;

    if (turnState === "running" || turnState === "waiting_approval") {
      this.sawTurnInFlight = true;
      if (this.status === "pending" || this.status === "completed") {
        this.transition("running");
      }
      return;
    }

    debug("sub-agent", "sync_from_store", {
      id: this.id,
      turnState,
      sawTurnInFlight: this.sawTurnInFlight,
      status: this.status,
    });

    if (turnState === "error") {
      this.errorMessage = snapshot.turn.lastError ?? "Sub-agent turn failed.";
      this.completedAt = new Date().toISOString();
      this.sessionProviderClosed = true;
      this.transition("failed");
      this.teardown();
      return;
    }

    if (
      turnState === "idle" &&
      this.sawTurnInFlight &&
      (this.status === "running" || this.status === "pending" || this.status === "completed")
    ) {
      const transcript = snapshot.transcript;
      const lastAssistant = [...transcript]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant) {
        const text = lastAssistant.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
        this.resultText = text.length > 0 ? text : undefined;
      }

      this.completedAt = new Date().toISOString();
      this.sawTurnInFlight = false;
      this.transition("completed");
    }
  }

  private transition(next: SubAgentStatus): void {
    if (this.status === next) {
      return;
    }
    const from = this.status;
    this.status = next;
    debug("sub-agent", "transition", { id: this.id, from, to: next });
    const event = this.snapshot();
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

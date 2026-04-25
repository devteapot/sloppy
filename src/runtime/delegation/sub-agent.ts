import type { SloppyConfig } from "../../config/schema";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";
import type { TaskContext } from "../../core/role";
import type { LlmProfileManager } from "../../llm/profile-manager";
import { InProcessTransport } from "../../providers/builtin/in-process";
import type { RegisteredProvider } from "../../providers/registry";
import { AgentSessionProvider } from "../../session/provider";
import {
  type ExternalSessionAgentState,
  type SessionAgentFactory,
  SessionRuntime,
} from "../../session/runtime";

export type SubAgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type SubAgentEvent = {
  id: string;
  status: SubAgentStatus;
  resultPreview?: string;
  error?: string;
  completedAt?: string;
};

type SubAgentListener = (event: SubAgentEvent) => void;

export interface SubAgentRunnerOptions {
  id: string;
  name: string;
  goal: string;
  model?: string;
  parentHub: ProviderRuntimeHub;
  parentConfig: SloppyConfig;
  agentFactory?: SessionAgentFactory;
  llmProfileManager?: LlmProfileManager;
  requiresLlmProfile?: boolean;
  externalAgentState?: ExternalSessionAgentState;
  providerIdPrefix?: string;
  taskContext?: TaskContext;
  /**
   * Optional list of builtin provider keys (matching `config.providers.builtin`)
   * to force-disable in the child runtime. Lets callers strip planning-layer
   * planning-layer providers so sub-agents can't recurse, without the
   * kernel naming any specific planner.
   */
  disableBuiltinProviders?: string[];
}

export class SubAgentRunner {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly model?: string;
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
  private taskContext?: TaskContext;
  private sawTurnInFlight = false;

  constructor(options: SubAgentRunnerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.goal = options.goal;
    this.model = options.model;
    this.parentHub = options.parentHub;
    this.taskContext = options.taskContext;
    this.sessionProviderId = `${options.providerIdPrefix ?? "sub-agent"}-${options.id}`;

    // Sub-agents do leaf work. Strip planning-layer providers (named by the
    // caller via `disableBuiltinProviders`) so they can't re-enter planning
    // mode and recurse. The child runtime is constructed with the default
    // role, so any role-level system prompt and tool policy do not apply.
    // The parent hub still federates the child's session tree back via
    // AgentSessionProvider.
    const disableSet = new Set(options.disableBuiltinProviders ?? []);
    // The delegation provider is always disabled to prevent recursive spawning.
    disableSet.add("delegation");
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
      requiresLlmProfile: options.requiresLlmProfile,
      externalAgentState: options.externalAgentState,
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
    return {
      id: this.id,
      status: this.status,
      resultPreview: this.resultText,
      error: this.errorMessage,
      completedAt: this.completedAt,
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

      if (this.taskContext) {
        await this.taskContext.ensureTask();
        // Record the task-level start BEFORE kicking off the turn so that a
        // fast-completing child doesn't race ahead of the lifecycle gate.
        await this.taskContext.recordTransition("start");
      }
      this.transition("running");
      const prompt = this.taskContext
        ? await this.taskContext.buildInitialPrompt(this.goal)
        : this.goal;
      await this.runtime.sendMessage(prompt);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.completedAt = new Date().toISOString();
      if (this.taskContext) {
        await this.taskContext.recordFailure(this.errorMessage);
      }
      this.transition("failed");
    }
  }

  async cancel(): Promise<void> {
    if (this.status === "completed" || this.status === "failed" || this.status === "cancelled") {
      return;
    }

    try {
      await this.runtime.cancelTurn();
    } catch {
      // best-effort: runtime may not have an active turn
    }

    this.completedAt = new Date().toISOString();
    if (this.taskContext) {
      await this.taskContext.recordTransition("cancel");
    }
    this.transition("cancelled");
    this.teardown();
  }

  getResult(): string | undefined {
    return this.resultText;
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

    try {
      this.runtime.shutdown();
    } catch {
      // ignore shutdown errors
    }
  }

  private syncFromStore(): void {
    if (this.status === "cancelled" || this.status === "failed" || this.status === "completed") {
      return;
    }

    const snapshot = this.runtime.store.getSnapshot();
    const turnState = snapshot.turn.state;

    if (turnState === "running" || turnState === "waiting_approval") {
      this.sawTurnInFlight = true;
      if (this.status === "pending") {
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
      if (this.taskContext) {
        void this.taskContext.recordFailure(this.errorMessage);
      }
      this.transition("failed");
      this.teardown();
      return;
    }

    if (
      turnState === "idle" &&
      this.sawTurnInFlight &&
      (this.status === "running" || this.status === "pending")
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
      if (this.taskContext) {
        void this.taskContext.recordCompletion(this.resultText);
      }
      this.transition("completed");
      this.teardown();
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

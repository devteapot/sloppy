import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import { InProcessTransport } from "../providers/builtin/in-process";
import type { RegisteredProvider } from "../providers/registry";
import { AgentSessionProvider } from "../session/provider";
import { type SessionAgentFactory, SessionRuntime } from "../session/runtime";
import type { ConsumerHub } from "./consumer";
import { debug } from "./debug";

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
  parentHub: ConsumerHub;
  parentConfig: SloppyConfig;
  agentFactory?: SessionAgentFactory;
  llmProfileManager?: LlmProfileManager;
  providerIdPrefix?: string;
  orchestrationProviderId?: string;
  orchestrationTaskId?: string;
}

export class SubAgentRunner {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly model?: string;
  readonly sessionProviderId: string;

  private parentHub: ConsumerHub;
  private runtime: SessionRuntime;
  private provider: AgentSessionProvider;
  private status: SubAgentStatus = "pending";
  private listeners = new Set<SubAgentListener>();
  private unsubscribeStore: (() => void) | null = null;
  private resultText?: string;
  private errorMessage?: string;
  private completedAt?: string;
  private registered = false;
  private orchestrationProviderId?: string;
  private orchestrationTaskId?: string;
  private sawTurnInFlight = false;

  constructor(options: SubAgentRunnerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.goal = options.goal;
    this.model = options.model;
    this.parentHub = options.parentHub;
    this.orchestrationProviderId = options.orchestrationProviderId;
    this.orchestrationTaskId = options.orchestrationTaskId;
    this.sessionProviderId = `${options.providerIdPrefix ?? "sub-agent"}-${options.id}`;

    // Sub-agents do leaf work. Strip orchestrator-mode and the orchestration/
    // delegation providers so they can't re-enter planning mode and recurse.
    // The parent hub still federates the child's session tree back to the
    // orchestrator via AgentSessionProvider.
    const childConfig = {
      ...options.parentConfig,
      agent: { ...options.parentConfig.agent, orchestratorMode: false },
      providers: {
        ...options.parentConfig.providers,
        builtin: {
          ...options.parentConfig.providers.builtin,
          orchestration: false,
          delegation: false,
        },
      },
    };

    this.runtime = new SessionRuntime({
      config: childConfig,
      sessionId: this.sessionProviderId,
      title: options.name,
      agentFactory: options.agentFactory,
      llmProfileManager: options.llmProfileManager,
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

    const added = await this.parentHub.addProvider(registered);
    this.registered = added;

    debug("sub-agent", "start", {
      id: this.id,
      name: this.name,
      sessionProviderId: this.sessionProviderId,
      registered: added,
    });

    await this.createOrchestrationTask();

    this.unsubscribeStore = this.runtime.store.onChange(() => {
      this.syncFromStore();
    });

    try {
      await this.runtime.start();
      // Record the orchestration-level start BEFORE kicking off the turn so
      // that a fast-completing child doesn't race ahead of the task-level
      // `start` affordance (which gates `complete`).
      await this.recordTaskTransition("start");
      this.transition("running");
      await this.runtime.sendMessage(this.goal);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.completedAt = new Date().toISOString();
      await this.recordTaskFailure(this.errorMessage);
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
    await this.recordTaskTransition("cancel");
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
      void this.recordTaskFailure(this.errorMessage);
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
      // If the child produced no text, skip writing result.md so get_result returns null
      // rather than an empty string indistinguishable from a failed write.
      if (this.resultText) {
        void this.recordTaskCompletion(this.resultText);
      } else {
        void this.recordTaskCompletion(null);
      }
      this.transition("completed");
      this.teardown();
    }
  }

  private async createOrchestrationTask(): Promise<void> {
    if (!this.orchestrationProviderId) return;
    if (this.orchestrationTaskId) {
      // Orchestrator pre-created the task via /orchestration.create_task and
      // handed us the id; attach to it instead of duplicating.
      debug("sub-agent", "orchestration_task_attached", {
        id: this.id,
        orchestrationTaskId: this.orchestrationTaskId,
      });
      return;
    }
    try {
      const result = await this.parentHub.invoke(
        this.orchestrationProviderId,
        "/orchestration",
        "create_task",
        { name: this.name, goal: this.goal },
      );
      if (result.status === "ok") {
        const data = result.data as { id?: string };
        if (data?.id) {
          this.orchestrationTaskId = data.id;
          debug("sub-agent", "orchestration_task_created", {
            id: this.id,
            orchestrationTaskId: data.id,
          });
        }
      } else {
        debug("sub-agent", "orchestration_task_create_failed", {
          id: this.id,
          status: result.status,
        });
      }
    } catch (error) {
      debug("sub-agent", "orchestration_task_create_error", {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordTaskTransition(action: "start" | "cancel"): Promise<void> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) return;
    try {
      await this.parentHub.invoke(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        action,
        {},
      );
    } catch (error) {
      debug("sub-agent", "record_task_transition_error", {
        id: this.id,
        action,
        taskId: this.orchestrationTaskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordTaskCompletion(resultText: string | null): Promise<void> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) return;
    try {
      await this.parentHub.invoke(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        "complete",
        { result: resultText ?? "" },
      );
    } catch (error) {
      debug("sub-agent", "record_task_completion_error", {
        id: this.id,
        taskId: this.orchestrationTaskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordTaskFailure(error: string): Promise<void> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) return;
    try {
      await this.parentHub.invoke(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        "fail",
        { error },
      );
    } catch (err) {
      debug("sub-agent", "record_task_failure_error", {
        id: this.id,
        taskId: this.orchestrationTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
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

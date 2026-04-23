import type { SloppyConfig } from "../config/schema";
import { InProcessTransport } from "../providers/builtin/in-process";
import type { RegisteredProvider } from "../providers/registry";
import { AgentSessionProvider } from "../session/provider";
import { type SessionAgentFactory, SessionRuntime } from "../session/runtime";
import type { ConsumerHub } from "./consumer";

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
  providerIdPrefix?: string;
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

  constructor(options: SubAgentRunnerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.goal = options.goal;
    this.model = options.model;
    this.parentHub = options.parentHub;
    this.sessionProviderId = `${options.providerIdPrefix ?? "sub-agent"}-${options.id}`;

    this.runtime = new SessionRuntime({
      config: options.parentConfig,
      sessionId: this.sessionProviderId,
      title: options.name,
      agentFactory: options.agentFactory,
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

    this.unsubscribeStore = this.runtime.store.onChange(() => {
      this.syncFromStore();
    });

    try {
      await this.runtime.start();
      await this.runtime.sendMessage(this.goal);
      this.transition("running");
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.completedAt = new Date().toISOString();
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
      if (this.status === "pending") {
        this.transition("running");
      }
      return;
    }

    if (turnState === "error") {
      this.errorMessage = snapshot.turn.lastError ?? "Sub-agent turn failed.";
      this.completedAt = new Date().toISOString();
      this.transition("failed");
      this.teardown();
      return;
    }

    if (turnState === "idle" && (this.status === "running" || this.status === "pending")) {
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
      this.transition("completed");
      this.teardown();
    }
  }

  private transition(next: SubAgentStatus): void {
    if (this.status === next) {
      return;
    }
    this.status = next;
    const event = this.snapshot();
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

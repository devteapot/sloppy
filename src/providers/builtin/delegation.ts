import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type DelegationAgentSpawn = {
  id: string;
  name: string;
  goal: string;
  model?: string;
};

export type DelegationAgentUpdate = {
  status: AgentStatus;
  result?: string;
  error?: string;
  session_provider_id?: string;
  completed_at?: string;
};

export interface DelegationRunner {
  start(): Promise<void>;
  cancel(): Promise<void>;
}

export type DelegationRunnerFactory = (
  spawn: DelegationAgentSpawn,
  callbacks: {
    onUpdate: (update: DelegationAgentUpdate) => void;
  },
) => DelegationRunner;

type DelegationAgent = {
  id: string;
  name: string;
  goal: string;
  status: AgentStatus;
  model?: string;
  result?: string;
  error?: string;
  session_provider_id?: string;
  created_at: string;
  completed_at?: string;
  runner?: DelegationRunner;
};

function buildAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

function resultPreview(result: string, maxChars = 200): string {
  if (result.length <= maxChars) {
    return result;
  }
  return `${result.slice(0, maxChars - 16)}\n...[truncated]`;
}

function createSimulatedRunner(
  spawn: DelegationAgentSpawn,
  callbacks: { onUpdate: (update: DelegationAgentUpdate) => void },
): DelegationRunner {
  let cancelled = false;
  let runningTimeout: ReturnType<typeof setTimeout> | null = null;
  let completeTimeout: ReturnType<typeof setTimeout> | null = null;

  return {
    async start() {
      runningTimeout = setTimeout(() => {
        if (cancelled) return;
        callbacks.onUpdate({ status: "running" });
        completeTimeout = setTimeout(() => {
          if (cancelled) return;
          callbacks.onUpdate({
            status: "completed",
            result: `Agent "${spawn.name}" completed goal: ${spawn.goal}`,
            completed_at: new Date().toISOString(),
          });
        }, 3000);
      }, 500);
    },
    async cancel() {
      cancelled = true;
      if (runningTimeout) clearTimeout(runningTimeout);
      if (completeTimeout) clearTimeout(completeTimeout);
    },
  };
}

export class DelegationProvider {
  readonly server: SlopServer;
  private maxAgents: number;
  private agents = new Map<string, DelegationAgent>();
  private runnerFactory: DelegationRunnerFactory;

  constructor(
    options: {
      maxAgents?: number;
      runnerFactory?: DelegationRunnerFactory;
    } = {},
  ) {
    this.maxAgents = options.maxAgents ?? 10;
    this.runnerFactory = options.runnerFactory ?? createSimulatedRunner;

    this.server = createSlopServer({
      id: "delegation",
      name: "Delegation",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("agents", () => this.buildAgentsDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  setRunnerFactory(factory: DelegationRunnerFactory): void {
    this.runnerFactory = factory;
  }

  private spawnAgent(
    name: string,
    goal: string,
    model?: string,
  ): { id: string; status: AgentStatus; created_at: string; session_provider_id?: string } {
    const active = [...this.agents.values()].filter(
      (a) => a.status === "pending" || a.status === "running",
    ).length;

    if (active >= this.maxAgents) {
      throw new Error(`Agent limit reached (max ${this.maxAgents} concurrent agents).`);
    }

    const id = buildAgentId();
    const created_at = new Date().toISOString();
    const agent: DelegationAgent = { id, name, goal, status: "pending", model, created_at };
    this.agents.set(id, agent);

    const runner = this.runnerFactory(
      { id, name, goal, model },
      {
        onUpdate: (update) => {
          const current = this.agents.get(id);
          if (!current || current.status === "cancelled") {
            return;
          }
          if (update.status) current.status = update.status;
          if (update.result !== undefined) current.result = update.result;
          if (update.error !== undefined) current.error = update.error;
          if (update.session_provider_id !== undefined) {
            current.session_provider_id = update.session_provider_id;
          }
          if (update.completed_at !== undefined) current.completed_at = update.completed_at;
          this.server.refresh();
        },
      },
    );
    agent.runner = runner;
    this.server.refresh();

    void runner.start().catch((error) => {
      const current = this.agents.get(id);
      if (!current || current.status === "cancelled") {
        return;
      }
      current.status = "failed";
      current.error = error instanceof Error ? error.message : String(error);
      current.completed_at = new Date().toISOString();
      this.server.refresh();
    });

    return {
      id,
      status: agent.status,
      created_at,
      session_provider_id: agent.session_provider_id,
    };
  }

  private monitor(agentId: string): DelegationAgent {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return { ...agent };
  }

  private cancel(agentId: string): { cancelled: boolean } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.status === "completed" || agent.status === "failed") {
      throw new Error(`Agent ${agentId} has already ${agent.status} and cannot be cancelled.`);
    }

    agent.status = "cancelled";
    agent.completed_at = new Date().toISOString();
    this.server.refresh();
    void agent.runner?.cancel().catch(() => {
      // best-effort teardown
    });
    return { cancelled: true };
  }

  private getResult(agentId: string): { id: string; result: string } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.status !== "completed") {
      throw new Error(`Agent ${agentId} has not completed yet (status: ${agent.status}).`);
    }
    if (!agent.result) {
      throw new Error(`Agent ${agentId} completed but has no result.`);
    }
    return { id: agentId, result: agent.result };
  }

  private listAgents(): DelegationAgent[] {
    return [...this.agents.values()];
  }

  private buildSessionDescriptor() {
    const all = this.listAgents();
    const active = all.filter((a) => a.status === "pending" || a.status === "running").length;
    const completed = all.filter((a) => a.status === "completed").length;
    const failed = all.filter((a) => a.status === "failed" || a.status === "cancelled").length;

    return {
      type: "context",
      props: {
        total_agents: all.length,
        active_agents: active,
        completed_agents: completed,
        failed_agents: failed,
        max_agents: this.maxAgents,
      },
      summary: "Delegation session: subagent spawning and lifecycle management.",
      actions: {
        spawn_agent: action(
          {
            name: {
              type: "string",
              description: "Short human-readable name for this agent.",
            },
            goal: {
              type: "string",
              description: "The task or objective the agent should accomplish.",
            },
            model: {
              type: "string",
              description: "Optional model identifier to run the agent with.",
            },
          },
          async ({ name, goal, model }) => this.spawnAgent(name, goal, model),
          {
            label: "Spawn Agent",
            description: "Create and launch a new subagent to accomplish a delegated goal.",
            estimate: "fast",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
  }

  private buildAgentsDescriptor() {
    const items: ItemDescriptor[] = [...this.agents.values()].map((agent) => ({
      id: agent.id,
      props: {
        id: agent.id,
        name: agent.name,
        goal: agent.goal,
        status: agent.status,
        model: agent.model,
        created_at: agent.created_at,
        completed_at: agent.completed_at,
        result_preview: agent.result ? resultPreview(agent.result) : undefined,
        error: agent.error,
        session_provider_id: agent.session_provider_id,
      },
      actions: {
        monitor: action(async () => this.monitor(agent.id), {
          label: "Monitor Agent",
          description:
            "Return the full current state of this agent, including result if completed.",
          idempotent: true,
          estimate: "instant",
        }),
        get_result: action(async () => this.getResult(agent.id), {
          label: "Get Result",
          description: "Return the full result text for a completed agent.",
          idempotent: true,
          estimate: "instant",
        }),
        ...(agent.status === "pending" || agent.status === "running"
          ? {
              cancel: action(async () => this.cancel(agent.id), {
                label: "Cancel Agent",
                description: "Abort this agent before it completes.",
                dangerous: true,
                estimate: "instant",
              }),
            }
          : {}),
      },
      meta: {
        salience:
          agent.status === "running"
            ? 0.9
            : agent.status === "failed" || agent.status === "cancelled"
              ? 0.8
              : agent.status === "pending"
                ? 0.7
                : 0.4,
        urgency:
          agent.status === "failed"
            ? "high"
            : agent.status === "running" || agent.status === "pending"
              ? "medium"
              : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "All delegation agents and their current lifecycle state.",
      items,
    };
  }
}

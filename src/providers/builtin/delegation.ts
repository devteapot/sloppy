import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type DelegationAgent = {
  id: string;
  name: string;
  goal: string;
  status: AgentStatus;
  model?: string;
  result?: string;
  error?: string;
  created_at: string;
  completed_at?: string;
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

export class DelegationProvider {
  readonly server: SlopServer;
  private maxAgents: number;
  private agents = new Map<string, DelegationAgent>();

  constructor(options: { maxAgents?: number } = {}) {
    this.maxAgents = options.maxAgents ?? 10;

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

  private spawnAgent(name: string, goal: string, model?: string): { id: string; status: AgentStatus; created_at: string } {
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
    this.server.refresh();

    // Simulate execution: pending → running → completed
    setTimeout(() => {
      const a = this.agents.get(id);
      if (!a || a.status === "cancelled") {
        return;
      }
      a.status = "running";
      this.server.refresh();

      setTimeout(() => {
        const a = this.agents.get(id);
        if (!a || a.status === "cancelled") {
          return;
        }
        a.status = "completed";
        a.result = `Agent "${name}" completed goal: ${goal}`;
        a.completed_at = new Date().toISOString();
        this.server.refresh();
      }, 3000);
    }, 500);

    return { id, status: agent.status, created_at };
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
      },
      actions: {
        monitor: action(
          async () => this.monitor(agent.id),
          {
            label: "Monitor Agent",
            description: "Return the full current state of this agent, including result if completed.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        get_result: action(
          async () => this.getResult(agent.id),
          {
            label: "Get Result",
            description: "Return the full result text for a completed agent.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        ...(agent.status === "pending" || agent.status === "running"
          ? {
              cancel: action(
                async () => this.cancel(agent.id),
                {
                  label: "Cancel Agent",
                  description: "Abort this agent before it completes.",
                  dangerous: true,
                  estimate: "instant",
                },
              ),
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

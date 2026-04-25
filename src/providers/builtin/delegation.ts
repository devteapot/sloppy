import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { ConsumerHub } from "../../core/consumer";
import { debug } from "../../core/debug";

type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type DelegationAgentSpawn = {
  id: string;
  name: string;
  goal: string;
  model?: string;
  /**
   * Opaque external task id supplied by whoever requested the spawn (e.g. an
   * orchestrator). The delegation provider passes it through unchanged; only
   * extensions that recognize it (via a TaskContext factory) interpret it.
   */
  externalTaskId?: string;
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
  externalTaskId?: string;
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

export type ChildApprovalSnapshot = {
  id: string;
  status?: string;
  summary?: string;
  action?: string;
  path?: string;
};

export class DelegationProvider {
  readonly server: SlopServer;
  private maxAgents: number;
  private agents = new Map<string, DelegationAgent>();
  private runnerFactory: DelegationRunnerFactory;
  private parentHub: ConsumerHub | null = null;
  private approvalMirrors = new Map<
    string,
    { unsubscribe: () => void; providerId: string; pending: ChildApprovalSnapshot[] }
  >();

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
    for (const agentId of [...this.approvalMirrors.keys()]) {
      this.stopMirroringApprovals(agentId);
    }
    this.server.stop();
  }

  setParentHub(hub: ConsumerHub): void {
    this.parentHub = hub;
  }

  private async mirrorChildApprovals(agentId: string, providerId: string): Promise<void> {
    if (!this.parentHub) return;
    this.stopMirroringApprovals(agentId);

    try {
      const unsubscribe = await this.parentHub.watchPath(
        providerId,
        "/approvals",
        (tree) => {
          const pending: ChildApprovalSnapshot[] = [];
          for (const child of tree?.children ?? []) {
            const props = (child.properties ?? {}) as Record<string, unknown>;
            if (props.status !== undefined && props.status !== "pending") continue;
            pending.push({
              id: String(child.id ?? ""),
              status: typeof props.status === "string" ? props.status : undefined,
              summary: typeof props.summary === "string" ? props.summary : undefined,
              action: typeof props.action === "string" ? props.action : undefined,
              path: typeof props.path === "string" ? props.path : undefined,
            });
          }
          const entry = this.approvalMirrors.get(agentId);
          if (entry) {
            entry.pending = pending;
          } else {
            this.approvalMirrors.set(agentId, {
              unsubscribe: () => undefined,
              providerId,
              pending,
            });
          }
          this.server.refresh();
        },
        { depth: 2 },
      );
      const existing = this.approvalMirrors.get(agentId);
      this.approvalMirrors.set(agentId, {
        unsubscribe,
        providerId,
        pending: existing?.pending ?? [],
      });
      debug("delegation", "mirror_approvals_start", { agentId, providerId });
    } catch (error) {
      debug("delegation", "mirror_approvals_error", {
        agentId,
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopMirroringApprovals(agentId: string): void {
    const entry = this.approvalMirrors.get(agentId);
    if (!entry) return;
    try {
      entry.unsubscribe();
    } catch {
      // ignore
    }
    this.approvalMirrors.delete(agentId);
    debug("delegation", "mirror_approvals_stop", { agentId });
  }

  private async listChildApprovals(agentId: string): Promise<{
    agent_id: string;
    approvals: Array<{
      id: string;
      status?: string;
      summary?: string;
      action?: string;
      path?: string;
    }>;
  }> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (!agent.session_provider_id) {
      return { agent_id: agentId, approvals: [] };
    }
    if (!this.parentHub) {
      throw new Error("Delegation provider has no parent hub reference.");
    }

    const tree = await this.parentHub.queryState({
      providerId: agent.session_provider_id,
      path: "/approvals",
      depth: 2,
    });
    const approvals =
      tree.children?.map((child) => {
        const props = (child.properties ?? {}) as Record<string, unknown>;
        return {
          id: String(child.id ?? ""),
          status: typeof props.status === "string" ? props.status : undefined,
          summary: typeof props.summary === "string" ? props.summary : undefined,
          action: typeof props.action === "string" ? props.action : undefined,
          path: typeof props.path === "string" ? props.path : undefined,
        };
      }) ?? [];
    return { agent_id: agentId, approvals };
  }

  private async forwardApproval(
    agentId: string,
    approvalId: string,
    action: "approve" | "reject",
    params?: Record<string, unknown>,
  ): Promise<{ agent_id: string; approval_id: string; action: string; status: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (!agent.session_provider_id) {
      throw new Error(`Agent ${agentId} has no session provider registered.`);
    }
    if (!this.parentHub) {
      throw new Error("Delegation provider has no parent hub reference.");
    }

    const result = await this.parentHub.invoke(
      agent.session_provider_id,
      `/approvals/${approvalId}`,
      action,
      params,
    );
    if (result.status === "error") {
      throw new Error(result.error?.message ?? `Failed to ${action} approval ${approvalId}.`);
    }
    return { agent_id: agentId, approval_id: approvalId, action, status: result.status };
  }

  setRunnerFactory(factory: DelegationRunnerFactory): void {
    this.runnerFactory = factory;
  }

  private spawnAgent(
    name: string,
    goal: string,
    model?: string,
    externalTaskId?: string,
  ): { id: string; status: AgentStatus; created_at: string; session_provider_id?: string } {
    const active = [...this.agents.values()].filter(
      (a) => a.status === "pending" || a.status === "running",
    ).length;

    if (active >= this.maxAgents) {
      throw new Error(`Agent limit reached (max ${this.maxAgents} concurrent agents).`);
    }

    const id = buildAgentId();
    const created_at = new Date().toISOString();
    const agent: DelegationAgent = {
      id,
      name,
      goal,
      status: "pending",
      model,
      externalTaskId,
      created_at,
    };
    this.agents.set(id, agent);
    debug("delegation", "spawn_agent", {
      id,
      name,
      goal_preview: goal.slice(0, 80),
      model,
    });

    const runner = this.runnerFactory(
      { id, name, goal, model, externalTaskId },
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
            void this.mirrorChildApprovals(id, update.session_provider_id);
          }
          if (update.completed_at !== undefined) current.completed_at = update.completed_at;
          if (
            update.status === "completed" ||
            update.status === "failed" ||
            update.status === "cancelled"
          ) {
            this.stopMirroringApprovals(id);
          }
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
    this.stopMirroringApprovals(agentId);
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
            task_id: {
              type: "string",
              description:
                "Optional orchestration task id (e.g. task-abcd1234) to attach to. If set, the sub-agent updates that task's lifecycle instead of creating a new one. Use this to execute a task you already planned via /orchestration.create_task.",
            },
          },
          async ({ name, goal, model, task_id }) =>
            this.spawnAgent(
              name as string,
              goal as string,
              typeof model === "string" ? model : undefined,
              typeof task_id === "string" ? task_id : undefined,
            ),
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
        orchestration_task_id: agent.externalTaskId,
        created_at: agent.created_at,
        completed_at: agent.completed_at,
        result_preview: agent.result ? resultPreview(agent.result) : undefined,
        error: agent.error,
        session_provider_id: agent.session_provider_id,
        pending_approvals: this.approvalMirrors.get(agent.id)?.pending ?? [],
      },
      actions: {
        ...(agent.status === "completed" && !agent.externalTaskId
          ? {
              get_result: action(async () => this.getResult(agent.id), {
                label: "Get Result",
                description:
                  "Return the full result text for a completed agent. This affordance appears only after completion; use pushed agent state while it is running.",
                idempotent: true,
                estimate: "instant",
              }),
            }
          : {}),
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
        ...(agent.session_provider_id
          ? {
              list_approvals: action(async () => this.listChildApprovals(agent.id), {
                label: "List Child Approvals",
                description:
                  "Return the pending approvals currently exposed by this sub-agent's session provider.",
                idempotent: true,
                estimate: "fast",
              }),
              approve_child_approval: action(
                { approval_id: "string" },
                async ({ approval_id }) =>
                  this.forwardApproval(agent.id, approval_id as string, "approve"),
                {
                  label: "Approve Child Approval",
                  description:
                    "Forward an approve decision to a pending approval inside this sub-agent.",
                  dangerous: true,
                  estimate: "fast",
                },
              ),
              reject_child_approval: action(
                {
                  approval_id: "string",
                  reason: {
                    type: "string",
                    description: "Optional rejection explanation forwarded to the child.",
                  },
                },
                async ({ approval_id, reason }) =>
                  this.forwardApproval(agent.id, approval_id as string, "reject", {
                    reason: typeof reason === "string" ? reason : undefined,
                  }),
                {
                  label: "Reject Child Approval",
                  description:
                    "Forward a reject decision to a pending approval inside this sub-agent.",
                  dangerous: true,
                  estimate: "fast",
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

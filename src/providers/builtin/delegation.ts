import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";
import type { RuntimeCapabilityMask } from "../../core/capability-policy";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";
import {
  type ExecutorBinding,
  executorBindingSchema,
} from "../../runtime/delegation/executor-binding";
import { ProviderApprovalManager } from "../approvals";
import { parseOptionalRouteEnvelope, type RouteMessageEnvelope } from "./message-envelope";

type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "closed";

export type DelegationAgentSpawn = {
  id: string;
  name: string;
  goal: string;
  executor?: ExecutorBinding;
  capabilityMasks?: RuntimeCapabilityMask[];
  routeEnvelope?: RouteMessageEnvelope;
};

export type DelegationAgentUpdate = {
  status: AgentStatus;
  result?: string;
  error?: string;
  session_provider_id?: string;
  session_provider_closed?: boolean;
  turn_state?: string;
  turn_phase?: string;
  completed_at?: string;
};

export interface DelegationRunner {
  start(): Promise<void>;
  cancel(): Promise<void>;
  sendMessage?(text: string): Promise<unknown>;
  close?(): Promise<void>;
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
  executor?: ExecutorBinding;
  capabilityMasks?: RuntimeCapabilityMask[];
  routeEnvelope?: RouteMessageEnvelope;
  result?: string;
  error?: string;
  session_provider_id?: string;
  session_provider_closed?: boolean;
  turn_state?: string;
  turn_phase?: string;
  created_at: string;
  completed_at?: string;
  runner?: DelegationRunner;
};

function describeExecutorModel(executor: ExecutorBinding | undefined): string | undefined {
  if (!executor) return undefined;
  if (executor.kind === "llm") return executor.modelOverride ?? executor.profileId;
  return executor.modelOverride ?? executor.adapterId;
}

function describeExecutionMode(executor: ExecutorBinding | undefined): string {
  if (!executor) return "native";
  if (executor.kind === "acp") return `acp:${executor.adapterId}`;
  return "native";
}

function buildAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

function resultPreview(result: string, maxChars = 200): string {
  if (result.length <= maxChars) {
    return result;
  }
  return `${result.slice(0, maxChars - 16)}\n...[truncated]`;
}

function createUnconfiguredRunner(
  _spawn: DelegationAgentSpawn,
  _callbacks: { onUpdate: (update: DelegationAgentUpdate) => void },
): DelegationRunner {
  throw new Error(
    "No delegation runner factory is configured. Attach the runtime runner factory before spawning delegated agents.",
  );
}

export type ChildApprovalSnapshot = {
  id: string;
  status?: string;
  summary?: string;
  action?: string;
  path?: string;
  created_at?: string;
  resolved_at?: string;
  params_preview?: string;
  dangerous?: boolean;
};

export class DelegationProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private maxAgents: number;
  private agents = new Map<string, DelegationAgent>();
  private runnerFactory: DelegationRunnerFactory;
  private parentHub: ProviderRuntimeHub | null = null;
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
    this.runnerFactory = options.runnerFactory ?? createUnconfiguredRunner;

    this.server = createSlopServer({
      id: "delegation",
      name: "Delegation",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("agents", () => this.buildAgentsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    for (const agentId of [...this.approvalMirrors.keys()]) {
      this.stopMirroringApprovals(agentId);
    }
    for (const agent of this.agents.values()) {
      if (agent.runner?.close) {
        void agent.runner.close().catch(() => undefined);
      } else if (agent.status === "pending" || agent.status === "running") {
        void agent.runner?.cancel().catch(() => undefined);
      }
    }
    this.server.stop();
  }

  setParentHub(hub: ProviderRuntimeHub): void {
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
            const reason =
              typeof props.reason === "string"
                ? props.reason
                : typeof child.meta?.summary === "string"
                  ? child.meta.summary
                  : undefined;
            pending.push({
              id: String(child.id ?? ""),
              status: typeof props.status === "string" ? props.status : undefined,
              summary: reason,
              action: typeof props.action === "string" ? props.action : undefined,
              path: typeof props.path === "string" ? props.path : undefined,
              created_at: typeof props.created_at === "string" ? props.created_at : undefined,
              resolved_at: typeof props.resolved_at === "string" ? props.resolved_at : undefined,
              params_preview:
                typeof props.params_preview === "string" ? props.params_preview : undefined,
              dangerous: typeof props.dangerous === "boolean" ? props.dangerous : undefined,
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
      created_at?: string;
      resolved_at?: string;
      params_preview?: string;
      dangerous?: boolean;
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
        const reason =
          typeof props.reason === "string"
            ? props.reason
            : typeof child.meta?.summary === "string"
              ? child.meta.summary
              : undefined;
        return {
          id: String(child.id ?? ""),
          status: typeof props.status === "string" ? props.status : undefined,
          summary: reason,
          action: typeof props.action === "string" ? props.action : undefined,
          path: typeof props.path === "string" ? props.path : undefined,
          created_at: typeof props.created_at === "string" ? props.created_at : undefined,
          resolved_at: typeof props.resolved_at === "string" ? props.resolved_at : undefined,
          params_preview:
            typeof props.params_preview === "string" ? props.params_preview : undefined,
          dangerous: typeof props.dangerous === "boolean" ? props.dangerous : undefined,
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
    executor?: ExecutorBinding,
    capabilityMasks?: RuntimeCapabilityMask[],
    routeEnvelope?: RouteMessageEnvelope,
  ): {
    id: string;
    status: AgentStatus;
    created_at: string;
    execution_mode: string;
    session_provider_id?: string;
  } {
    const active = [...this.agents.values()].filter(
      (a) => a.status === "pending" || a.status === "running",
    ).length;

    if (active >= this.maxAgents) {
      throw new Error(`Agent limit reached (max ${this.maxAgents} concurrent agents).`);
    }

    const id = buildAgentId();
    const created_at = new Date().toISOString();
    debug("delegation", "spawn_agent", {
      id,
      name,
      goal_preview: goal.slice(0, 80),
      executor,
    });

    const runner = this.runnerFactory(
      { id, name, goal, executor, capabilityMasks, routeEnvelope },
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
          if (update.session_provider_closed !== undefined) {
            current.session_provider_closed = update.session_provider_closed;
          }
          if (update.turn_state !== undefined) current.turn_state = update.turn_state;
          if (update.turn_phase !== undefined) current.turn_phase = update.turn_phase;
          if (update.completed_at !== undefined) current.completed_at = update.completed_at;
          if (
            update.status === "failed" ||
            update.status === "cancelled" ||
            update.status === "closed"
          ) {
            this.stopMirroringApprovals(id);
          }
          this.server.refresh();
        },
      },
    );
    const agent: DelegationAgent = {
      id,
      name,
      goal,
      status: "pending",
      executor,
      capabilityMasks,
      routeEnvelope,
      created_at,
      runner,
    };
    this.agents.set(id, agent);
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
      execution_mode: describeExecutionMode(agent.executor),
      session_provider_id: agent.session_provider_id,
    };
  }

  private cancel(agentId: string): { cancelled: boolean } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "closed") {
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

  private async sendMessage(
    agentId: string,
    text: string,
  ): Promise<{ agent_id: string; status: string; result: unknown }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.status === "failed" || agent.status === "cancelled" || agent.status === "closed") {
      throw new Error(`Cannot send a follow-up to agent ${agentId} in status ${agent.status}.`);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Message text cannot be empty.");
    }

    let result: unknown;
    if (agent.runner?.sendMessage) {
      result = await agent.runner.sendMessage(trimmed);
    } else {
      if (!agent.session_provider_id || agent.session_provider_closed) {
        throw new Error(`Agent ${agentId} has no open session provider for follow-up.`);
      }
      if (!this.parentHub) {
        throw new Error("Delegation provider has no parent hub reference.");
      }
      const invokeResult = await this.parentHub.invoke(
        agent.session_provider_id,
        "/composer",
        "send_message",
        { text: trimmed },
      );
      if (invokeResult.status === "error") {
        throw new Error(
          invokeResult.error?.message ?? `Failed to send follow-up to agent ${agentId}.`,
        );
      }
      result = invokeResult.data;
    }

    return { agent_id: agentId, status: "sent", result };
  }

  private getResult(agentId: string): { id: string; result: string } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (!agent.result) {
      throw new Error(`Agent ${agentId} has no result yet (status: ${agent.status}).`);
    }
    return { id: agentId, result: agent.result };
  }

  private async close(agentId: string): Promise<{ id: string; status: AgentStatus }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.status === "closed") {
      return { id: agentId, status: "closed" };
    }

    await agent.runner?.close?.();
    if (!agent.runner?.close) {
      if (agent.status === "pending" || agent.status === "running") {
        void agent.runner?.cancel().catch(() => undefined);
      }
      this.stopMirroringApprovals(agentId);
    }

    agent.status = "closed";
    agent.session_provider_closed = true;
    agent.completed_at ??= new Date().toISOString();
    this.server.refresh();
    return { id: agentId, status: "closed" };
  }

  private listAgents(): DelegationAgent[] {
    return [...this.agents.values()];
  }

  private buildSessionDescriptor() {
    const all = this.listAgents();
    const active = all.filter((a) => a.status === "pending" || a.status === "running").length;
    const completed = all.filter(
      (a) => a.status === "completed" || (a.status === "closed" && Boolean(a.result)),
    ).length;
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
            task_id: {
              type: "string",
              description:
                "Deprecated compatibility field. Delegation no longer attaches sub-agents to runtime-owned task records.",
              optional: true,
            },
            executor: {
              type: "object",
              description:
                "Optional executor binding selecting which engine runs this agent. Omit for the session default. Shape: { kind: 'llm', profileId, modelOverride? } to bind to a configured LLM profile, or { kind: 'acp', adapterId, modelOverride?, timeoutMs? } to delegate to a configured ACP adapter.",
              optional: true,
              properties: {
                kind: { type: "string", enum: ["llm", "acp"] },
                profileId: { type: "string", optional: true },
                modelOverride: { type: "string", optional: true },
                adapterId: { type: "string", optional: true },
                timeoutMs: { type: "number", optional: true },
              },
            },
            capabilityMasks: {
              type: "array",
              description:
                "Optional capability masks enforced by child agent hub policy. Shape: [{ id, provider?, path?, actions?, mode: 'allow'|'deny' }].",
              items: { type: "object", additionalProperties: true },
              optional: true,
            },
            routeEnvelope: {
              type: "object",
              description: "Optional typed route envelope that caused this delegated agent spawn.",
              optional: true,
            },
          },
          async ({ name, goal, executor, capabilityMasks, routeEnvelope }) =>
            this.spawnAgent(
              name as string,
              goal as string,
              executor === undefined || executor === null
                ? undefined
                : executorBindingSchema.parse(executor),
              Array.isArray(capabilityMasks)
                ? (capabilityMasks as RuntimeCapabilityMask[])
                : undefined,
              parseOptionalRouteEnvelope(routeEnvelope, {
                fallbackSource: "agent",
                fallbackBody: goal as string,
              }),
            ),
          {
            label: "Spawn Agent",
            description:
              "Create and launch a child session in the background. Continue independent work, then use slop_wait_for_delegation_event to join on child turn edges instead of polling /agents.",
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
        model: describeExecutorModel(agent.executor),
        execution_mode: describeExecutionMode(agent.executor),
        executor: agent.executor,
        capability_masks: agent.capabilityMasks,
        route_envelope: agent.routeEnvelope,
        created_at: agent.created_at,
        completed_at: agent.completed_at,
        result_preview: agent.result ? resultPreview(agent.result) : undefined,
        error: agent.error,
        session_provider_id: agent.session_provider_id,
        session_provider_closed: agent.session_provider_closed === true,
        turn_state: agent.turn_state,
        turn_phase: agent.turn_phase,
        pending_approvals: this.approvalMirrors.get(agent.id)?.pending ?? [],
      },
      actions: {
        ...(agent.result
          ? {
              get_result: action(async () => this.getResult(agent.id), {
                label: "Get Result",
                description: "Return the full latest result text for this child conversation.",
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
        ...(agent.session_provider_id && agent.session_provider_closed !== true
          ? {
              send_message: action(
                {
                  text: {
                    type: "string",
                    description:
                      "Follow-up message to send to this child session. Starts immediately when idle or queues behind an active child turn.",
                  },
                },
                async ({ text }) => this.sendMessage(agent.id, text as string),
                {
                  label: "Send Message",
                  description:
                    "Send a follow-up message into this child session without closing it.",
                  estimate: "instant",
                },
              ),
              ...(agent.status === "completed"
                ? {
                    close: action(async () => this.close(agent.id), {
                      label: "Close Agent",
                      description:
                        "Close this completed child session provider while keeping its summarized result in delegation state.",
                      estimate: "instant",
                    }),
                  }
                : {}),
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
                    optional: true,
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

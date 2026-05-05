import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { ProviderRuntimeHub } from "../../core/hub";
import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";
import type {
  AgentChannel,
  AgentNode,
  AgentProfile,
  CapabilityMask,
  ExecutorBinding,
  MetaEvent,
  MetaScope,
  MetaStateMaps,
  PersistedState,
  Proposal,
  RouteDispatchResult,
  RouteRule,
  SchedulerPolicy,
  SkillVersion,
  TopologyChange,
} from "./meta-runtime-model";
import {
  clearStateMaps,
  cloneMergedState,
  createStateMaps,
  listById,
  listByName,
  putById,
  putState,
  snapshotStateMaps,
} from "./meta-runtime-model";
import {
  asScope,
  asString,
  classifyApproval,
  optionalNonNegativeInteger,
  parseChange,
} from "./meta-runtime-ops";

export type {
  AgentChannel,
  AgentNode,
  AgentProfile,
  CapabilityMask,
  ExecutorBinding,
  RouteRule,
  SchedulerPolicy,
  SkillVersion,
  TopologyChange,
} from "./meta-runtime-model";

function now(): string {
  return new Date().toISOString();
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function readState(root: string): PersistedState {
  const path = join(root, "state.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedState;
  } catch (error) {
    throw new Error(
      `Could not read meta-runtime state at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class MetaRuntimeProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private hub: ProviderRuntimeHub | null = null;
  private globalRoot: string;
  private workspaceRoot: string;
  private layers: Record<MetaScope, MetaStateMaps> = {
    global: createStateMaps(),
    workspace: createStateMaps(),
    session: createStateMaps(),
  };
  private profiles = new Map<string, AgentProfile>();
  private agents = new Map<string, AgentNode>();
  private channels = new Map<string, AgentChannel>();
  private routes = new Map<string, RouteRule>();
  private capabilities = new Map<string, CapabilityMask>();
  private executorBindings = new Map<string, ExecutorBinding>();
  private schedulerPolicies = new Map<string, SchedulerPolicy>();
  private skillVersions = new Map<string, SkillVersion>();
  private proposals = new Map<string, Proposal>();
  private events: MetaEvent[] = [];

  constructor(options: { globalRoot?: string; workspaceRoot?: string } = {}) {
    this.globalRoot = resolve(expandHome(options.globalRoot ?? "~/.sloppy/meta-runtime"));
    this.workspaceRoot = resolve(expandHome(options.workspaceRoot ?? ".sloppy/meta-runtime"));

    this.server = createSlopServer({
      id: "meta-runtime",
      name: "Meta Runtime",
    });
    this.approvals = new ProviderApprovalManager(this.server);
    this.load();

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("agents", () => this.collection("agents", listById(this.agents)));
    this.server.register("profiles", () => this.collection("profiles", listByName(this.profiles)));
    this.server.register("channels", () => this.collection("channels", listById(this.channels)));
    this.server.register("routes", () => this.collection("routes", listById(this.routes)));
    this.server.register("capabilities", () =>
      this.collection("capabilities", listById(this.capabilities)),
    );
    this.server.register("executor-bindings", () =>
      this.collection("executor-bindings", listById(this.executorBindings)),
    );
    this.server.register("scheduler-policies", () =>
      this.collection("scheduler-policies", listById(this.schedulerPolicies)),
    );
    this.server.register("skill-versions", () =>
      this.collection("skill-versions", listById(this.skillVersions)),
    );
    this.server.register("proposals", () => this.buildProposalsDescriptor());
    this.server.register("events", () => this.collection("events", this.events));
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  setHub(hub: ProviderRuntimeHub | null): void {
    this.hub = hub;
  }

  private load(): void {
    const global = readState(this.globalRoot);
    const workspace = readState(this.workspaceRoot);
    putState(this.layers.global, global);
    putState(this.layers.workspace, workspace);
    putById(this.proposals, global.proposals);
    putById(this.proposals, workspace.proposals);
    this.events.push(...(global.events ?? []), ...(workspace.events ?? []));
    this.events = this.events.slice(-200);
    this.rebuildMergedState();
  }

  private persist(scope: MetaScope): void {
    if (scope === "session") return;
    const root = scope === "global" ? this.globalRoot : this.workspaceRoot;
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "state.json"),
      `${JSON.stringify(this.snapshotForScope(scope), null, 2)}\n`,
      "utf8",
    );
  }

  private rebuildMergedState(): void {
    this.profiles.clear();
    this.agents.clear();
    this.channels.clear();
    this.routes.clear();
    this.capabilities.clear();
    this.executorBindings.clear();
    this.schedulerPolicies.clear();
    this.skillVersions.clear();

    for (const scope of ["global", "workspace", "session"] as const) {
      putState(this.mergedMaps(), snapshotStateMaps(this.layers[scope]));
    }
  }

  private mergedMaps(): MetaStateMaps {
    return {
      profiles: this.profiles,
      agents: this.agents,
      channels: this.channels,
      routes: this.routes,
      capabilities: this.capabilities,
      executorBindings: this.executorBindings,
      schedulerPolicies: this.schedulerPolicies,
      skillVersions: this.skillVersions,
    };
  }

  private snapshotForScope(scope: Exclude<MetaScope, "session">): PersistedState {
    return {
      ...snapshotStateMaps(this.layers[scope]),
      proposals: listById(this.proposals).filter((proposal) => proposal.scope === scope),
      events: this.events.filter((event) => event.scope === scope).slice(-200),
    };
  }

  private snapshotMergedState(): PersistedState {
    return {
      profiles: listByName(this.profiles),
      agents: listById(this.agents),
      channels: listById(this.channels),
      routes: listById(this.routes),
      capabilities: listById(this.capabilities),
      executorBindings: listById(this.executorBindings),
      schedulerPolicies: listById(this.schedulerPolicies),
      skillVersions: listById(this.skillVersions),
      proposals: listById(this.proposals),
      events: this.events.slice(-200),
    };
  }

  private exportState(scope?: MetaScope): PersistedState & { scope: MetaScope | "merged" } {
    if (scope === "global") {
      return { scope, ...readState(this.globalRoot) };
    }
    if (scope === "workspace") {
      return { scope, ...readState(this.workspaceRoot) };
    }
    return { scope: "merged", ...this.snapshotMergedState() };
  }

  private importState(
    scope: MetaScope,
    state: PersistedState,
    mode: "merge" | "replace",
    approved = false,
  ): { scope: MetaScope; mode: "merge" | "replace"; imported: true } {
    if (scope !== "session" && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "import_state",
        reason: `Importing ${scope} meta-runtime state overwrites persisted runtime topology.`,
        paramsPreview: JSON.stringify({
          scope,
          mode,
          profiles: state.profiles?.length ?? 0,
          agents: state.agents?.length ?? 0,
          routes: state.routes?.length ?? 0,
        }),
        dangerous: true,
        execute: () => this.importState(scope, state, mode, true),
      });
      throw createApprovalRequiredError(
        `Importing ${scope} meta-runtime state requires approval via /approvals/${approvalId}.`,
      );
    }

    if (mode === "replace") {
      clearStateMaps(this.layers[scope]);
      for (const proposal of [...this.proposals.values()]) {
        if (proposal.scope === scope) {
          this.proposals.delete(proposal.id);
        }
      }
      this.events = this.events.filter((event) => event.scope !== scope);
    }
    putState(this.layers[scope], state);
    putById(this.proposals, state.proposals);
    this.events.push(...(state.events ?? []));
    this.recordEvent({
      kind: "state.imported",
      scope,
      summary: `Imported ${scope} meta-runtime state with ${mode} mode.`,
    });
    this.rebuildMergedState();
    this.persist(scope);
    this.server.refresh();
    return { scope, mode, imported: true };
  }

  private recordEvent(event: Omit<MetaEvent, "id" | "createdAt">): void {
    this.events.push({
      id: `event-${crypto.randomUUID()}`,
      createdAt: now(),
      ...event,
    });
    this.events = this.events.slice(-200);
  }

  private proposeChange(params: Record<string, unknown>): Proposal {
    const scope = asScope(params.scope);
    const rawOps = params.ops;
    if (!Array.isArray(rawOps) || rawOps.length === 0) {
      throw new Error("ops must be a non-empty array of topology changes.");
    }
    const ops = rawOps.map(parseChange);
    const proposal: Proposal = {
      id: `proposal-${crypto.randomUUID()}`,
      scope,
      summary: asString(params.summary, "summary"),
      rationale: typeof params.rationale === "string" ? params.rationale : undefined,
      status: "proposed",
      requiresApproval: classifyApproval(scope, ops),
      createdAt: now(),
      ttlMs: optionalNonNegativeInteger(params.ttl_ms, "ttl_ms"),
      ops,
    };
    this.proposals.set(proposal.id, proposal);
    this.recordEvent({
      kind: "proposal.created",
      scope,
      proposalId: proposal.id,
      summary: proposal.summary,
    });
    this.persist(scope);
    this.server.refresh();
    return proposal;
  }

  private applyProposal(id: string, approved = false): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error(`Unknown proposal: ${id}`);
    }
    if (proposal.status !== "proposed") {
      throw new Error(`Proposal ${id} is already ${proposal.status}.`);
    }
    if (
      proposal.ttlMs !== undefined &&
      Date.now() - Date.parse(proposal.createdAt) > proposal.ttlMs
    ) {
      proposal.status = "expired";
      proposal.revertedAt = now();
      this.recordEvent({
        kind: "proposal.expired",
        scope: proposal.scope,
        proposalId: proposal.id,
        summary: proposal.summary,
      });
      this.persist(proposal.scope);
      this.server.refresh();
      throw new Error(`Proposal ${id} expired before it could be applied.`);
    }
    if (proposal.requiresApproval && !approved) {
      const approvalId = this.approvals.request({
        path: `/proposals/${id}`,
        action: "apply_proposal",
        reason: `Applying proposal ${id} changes persisted or privileged meta-runtime state.`,
        paramsPreview: JSON.stringify({
          scope: proposal.scope,
          ops: proposal.ops.map((op) => op.type),
        }),
        dangerous: true,
        execute: () => this.applyProposal(id, true),
      });
      throw createApprovalRequiredError(
        `Applying proposal ${id} requires approval via /approvals/${approvalId}.`,
      );
    }

    this.validateOps(proposal.ops);
    for (const op of proposal.ops) {
      this.applyOp(proposal.scope, op);
    }
    this.rebuildMergedState();
    proposal.status = "applied";
    proposal.appliedAt = now();
    this.recordEvent({
      kind: "proposal.applied",
      scope: proposal.scope,
      proposalId: proposal.id,
      summary: proposal.summary,
    });
    this.persist(proposal.scope);
    this.server.refresh();
    return proposal;
  }

  private revertProposal(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error(`Unknown proposal: ${id}`);
    }
    proposal.status = "reverted";
    proposal.revertedAt = now();
    this.recordEvent({
      kind: "proposal.reverted",
      scope: proposal.scope,
      proposalId: proposal.id,
      summary: proposal.summary,
    });
    this.persist(proposal.scope);
    this.server.refresh();
    return proposal;
  }

  private validateOps(ops: TopologyChange[]): void {
    const simulated = cloneMergedState(this.mergedMaps());

    for (const op of ops) {
      switch (op.type) {
        case "upsertAgentProfile":
          simulated.profiles.set(op.profile.id, op.profile);
          break;
        case "spawnAgent":
          if (!simulated.profiles.has(op.agent.profileId)) {
            throw new Error(
              `Agent ${op.agent.id} references unknown profile ${op.agent.profileId}.`,
            );
          }
          if (
            op.agent.executorBindingId &&
            !simulated.executorBindings.has(op.agent.executorBindingId)
          ) {
            throw new Error(
              `Agent ${op.agent.id} references unknown executor binding ${op.agent.executorBindingId}.`,
            );
          }
          for (const maskId of op.agent.capabilityMaskIds) {
            if (!simulated.capabilities.has(maskId)) {
              throw new Error(`Agent ${op.agent.id} references unknown capability mask ${maskId}.`);
            }
          }
          simulated.agents.set(op.agent.id, op.agent);
          break;
        case "retireAgent": {
          const existing = simulated.agents.get(op.agentId);
          if (!existing) throw new Error(`Cannot retire unknown agent ${op.agentId}.`);
          simulated.agents.set(op.agentId, { ...existing, status: "retired" });
          break;
        }
        case "upsertChannel":
          simulated.channels.set(op.channel.id, op.channel);
          break;
        case "rewireChannel": {
          const existing = simulated.channels.get(op.channelId);
          if (!existing) throw new Error(`Cannot rewire unknown channel ${op.channelId}.`);
          simulated.channels.set(op.channelId, { ...existing, participants: op.participants });
          break;
        }
        case "upsertRoute":
          this.validateRouteTarget(op.route, simulated);
          simulated.routes.set(op.route.id, op.route);
          break;
        case "setCapabilityMask":
          simulated.capabilities.set(op.mask.id, op.mask);
          break;
        case "setExecutorBinding":
          simulated.executorBindings.set(op.binding.id, op.binding);
          break;
        case "setSchedulerPolicy":
          simulated.schedulerPolicies.set(op.policy.id, op.policy);
          break;
        case "activateSkillVersion":
          simulated.skillVersions.set(op.skillVersion.id, op.skillVersion);
          break;
        case "deactivateSkillVersion": {
          const existing = simulated.skillVersions.get(op.skillVersionId);
          if (!existing) {
            throw new Error(`Cannot deactivate unknown skill version ${op.skillVersionId}.`);
          }
          simulated.skillVersions.set(op.skillVersionId, { ...existing, active: false });
          break;
        }
      }
    }
  }

  private validateRouteTarget(route: RouteRule, state: MetaStateMaps): void {
    if (route.target.startsWith("agent:")) {
      const agentId = route.target.slice("agent:".length);
      if (!state.agents.has(agentId)) {
        throw new Error(`Route ${route.id} references unknown target agent ${agentId}.`);
      }
      return;
    }
    if (route.target.startsWith("channel:")) {
      const channelId = route.target.slice("channel:".length);
      if (!state.channels.has(channelId)) {
        throw new Error(`Route ${route.id} references unknown target channel ${channelId}.`);
      }
      return;
    }
    throw new Error(`Route ${route.id} has unsupported target ${route.target}.`);
  }

  private applyOp(scope: MetaScope, op: TopologyChange): void {
    const target = this.layers[scope];
    switch (op.type) {
      case "upsertAgentProfile":
        target.profiles.set(op.profile.id, op.profile);
        return;
      case "spawnAgent":
        target.agents.set(op.agent.id, op.agent);
        return;
      case "retireAgent": {
        const existing = this.agents.get(op.agentId);
        if (existing) target.agents.set(op.agentId, { ...existing, status: "retired" });
        return;
      }
      case "upsertChannel":
        target.channels.set(op.channel.id, op.channel);
        return;
      case "rewireChannel": {
        const existing = this.channels.get(op.channelId);
        if (existing)
          target.channels.set(op.channelId, { ...existing, participants: op.participants });
        return;
      }
      case "upsertRoute":
        target.routes.set(op.route.id, op.route);
        return;
      case "setCapabilityMask":
        target.capabilities.set(op.mask.id, op.mask);
        return;
      case "setExecutorBinding":
        target.executorBindings.set(op.binding.id, op.binding);
        return;
      case "setSchedulerPolicy":
        target.schedulerPolicies.set(op.policy.id, op.policy);
        return;
      case "activateSkillVersion":
        target.skillVersions.set(op.skillVersion.id, op.skillVersion);
        return;
      case "deactivateSkillVersion": {
        const existing = this.skillVersions.get(op.skillVersionId);
        if (existing) target.skillVersions.set(op.skillVersionId, { ...existing, active: false });
        return;
      }
    }
  }

  private resolveRoute(source: string, message: string): RouteRule | undefined {
    return listById(this.routes)
      .filter((route) => {
        if (!route.enabled) return false;
        if (route.source !== "*" && route.source !== source) return false;
        return route.match === "*" || message.includes(route.match);
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))[0];
  }

  private async dispatchRoute(source: string, message: string): Promise<RouteDispatchResult> {
    const route = this.resolveRoute(source, message);
    if (!route) {
      return { routed: false, reason: `No enabled route matched source "${source}".` };
    }
    if (!this.hub) {
      return { routed: false, reason: "Meta-runtime provider is not attached to a hub." };
    }

    if (route.target.startsWith("agent:")) {
      const agentId = route.target.slice("agent:".length);
      const agent = this.agents.get(agentId);
      if (!agent) return { routed: false, reason: `Unknown target agent: ${agentId}` };
      if (agent.status !== "active") {
        return { routed: false, reason: `Target agent ${agentId} is ${agent.status}, not active.` };
      }
      const profile = this.profiles.get(agent.profileId);
      if (!profile) return { routed: false, reason: `Target agent ${agentId} has no profile.` };
      const executor = agent.executorBindingId
        ? this.executorBindings.get(agent.executorBindingId)
        : undefined;
      if (agent.executorBindingId && !executor) {
        return {
          routed: false,
          reason: `Target agent ${agentId} references unknown executor binding ${agent.executorBindingId}.`,
        };
      }
      const capabilityMasks = this.resolveAgentCapabilityMasks(agent, profile);
      const goal = [profile?.instructions, message].filter(Boolean).join("\n\n");
      const result = await this.hub.invoke("delegation", "/session", "spawn_agent", {
        name: profile.name,
        goal,
        executor,
        capabilityMasks,
      });
      if (result.status === "error") {
        this.recordEvent({
          kind: "route.failed",
          scope: "session",
          summary: `Route ${route.id} failed while dispatching to agent ${agent.id}: ${result.error?.message ?? "unknown error"}.`,
        });
        this.server.refresh();
        return {
          routed: false,
          reason: result.error?.message ?? `Route ${route.id} failed while dispatching.`,
        };
      }
      this.recordEvent({
        kind: "route.dispatched",
        scope: "session",
        summary: `Dispatched route ${route.id} to agent ${agent.id}.`,
      });
      this.server.refresh();
      return {
        routed: true,
        route_id: route.id,
        target: route.target,
        provider: "delegation",
        result,
      };
    }

    if (route.target.startsWith("channel:")) {
      const channelId = route.target.slice("channel:".length);
      const channel = this.channels.get(channelId);
      if (!channel) return { routed: false, reason: `Unknown target channel: ${channelId}` };
      if (!channel.participants.includes(source)) {
        return {
          routed: false,
          reason: `Source ${source} is not a participant in channel ${channelId}.`,
        };
      }
      const result = await this.hub.invoke("messaging", `/channels/${channelId}`, "send", {
        message,
      });
      if (result.status === "error") {
        this.recordEvent({
          kind: "route.failed",
          scope: "session",
          summary: `Route ${route.id} failed while dispatching to channel ${channel.id}: ${result.error?.message ?? "unknown error"}.`,
        });
        this.server.refresh();
        return {
          routed: false,
          reason: result.error?.message ?? `Route ${route.id} failed while dispatching.`,
        };
      }
      this.recordEvent({
        kind: "route.dispatched",
        scope: "session",
        summary: `Dispatched route ${route.id} to channel ${channel.id}.`,
      });
      this.server.refresh();
      return {
        routed: true,
        route_id: route.id,
        target: route.target,
        provider: "messaging",
        result,
      };
    }
    return {
      routed: false,
      reason: `Unsupported route target "${route.target}". Use agent:<id> or channel:<id>.`,
    };
  }

  private resolveAgentCapabilityMasks(agent: AgentNode, profile: AgentProfile): CapabilityMask[] {
    const ids = [...(profile.defaultCapabilities ?? []), ...agent.capabilityMaskIds];
    return ids.map((id) => {
      const mask = this.capabilities.get(id);
      if (!mask) {
        throw new Error(`Agent ${agent.id} references unknown capability mask ${id}.`);
      }
      return mask;
    });
  }

  private buildSessionDescriptor() {
    return {
      type: "context",
      props: {
        agents_count: this.agents.size,
        profiles_count: this.profiles.size,
        channels_count: this.channels.size,
        routes_count: this.routes.size,
        proposals_count: this.proposals.size,
        pending_proposals_count: [...this.proposals.values()].filter(
          (proposal) => proposal.status === "proposed",
        ).length,
        global_root: this.globalRoot,
        workspace_root: this.workspaceRoot,
      },
      summary:
        "Meta-runtime topology: agent graph, channels, routes, skills, policies, and proposals.",
      actions: {
        propose_change: action(
          {
            summary: "string",
            scope: {
              type: "string",
              enum: ["session", "workspace", "global"],
              optional: true,
            },
            rationale: {
              type: "string",
              optional: true,
            },
            ttl_ms: {
              type: "number",
              optional: true,
            },
            ops: {
              type: "array",
              description: "Typed TopologyChange operations.",
            },
          },
          (params) => this.proposeChange(params),
          {
            label: "Propose Change",
            description: "Record a proposed change to the agent communication topology.",
            estimate: "fast",
          },
        ),
        dispatch_route: action(
          {
            source: "string",
            message: "string",
          },
          async ({ source, message }) => this.dispatchRoute(String(source), String(message)),
          {
            label: "Dispatch Route",
            description:
              "Route a message through the active meta-runtime route table to a delegated agent or messaging channel.",
            estimate: "fast",
          },
        ),
        export_state: action(
          {
            scope: {
              type: "string",
              enum: ["merged", "workspace", "global"],
              optional: true,
            },
          },
          ({ scope }) =>
            this.exportState(scope === "workspace" || scope === "global" ? scope : undefined),
          {
            label: "Export State",
            description: "Export merged, workspace, or global meta-runtime state.",
            idempotent: true,
            estimate: "instant",
          },
        ),
        import_state: action(
          {
            scope: {
              type: "string",
              enum: ["session", "workspace", "global"],
            },
            mode: {
              type: "string",
              enum: ["merge", "replace"],
              optional: true,
            },
            state: {
              type: "object",
              description: "Meta-runtime state previously returned by export_state.",
            },
          },
          ({ scope, mode, state }) =>
            this.importState(
              asScope(scope),
              (state && typeof state === "object" ? state : {}) as PersistedState,
              mode === "replace" ? "replace" : "merge",
            ),
          {
            label: "Import State",
            description:
              "Import meta-runtime state. Persistent scopes require approval before writing.",
            dangerous: true,
            estimate: "fast",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 0.85,
      },
    };
  }

  private buildProposalsDescriptor() {
    const items: ItemDescriptor[] = listById(this.proposals).map((proposal) => ({
      id: proposal.id,
      props: proposal,
      summary: proposal.summary,
      actions: {
        ...(proposal.status === "proposed"
          ? {
              apply_proposal: action(async () => this.applyProposal(proposal.id), {
                label: "Apply Proposal",
                description:
                  "Apply this topology proposal. Privileged or persistent changes request approval.",
                dangerous: proposal.requiresApproval,
                estimate: "fast",
              }),
              revert_proposal: action(async () => this.revertProposal(proposal.id), {
                label: "Revert Proposal",
                description: "Mark this proposed topology change as reverted.",
                estimate: "instant",
              }),
            }
          : {}),
      },
      meta: {
        salience: proposal.status === "proposed" ? 0.9 : 0.4,
        urgency: proposal.requiresApproval && proposal.status === "proposed" ? "high" : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Pending and resolved meta-runtime topology proposals.",
      items,
    };
  }

  private collection(name: string, items: Array<Record<string, unknown>>) {
    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: `Meta-runtime ${name}.`,
      items: items.map((item) => ({
        id: String(item.id),
        props: item,
        summary: String(item.name ?? item.summary ?? item.id),
      })),
    };
  }
}

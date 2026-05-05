import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { ProviderRuntimeHub } from "../../core/hub";
import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";
import {
  createExperiment as buildExperiment,
  createEvaluation,
  experimentMeetsCriteria,
} from "./meta-runtime-experiments";
import type {
  AgentChannel,
  AgentNode,
  AgentProfile,
  CapabilityMask,
  ExecutorBinding,
  ExperimentEvaluation,
  MetaEvent,
  MetaScope,
  MetaStateMaps,
  PersistedState,
  Proposal,
  RouteDispatchResult,
  RouteMessageEnvelope,
  RouteRule,
  SkillVersion,
  TopologyExperiment,
} from "./meta-runtime-model";
import {
  clearStateMaps,
  createStateMaps,
  listById,
  listByName,
  putById,
  putState,
  snapshotStateMaps,
} from "./meta-runtime-model";
import { applyTopologyChange, validateTopologyChanges } from "./meta-runtime-mutations";
import {
  asScope,
  asString,
  classifyApproval,
  optionalNonNegativeInteger,
  parseChange,
} from "./meta-runtime-ops";
import { matchingRoutes, normalizeRouteEnvelope, parseRouteMessage } from "./meta-runtime-routing";
import { activateLinkedSkills, opsWithActivatedSkills } from "./meta-runtime-skills";
import {
  readPersistedMetaState,
  resolveMetaRuntimeRoot,
  snapshotMergedMetaState,
  snapshotMetaScope,
  writePersistedMetaState,
} from "./meta-runtime-storage";

export type {
  AgentChannel,
  AgentNode,
  AgentProfile,
  CapabilityMask,
  ExecutorBinding,
  RouteMessageEnvelope,
  RouteRule,
  SkillVersion,
  TopologyChange,
  TopologyExperiment,
} from "./meta-runtime-model";

function now(): string {
  return new Date().toISOString();
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
  private skillVersions = new Map<string, SkillVersion>();
  private experiments = new Map<string, TopologyExperiment>();
  private evaluations = new Map<string, ExperimentEvaluation>();
  private proposals = new Map<string, Proposal>();
  private events: MetaEvent[] = [];

  constructor(options: { globalRoot?: string; workspaceRoot?: string } = {}) {
    this.globalRoot = resolveMetaRuntimeRoot(options.globalRoot ?? "~/.sloppy/meta-runtime");
    this.workspaceRoot = resolveMetaRuntimeRoot(options.workspaceRoot ?? ".sloppy/meta-runtime");

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
    this.server.register("skill-versions", () =>
      this.collection("skill-versions", listById(this.skillVersions)),
    );
    this.server.register("experiments", () =>
      this.collection("experiments", listById(this.experiments)),
    );
    this.server.register("evaluations", () =>
      this.collection("evaluations", listById(this.evaluations)),
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
    const global = readPersistedMetaState(this.globalRoot);
    const workspace = readPersistedMetaState(this.workspaceRoot);
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
    writePersistedMetaState(
      root,
      snapshotMetaScope(this.layers, this.proposals, this.events, scope),
    );
  }

  private rebuildMergedState(): void {
    this.profiles.clear();
    this.agents.clear();
    this.channels.clear();
    this.routes.clear();
    this.capabilities.clear();
    this.executorBindings.clear();
    this.skillVersions.clear();
    this.experiments.clear();
    this.evaluations.clear();

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
      skillVersions: this.skillVersions,
      experiments: this.experiments,
      evaluations: this.evaluations,
    };
  }

  private exportState(scope?: MetaScope): PersistedState & { scope: MetaScope | "merged" } {
    if (scope === "global") {
      return { scope, ...readPersistedMetaState(this.globalRoot) };
    }
    if (scope === "workspace") {
      return { scope, ...readPersistedMetaState(this.workspaceRoot) };
    }
    return {
      scope: "merged",
      ...snapshotMergedMetaState(this.mergedMaps(), this.proposals, this.events),
    };
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

  private async applyProposal(id: string, approved = false): Promise<Proposal> {
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

    validateTopologyChanges(proposal.ops, this.mergedMaps());
    const activatedSkillVersions = await activateLinkedSkills(
      proposal,
      this.hub,
      (skillVersionId, reason) =>
        this.recordSkillActivationFailure(proposal, skillVersionId, reason),
    );
    const ops = opsWithActivatedSkills(proposal.ops, activatedSkillVersions);
    if (activatedSkillVersions.size > 0) {
      validateTopologyChanges(ops, this.mergedMaps());
    }
    for (const op of ops) {
      applyTopologyChange(this.layers, this.mergedMaps(), proposal.scope, op);
    }
    this.rebuildMergedState();
    for (const skillVersion of activatedSkillVersions.values()) {
      this.recordEvent({
        kind: "skill.activated",
        scope: skillVersion.scope,
        proposalId: proposal.id,
        summary: `Skill version ${skillVersion.id} activated through skills provider.`,
      });
    }
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

  private recordSkillActivationFailure(
    proposal: Proposal,
    skillVersionId: string,
    reason: string,
  ): void {
    this.recordEvent({
      kind: "skill.activation_failed",
      scope: proposal.scope,
      proposalId: proposal.id,
      summary: `Skill version ${skillVersionId} activation failed: ${reason}.`,
    });
    this.persist(proposal.scope);
    this.server.refresh();
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

  private createExperiment(params: Record<string, unknown>, approved = false): TopologyExperiment {
    const proposalId = asString(params.proposal_id, "proposal_id");
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Unknown proposal for experiment: ${proposalId}`);
    }
    if (proposal.scope !== "session" && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "create_experiment",
        reason: `Creating a ${proposal.scope} topology experiment writes persisted meta-runtime metadata.`,
        paramsPreview: JSON.stringify({
          proposal_id: proposalId,
          name: params.name,
          objective: params.objective,
        }),
        dangerous: true,
        execute: () => this.createExperiment(params, true),
      });
      throw createApprovalRequiredError(
        `Creating experiment for ${proposal.scope} proposal ${proposalId} requires approval via /approvals/${approvalId}.`,
      );
    }
    const experiment = buildExperiment(proposal.scope, proposal, params);
    this.layers[proposal.scope].experiments.set(experiment.id, experiment);
    this.rebuildMergedState();
    this.recordEvent({
      kind: "experiment.created",
      scope: experiment.scope,
      proposalId,
      summary: `Created topology experiment ${experiment.name}.`,
    });
    this.persist(experiment.scope);
    this.server.refresh();
    return experiment;
  }

  private recordEvaluation(
    params: Record<string, unknown>,
    approved = false,
  ): ExperimentEvaluation {
    const experimentId = asString(params.experiment_id, "experiment_id");
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Unknown experiment: ${experimentId}`);
    }
    if (experiment.scope !== "session" && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "record_evaluation",
        reason: `Recording an evaluation for ${experiment.scope} experiment ${experimentId} writes persisted meta-runtime metadata.`,
        paramsPreview: JSON.stringify({
          experiment_id: experimentId,
          score: params.score,
          evaluator: params.evaluator,
        }),
        dangerous: true,
        execute: () => this.recordEvaluation(params, true),
      });
      throw createApprovalRequiredError(
        `Recording evaluation for ${experiment.scope} experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
      );
    }
    const evaluation = createEvaluation(experimentId, params);
    this.layers[experiment.scope].evaluations.set(evaluation.id, evaluation);
    this.rebuildMergedState();
    this.recordEvent({
      kind: "experiment.evaluated",
      scope: experiment.scope,
      proposalId: experiment.proposalId,
      summary: `Recorded evaluation ${evaluation.id} for ${experiment.name}.`,
    });
    this.persist(experiment.scope);
    this.server.refresh();
    return evaluation;
  }

  private async promoteExperiment(
    experimentId: string,
    approved = false,
  ): Promise<TopologyExperiment> {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Unknown experiment: ${experimentId}`);
    }
    if (experiment.status !== "candidate") {
      throw new Error(`Experiment ${experimentId} is already ${experiment.status}.`);
    }
    const evaluations = listById(this.evaluations).filter(
      (evaluation) => evaluation.experimentId === experiment.id,
    );
    if (!experimentMeetsCriteria(experiment, evaluations)) {
      throw new Error(`Experiment ${experimentId} does not meet promotion criteria.`);
    }
    const proposal = this.proposals.get(experiment.proposalId);
    if (!proposal) {
      throw new Error(
        `Experiment ${experimentId} references unknown proposal ${experiment.proposalId}.`,
      );
    }
    if (proposal.status !== "proposed" && proposal.status !== "applied") {
      throw new Error(
        `Experiment ${experimentId} references proposal ${proposal.id}, which is ${proposal.status}.`,
      );
    }
    if ((experiment.scope !== "session" || proposal.requiresApproval) && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "promote_experiment",
        reason: `Promoting experiment ${experimentId} applies or records privileged meta-runtime state.`,
        paramsPreview: JSON.stringify({
          experiment_id: experimentId,
          proposal_id: proposal.id,
          proposal_scope: proposal.scope,
          proposal_ops: proposal.ops.map((op) => op.type),
        }),
        dangerous: true,
        execute: () => this.promoteExperiment(experimentId, true),
      });
      throw createApprovalRequiredError(
        `Promoting experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
      );
    }
    if (proposal.status === "proposed") {
      await this.applyProposal(proposal.id, true);
    }
    const promoted = { ...experiment, status: "promoted" as const, promotedAt: now() };
    this.layers[experiment.scope].experiments.set(promoted.id, promoted);
    this.rebuildMergedState();
    this.recordEvent({
      kind: "experiment.promoted",
      scope: promoted.scope,
      proposalId: promoted.proposalId,
      summary: `Promoted topology experiment ${promoted.name}.`,
    });
    this.persist(promoted.scope);
    this.server.refresh();
    return promoted;
  }

  private async markExperimentRolledBack(
    params: Record<string, unknown>,
    approved = false,
  ): Promise<TopologyExperiment> {
    const experimentId = asString(params.experiment_id, "experiment_id");
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Unknown experiment: ${experimentId}`);
    }
    if (experiment.status !== "promoted") {
      throw new Error(`Experiment ${experimentId} is ${experiment.status}, not promoted.`);
    }
    const rollbackProposalId =
      typeof params.rollback_proposal_id === "string" ? params.rollback_proposal_id : undefined;
    const rollbackProposal = rollbackProposalId
      ? this.proposals.get(rollbackProposalId)
      : undefined;
    if (rollbackProposalId && !rollbackProposal) {
      throw new Error(`Unknown rollback proposal: ${rollbackProposalId}`);
    }
    if (
      rollbackProposal &&
      rollbackProposal.status !== "proposed" &&
      rollbackProposal.status !== "applied"
    ) {
      throw new Error(
        `Rollback proposal ${rollbackProposal.id} is ${rollbackProposal.status}, not proposed or applied.`,
      );
    }
    if (
      (experiment.scope !== "session" || rollbackProposal?.requiresApproval === true) &&
      !approved
    ) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "rollback_experiment",
        reason: `Rolling back experiment ${experimentId} applies or records privileged meta-runtime state.`,
        paramsPreview: JSON.stringify({
          experiment_id: experimentId,
          rollback_proposal_id: rollbackProposalId,
          experiment_scope: experiment.scope,
        }),
        dangerous: true,
        execute: () => this.markExperimentRolledBack(params, true),
      });
      throw createApprovalRequiredError(
        `Rolling back experiment ${experimentId} requires approval via /approvals/${approvalId}.`,
      );
    }
    if (rollbackProposal?.status === "proposed") {
      await this.applyProposal(rollbackProposal.id, true);
    }
    const rolledBack = {
      ...experiment,
      status: "rolled_back" as const,
      rolledBackAt: now(),
      rollbackProposalId,
    };
    this.layers[experiment.scope].experiments.set(rolledBack.id, rolledBack);
    this.rebuildMergedState();
    this.recordEvent({
      kind: "experiment.rolled_back",
      scope: rolledBack.scope,
      proposalId: rolledBack.proposalId,
      summary: `Marked topology experiment ${rolledBack.name} as rolled back.`,
    });
    this.persist(rolledBack.scope);
    this.server.refresh();
    return rolledBack;
  }

  private async dispatchRoute(
    source: string,
    message: string | RouteMessageEnvelope,
    fanout = false,
  ): Promise<RouteDispatchResult | { routed: boolean; deliveries: RouteDispatchResult[] }> {
    const envelope = normalizeRouteEnvelope(source, message);
    const routes = matchingRoutes(listById(this.routes), envelope, fanout);
    if (routes.length === 0) {
      return { routed: false, reason: `No enabled route matched source "${envelope.source}".` };
    }
    if (!this.hub) {
      return { routed: false, reason: "Meta-runtime provider is not attached to a hub." };
    }

    const deliveries: RouteDispatchResult[] = [];
    for (const route of routes) {
      deliveries.push(await this.dispatchSingleRoute(route, envelope));
    }

    if (fanout) {
      return { routed: deliveries.some((delivery) => delivery.routed), deliveries };
    }

    return deliveries[0] ?? { routed: false, reason: "No route deliveries were attempted." };
  }

  private async dispatchSingleRoute(
    route: RouteRule,
    envelope: RouteMessageEnvelope,
  ): Promise<RouteDispatchResult> {
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
      const goal = [
        profile?.instructions,
        `Route message ${envelope.id} from ${envelope.source}:`,
        envelope.body,
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await this.hub.invoke("delegation", "/session", "spawn_agent", {
        name: profile.name,
        goal,
        ...(executor ? { executor } : {}),
        capabilityMasks,
        routeEnvelope: envelope,
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
        envelope,
      };
    }

    if (route.target.startsWith("channel:")) {
      const channelId = route.target.slice("channel:".length);
      const channel = this.channels.get(channelId);
      if (!channel) return { routed: false, reason: `Unknown target channel: ${channelId}` };
      if (!channel.participants.includes(envelope.source)) {
        return {
          routed: false,
          reason: `Source ${envelope.source} is not a participant in channel ${channelId}.`,
        };
      }
      const result = await this.hub.invoke("messaging", `/channels/${channelId}`, "send", {
        message: envelope.body,
        envelope,
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
        envelope,
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
        experiments_count: this.experiments.size,
        proposals_count: this.proposals.size,
        pending_proposals_count: [...this.proposals.values()].filter(
          (proposal) => proposal.status === "proposed",
        ).length,
        global_root: this.globalRoot,
        workspace_root: this.workspaceRoot,
      },
      summary:
        "Meta-runtime topology: agent graph, channels, routes, skills, experiments, and proposals.",
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
            envelope: {
              type: "object",
              description:
                "Optional typed route envelope: { id?, source?, body, topic?, channelId?, inReplyTo?, causationId?, metadata? }.",
              optional: true,
            },
            fanout: {
              type: "boolean",
              optional: true,
            },
          },
          async ({ source, message, envelope, fanout }) =>
            this.dispatchRoute(
              String(source),
              envelope === undefined ? String(message) : parseRouteMessage(envelope),
              fanout === true,
            ),
          {
            label: "Dispatch Route",
            description:
              "Route a typed message envelope through active meta-runtime routes to delegated agents or messaging channels.",
            estimate: "fast",
          },
        ),
        create_experiment: action(
          {
            proposal_id: "string",
            name: "string",
            objective: "string",
            parent_experiment_id: {
              type: "string",
              optional: true,
            },
            promotion_criteria: {
              type: "object",
              optional: true,
            },
          },
          (params) => this.createExperiment(params),
          {
            label: "Create Experiment",
            description: "Attach a topology proposal to an evaluable experiment before promotion.",
            estimate: "fast",
          },
        ),
        record_evaluation: action(
          {
            experiment_id: "string",
            score: "number",
            summary: "string",
            evaluator: {
              type: "string",
              optional: true,
            },
            evidence: {
              type: "object",
              optional: true,
            },
          },
          (params) => this.recordEvaluation(params),
          {
            label: "Record Evaluation",
            description: "Record scored evidence for a topology experiment.",
            estimate: "fast",
          },
        ),
        promote_experiment: action(
          {
            experiment_id: "string",
          },
          ({ experiment_id }) => this.promoteExperiment(String(experiment_id)),
          {
            label: "Promote Experiment",
            description:
              "Promote an experiment whose evaluations satisfy its criteria, applying its proposal if needed.",
            dangerous: true,
            estimate: "fast",
          },
        ),
        rollback_experiment: action(
          {
            experiment_id: "string",
            rollback_proposal_id: {
              type: "string",
              optional: true,
            },
          },
          (params) => this.markExperimentRolledBack(params),
          {
            label: "Rollback Experiment",
            description:
              "Mark a promoted experiment as rolled back, applying a pending rollback proposal when provided.",
            dangerous: true,
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

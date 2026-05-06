import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { ProviderRuntimeHub } from "../../core/hub";
import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";
import {
  analyzeRuntimeTrace as analyzeRuntimeTraceWithContext,
  type MetaRuntimeArchitectContext,
  prepareArchitectBrief as prepareArchitectBriefWithContext,
  recordExperimentEvidence as recordExperimentEvidenceWithContext,
  startRuntimeArchitectCycle,
} from "./meta-runtime-architect-controller";
import { dispatchMetaRuntimeRoute } from "./meta-runtime-dispatch";
import {
  createTopologyExperiment,
  type MetaRuntimeExperimentContext,
  markTopologyExperimentRolledBack,
  promoteTopologyExperiment,
  recordTopologyExperimentEvaluation,
} from "./meta-runtime-experiment-controller";
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
  RouteRule,
  SkillVersion,
  TopologyExperiment,
  TopologyPattern,
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
import {
  archiveTopologyPattern as archiveTopologyPatternWithContext,
  type MetaRuntimePatternContext,
  proposeFromPattern as proposeFromPatternWithContext,
} from "./meta-runtime-pattern-controller";
import { deriveRuntimeEvolutionProposals } from "./meta-runtime-reflection";
import { parseRouteMessage } from "./meta-runtime-routing";
import { buildMetaRuntimeSessionDescriptor } from "./meta-runtime-session-descriptor";
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
  TopologyPattern,
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
  private patterns = new Map<string, TopologyPattern>();
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
    this.server.register("patterns", () => this.buildPatternsDescriptor());
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
    putById(this.patterns, global.patterns);
    putById(this.patterns, workspace.patterns);
    this.events.push(...(global.events ?? []), ...(workspace.events ?? []));
    this.events = this.events.slice(-200);
    this.rebuildMergedState();
  }

  private persist(scope: MetaScope): void {
    if (scope === "session") return;
    const root = scope === "global" ? this.globalRoot : this.workspaceRoot;
    writePersistedMetaState(
      root,
      snapshotMetaScope(this.layers, this.proposals, this.patterns, this.events, scope),
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
      ...snapshotMergedMetaState(this.mergedMaps(), this.proposals, this.patterns, this.events),
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
      for (const pattern of [...this.patterns.values()]) {
        if (pattern.scope === scope) {
          this.patterns.delete(pattern.id);
        }
      }
      this.events = this.events.filter((event) => event.scope !== scope);
    }
    putState(this.layers[scope], state);
    putById(this.proposals, state.proposals);
    putById(this.patterns, state.patterns);
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

  private experimentContext(): MetaRuntimeExperimentContext {
    return {
      approvals: this.approvals,
      hub: this.hub,
      layers: this.layers,
      proposals: this.proposals,
      experiments: this.experiments,
      evaluations: this.evaluations,
      rebuildMergedState: () => this.rebuildMergedState(),
      applyProposal: (id, approved) => this.applyProposal(id, approved),
      recordEvent: (event) => this.recordEvent(event),
      persist: (scope) => this.persist(scope),
      refresh: () => this.server.refresh(),
    };
  }

  private createExperiment(params: Record<string, unknown>, approved = false): TopologyExperiment {
    return createTopologyExperiment(this.experimentContext(), params, approved);
  }

  private recordEvaluation(
    params: Record<string, unknown>,
    approved = false,
  ): ExperimentEvaluation {
    return recordTopologyExperimentEvaluation(this.experimentContext(), params, approved);
  }

  private async promoteExperiment(
    experimentId: string,
    approved = false,
  ): Promise<TopologyExperiment> {
    return promoteTopologyExperiment(this.experimentContext(), experimentId, approved);
  }

  private async markExperimentRolledBack(
    params: Record<string, unknown>,
    approved = false,
  ): Promise<TopologyExperiment> {
    return markTopologyExperimentRolledBack(this.experimentContext(), params, approved);
  }

  private architectContext(): MetaRuntimeArchitectContext {
    return {
      hub: this.hub,
      events: this.events,
      routes: this.routes,
      channels: this.channels,
      agents: this.agents,
      proposals: this.proposals,
      experiments: this.experiments,
      evaluations: this.evaluations,
      recordEvaluation: (params, approved) => this.recordEvaluation(params, approved),
      recordEvent: (event) => this.recordEvent(event),
      refresh: () => this.server.refresh(),
    };
  }

  private analyzeRuntimeTrace(params: Record<string, unknown>) {
    return analyzeRuntimeTraceWithContext(this.architectContext(), params);
  }

  private prepareArchitectBrief(params: Record<string, unknown>) {
    return prepareArchitectBriefWithContext(this.architectContext(), params);
  }

  private async startArchitectCycle(params: Record<string, unknown>) {
    return startRuntimeArchitectCycle(this.architectContext(), params);
  }

  private recordExperimentEvidence(
    params: Record<string, unknown>,
    approved = false,
  ): ExperimentEvaluation {
    return recordExperimentEvidenceWithContext(this.architectContext(), params, approved);
  }

  private patternContext(): MetaRuntimePatternContext {
    return {
      approvals: this.approvals,
      patterns: this.patterns,
      proposals: this.proposals,
      experiments: this.experiments,
      evaluations: this.evaluations,
      proposeChange: (params) => this.proposeChange(params),
      recordEvent: (event) => this.recordEvent(event),
      persist: (scope) => this.persist(scope),
      refresh: () => this.server.refresh(),
    };
  }

  private archiveTopologyPattern(
    params: Record<string, unknown>,
    approved = false,
  ): TopologyPattern {
    return archiveTopologyPatternWithContext(this.patternContext(), params, approved);
  }

  private proposeFromPattern(params: Record<string, unknown>): Proposal {
    return proposeFromPatternWithContext(this.patternContext(), params);
  }

  private deriveProposalsFromEvents(params: Record<string, unknown>): {
    count: number;
    proposals: Array<{ proposal: Proposal; source_event_ids: string[] }>;
  } {
    const scope = asScope(params.scope);
    const minEvents = Math.max(
      optionalNonNegativeInteger(params.min_events ?? params.min_failures, "min_events") ?? 2,
      1,
    );
    const limit = Math.max(optionalNonNegativeInteger(params.limit, "limit") ?? 100, 1);
    const drafts = deriveRuntimeEvolutionProposals({
      events: this.events,
      routes: listById(this.routes),
      channels: listById(this.channels),
      agents: listById(this.agents),
      proposals: listById(this.proposals),
      minEvents,
      limit,
    });
    const proposals = drafts.map((draft) => ({
      proposal: this.proposeChange({
        scope,
        summary: draft.summary,
        rationale: `${draft.rationale} Source events: ${draft.sourceEventIds.join(", ")}.`,
        ops: draft.ops,
      }),
      source_event_ids: draft.sourceEventIds,
    }));
    return { count: proposals.length, proposals };
  }

  private startEvolutionCycle(params: Record<string, unknown>): {
    count: number;
    items: Array<{
      proposal: Proposal;
      experiment: TopologyExperiment;
      source_event_ids: string[];
    }>;
  } {
    const scope = asScope(params.scope);
    if (scope !== "session") {
      throw new Error("start_evolution_cycle currently supports session scope only.");
    }
    const minEvents = Math.max(
      optionalNonNegativeInteger(params.min_events ?? params.min_failures, "min_events") ?? 2,
      1,
    );
    const limit = Math.max(optionalNonNegativeInteger(params.limit, "limit") ?? 100, 1);
    const drafts = deriveRuntimeEvolutionProposals({
      events: this.events,
      routes: listById(this.routes),
      channels: listById(this.channels),
      agents: listById(this.agents),
      proposals: listById(this.proposals),
      minEvents,
      limit,
    });
    const items = drafts.map((draft) => {
      const proposal = this.proposeChange({
        scope,
        summary: draft.summary,
        rationale: `${draft.rationale} Source events: ${draft.sourceEventIds.join(", ")}.`,
        ops: draft.ops,
      });
      const experiment = this.createExperiment({
        proposal_id: proposal.id,
        name: draft.experiment.name,
        objective: draft.experiment.objective,
        promotion_criteria: draft.experiment.promotionCriteria,
      });
      return {
        proposal,
        experiment,
        source_event_ids: draft.sourceEventIds,
      };
    });
    return { count: items.length, items };
  }

  private dispatchRoute(params: Record<string, unknown>) {
    const { source, message, envelope, fanout } = params;
    return dispatchMetaRuntimeRoute(
      {
        hub: this.hub,
        routes: listById(this.routes),
        agents: this.agents,
        profiles: this.profiles,
        channels: this.channels,
        capabilities: this.capabilities,
        executorBindings: this.executorBindings,
        recordEvent: (event) => this.recordEvent(event),
        refresh: () => this.server.refresh(),
      },
      String(source),
      envelope === undefined ? String(message) : parseRouteMessage(envelope),
      fanout === true,
    );
  }

  private buildSessionDescriptor() {
    return buildMetaRuntimeSessionDescriptor({
      counts: {
        agents: this.agents.size,
        profiles: this.profiles.size,
        channels: this.channels.size,
        routes: this.routes.size,
        experiments: this.experiments.size,
        proposals: this.proposals.size,
        patterns: this.patterns.size,
        pendingProposals: [...this.proposals.values()].filter(
          (proposal) => proposal.status === "proposed",
        ).length,
      },
      globalRoot: this.globalRoot,
      workspaceRoot: this.workspaceRoot,
      proposeChange: (params) => this.proposeChange(params),
      dispatchRoute: (params) => this.dispatchRoute(params),
      analyzeRuntimeTrace: (params) => this.analyzeRuntimeTrace(params),
      prepareArchitectBrief: (params) => this.prepareArchitectBrief(params),
      startArchitectCycle: (params) => this.startArchitectCycle(params),
      deriveProposalsFromEvents: (params) => this.deriveProposalsFromEvents(params),
      startEvolutionCycle: (params) => this.startEvolutionCycle(params),
      createExperiment: (params) => this.createExperiment(params),
      recordEvaluation: (params) => this.recordEvaluation(params),
      recordExperimentEvidence: (params) => this.recordExperimentEvidence(params),
      promoteExperiment: (experimentId) => this.promoteExperiment(experimentId),
      rollbackExperiment: (params) => this.markExperimentRolledBack(params),
      archiveTopologyPattern: (params) => this.archiveTopologyPattern(params),
      proposeFromPattern: (params) => this.proposeFromPattern(params),
      exportState: (scope) => this.exportState(scope),
      importState: (scope, state, mode) => this.importState(scope, state, mode),
    });
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

  private buildPatternsDescriptor() {
    const items: ItemDescriptor[] = listByName(this.patterns).map((pattern) => ({
      id: pattern.id,
      props: pattern,
      summary: pattern.summary ?? pattern.name,
      actions: {
        propose_from_pattern: action(
          {
            scope: {
              type: "string",
              enum: ["session", "workspace", "global"],
              optional: true,
            },
            summary: {
              type: "string",
              optional: true,
            },
            rationale: {
              type: "string",
              optional: true,
            },
          },
          (params) => this.proposeFromPattern({ ...params, pattern_id: pattern.id }),
          {
            label: "Propose From Pattern",
            description: "Create a topology proposal from this archived pattern.",
            estimate: "fast",
          },
        ),
      },
      meta: {
        salience: 0.55,
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Reusable topology patterns archived from promoted experiments.",
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

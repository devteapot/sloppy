import { createSlopServer, type SlopServer } from "@slop-ai/server";

import type { RuntimeEvent } from "../../../core/role";
import { createApprovalRequiredError, ProviderApprovalManager } from "../../../providers/approvals";
import { type RuntimeServiceKey, RuntimeServiceRegistry } from "../../../runtime/services";
import { SKILLS_SERVICE } from "../service-keys";
import { now } from "../shared/runtime-helpers";
import {
  emptySkillImportSummary,
  parseRuntimeBundle,
  type RuntimeBundle,
  type RuntimeBundleSkill,
  type RuntimeBundleSkillFile,
  type SkillImportSummary,
  sha256,
} from "./meta-runtime-bundle";
import {
  buildMetaRuntimeCollectionDescriptor,
  buildMetaRuntimePatternsDescriptor,
  buildMetaRuntimeProposalsDescriptor,
} from "./meta-runtime-collection-descriptors";
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
  parsePersistedState,
} from "./meta-runtime-ops";
import {
  archiveTopologyPattern as archiveTopologyPatternWithContext,
  type MetaRuntimePatternContext,
  proposeFromPattern as proposeFromPatternWithContext,
} from "./meta-runtime-pattern-controller";
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

export class MetaRuntimeProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private readonly services: RuntimeServiceRegistry;
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
  private publishEvent: ((event: RuntimeEvent) => void) | null = null;

  constructor(
    options: {
      globalRoot?: string;
      workspaceRoot?: string;
      services?: RuntimeServiceRegistry;
    } = {},
  ) {
    this.services = options.services ?? new RuntimeServiceRegistry();
    this.globalRoot = resolveMetaRuntimeRoot(options.globalRoot ?? "~/.sloppy/meta-runtime");
    this.workspaceRoot = resolveMetaRuntimeRoot(options.workspaceRoot ?? ".sloppy/meta-runtime");

    this.server = createSlopServer({
      id: "meta-runtime",
      name: "Meta Runtime",
    });
    this.approvals = new ProviderApprovalManager(this.server);
    this.load();

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("agents", () =>
      buildMetaRuntimeCollectionDescriptor("agents", listById(this.agents)),
    );
    this.server.register("profiles", () =>
      buildMetaRuntimeCollectionDescriptor("profiles", listByName(this.profiles)),
    );
    this.server.register("channels", () =>
      buildMetaRuntimeCollectionDescriptor("channels", listById(this.channels)),
    );
    this.server.register("routes", () =>
      buildMetaRuntimeCollectionDescriptor("routes", listById(this.routes)),
    );
    this.server.register("capabilities", () =>
      buildMetaRuntimeCollectionDescriptor("capabilities", listById(this.capabilities)),
    );
    this.server.register("executor-bindings", () =>
      buildMetaRuntimeCollectionDescriptor("executor-bindings", listById(this.executorBindings)),
    );
    this.server.register("skill-versions", () =>
      buildMetaRuntimeCollectionDescriptor("skill-versions", listById(this.skillVersions)),
    );
    this.server.register("experiments", () =>
      buildMetaRuntimeCollectionDescriptor("experiments", listById(this.experiments)),
    );
    this.server.register("evaluations", () =>
      buildMetaRuntimeCollectionDescriptor("evaluations", listById(this.evaluations)),
    );
    this.server.register("proposals", () =>
      buildMetaRuntimeProposalsDescriptor({
        proposals: this.proposals,
        requiresApproval: (proposal) => this.recomputeProposalApproval(proposal),
        applyProposal: (id) => this.applyProposal(id),
        revertProposal: (id) => this.revertProposal(id),
      }),
    );
    this.server.register("patterns", () =>
      buildMetaRuntimePatternsDescriptor({
        patterns: this.patterns,
        proposeFromPattern: (params) => this.proposeFromPattern(params),
      }),
    );
    this.server.register("events", () =>
      buildMetaRuntimeCollectionDescriptor("events", this.events),
    );
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  setEventPublisher(publishEvent?: (event: RuntimeEvent) => void): void {
    this.publishEvent = publishEvent ?? null;
  }

  bindRuntimeService<T>(key: RuntimeServiceKey<T>, service: T): void {
    this.services.bind(key, service);
  }

  private load(): void {
    const global = parsePersistedState(readPersistedMetaState(this.globalRoot));
    const workspace = parsePersistedState(readPersistedMetaState(this.workspaceRoot));
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
      return { scope, ...parsePersistedState(readPersistedMetaState(this.globalRoot)) };
    }
    if (scope === "workspace") {
      return { scope, ...parsePersistedState(readPersistedMetaState(this.workspaceRoot)) };
    }
    return {
      scope: "merged",
      ...snapshotMergedMetaState(this.mergedMaps(), this.proposals, this.patterns, this.events),
    };
  }

  private importState(
    scope: MetaScope,
    state: unknown,
    mode: "merge" | "replace",
    approved = false,
  ): { scope: MetaScope; mode: "merge" | "replace"; imported: true } {
    const parsedState = parsePersistedState(state);
    if (scope !== "session" && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "import_state",
        reason: `Importing ${scope} meta-runtime state overwrites persisted runtime topology.`,
        paramsPreview: JSON.stringify({
          scope,
          mode,
          profiles: parsedState.profiles?.length ?? 0,
          agents: parsedState.agents?.length ?? 0,
          routes: parsedState.routes?.length ?? 0,
        }),
        dangerous: true,
        execute: () => this.importState(scope, parsedState, mode, true),
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
    putState(this.layers[scope], parsedState);
    putById(this.proposals, parsedState.proposals);
    putById(this.patterns, parsedState.patterns);
    this.events.push(...(parsedState.events ?? []));
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

  private async exportBundle(params: Record<string, unknown>): Promise<RuntimeBundle> {
    const scope =
      params.scope === "global" || params.scope === "workspace"
        ? params.scope
        : ("merged" as const);
    const state =
      scope === "global" || scope === "workspace"
        ? this.exportState(scope)
        : this.exportState(undefined);
    const { scope: _exportedScope, ...portableState } = state;
    const includeSkills = params.include_skills !== false;
    return {
      kind: "sloppy.meta-runtime.bundle",
      schema_version: 1,
      exported_at: now(),
      scope,
      state: portableState,
      skills: includeSkills ? await this.exportActiveSkillContents() : [],
      notes: {
        secrets: "excluded",
      },
    };
  }

  private async exportActiveSkillContents(): Promise<RuntimeBundleSkill[]> {
    const activeSkillVersions = [...this.skillVersions.values()].filter(
      (skillVersion) => skillVersion.active && skillVersion.activationStatus !== "failed",
    );
    if (activeSkillVersions.length === 0) {
      return [];
    }
    this.services.require(SKILLS_SERVICE, "Skills");

    const bySkillId = new Map<string, SkillVersion>();
    for (const skillVersion of activeSkillVersions) {
      if (!bySkillId.has(skillVersion.skillId)) {
        bySkillId.set(skillVersion.skillId, skillVersion);
      }
    }

    const skills: RuntimeBundleSkill[] = [];
    for (const skillVersion of bySkillId.values()) {
      const viewed = await this.invokeSkillView(skillVersion.skillId);
      const supportingFiles = Array.isArray(viewed.supporting_files)
        ? viewed.supporting_files.filter((file): file is string => typeof file === "string")
        : [];
      const files: RuntimeBundleSkillFile[] = [];
      for (const filePath of supportingFiles) {
        if (!filePath || filePath === "SKILL.md") continue;
        const supporting = await this.invokeSkillView(skillVersion.skillId, filePath);
        if (typeof supporting.content === "string") {
          files.push({
            path: filePath,
            content: supporting.content,
            sha256: sha256(supporting.content),
          });
        }
      }
      if (typeof viewed.content !== "string" || !viewed.content.trim()) {
        throw new Error(`Active skill ${skillVersion.skillId} exported empty content.`);
      }
      skills.push({
        name: skillVersion.skillId,
        version: skillVersion.version,
        scope: skillVersion.scope,
        content: viewed.content,
        content_sha256: sha256(viewed.content),
        files,
      });
    }
    return skills;
  }

  private async invokeSkillView(name: string, filePath?: string): Promise<Record<string, unknown>> {
    return this.services.require(SKILLS_SERVICE, "Skills").viewSkill(name, filePath);
  }

  private async importBundle(
    params: Record<string, unknown>,
    approved = false,
  ): Promise<{
    scope: MetaScope;
    mode: "merge" | "replace";
    imported: boolean;
    dry_run?: boolean;
    skills: SkillImportSummary;
    required_skills?: { count: number; missing: string[] };
  }> {
    const bundle = parseRuntimeBundle(params.bundle);
    const scope =
      params.scope === "global" || params.scope === "workspace" || params.scope === "session"
        ? params.scope
        : "session";
    const mode = params.mode === "replace" ? "replace" : "merge";
    const importSkills = params.import_skills !== false;
    const skillScope: MetaScope =
      params.skill_scope === "workspace" || params.skill_scope === "global"
        ? params.skill_scope
        : "session";
    const skillOptions = {
      skillScope,
      skipExisting: params.skip_existing_skills !== false,
    };
    if (params.dry_run === true) {
      const skills = importSkills
        ? await this.planBundleSkillImport(bundle, skillOptions)
        : emptySkillImportSummary();
      const requiredSkillIds = this.requiredBundleSkillIds(bundle);
      const existingSkillIds = this.services.get(SKILLS_SERVICE)
        ? await this.listExistingSkillNames()
        : new Set<string>();
      const plannedSkillIds = new Set([...existingSkillIds, ...skills.created, ...skills.skipped]);
      const missing = [...requiredSkillIds].filter((skillId) => !plannedSkillIds.has(skillId));
      return {
        scope,
        mode,
        imported: false,
        dry_run: true,
        skills,
        required_skills: { count: requiredSkillIds.size, missing },
      };
    }
    if (scope !== "session" && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "import_bundle",
        reason: `Importing ${scope} runtime bundle writes persisted meta-runtime state.`,
        paramsPreview: JSON.stringify({
          scope,
          mode,
          profiles: bundle.state.profiles?.length ?? 0,
          agents: bundle.state.agents?.length ?? 0,
          skills: bundle.skills.length,
        }),
        dangerous: true,
        execute: () => this.importBundle(params, true),
      });
      throw createApprovalRequiredError(
        `Importing ${scope} runtime bundle requires approval via /approvals/${approvalId}.`,
      );
    }

    const skills = importSkills
      ? await this.importBundleSkills(bundle, skillOptions)
      : emptySkillImportSummary();
    if (skills.failed.length > 0) {
      throw new Error(
        `Runtime bundle skill import failed; topology was not imported. ${skills.failed
          .map((failure) => `${failure.name}: ${failure.reason}`)
          .join("; ")}`,
      );
    }
    await this.assertBundleSkillRequirementsSatisfied(bundle, params.import_skills === false);

    this.importState(scope, bundle.state, mode, true);
    this.recordEvent({
      kind: "bundle.imported",
      scope,
      summary: `Imported runtime bundle with ${bundle.skills.length} bundled skills.`,
      metadata: {
        bundle_scope: bundle.scope,
        skills_created: skills.created.length,
        skills_skipped: skills.skipped.length,
        skills_failed: skills.failed.length,
      },
    });
    this.persist(scope);
    this.server.refresh();
    return { scope, mode, imported: true, skills };
  }

  private async importBundleSkills(
    bundle: RuntimeBundle,
    options: { skillScope: MetaScope; skipExisting: boolean },
  ): Promise<SkillImportSummary> {
    const plan = await this.planBundleSkillImport(bundle, options);
    if (plan.failed.length > 0) {
      return plan;
    }
    const summary = emptySkillImportSummary();
    summary.skipped.push(...plan.skipped);
    summary.skippedFiles.push(...plan.skippedFiles);
    if (bundle.skills.length === 0) {
      return summary;
    }
    const skillsService = this.services.require(SKILLS_SERVICE, "Skills");
    const plannedCreates = new Set(plan.created);
    for (const skill of bundle.skills) {
      if (!plannedCreates.has(skill.name)) {
        continue;
      }
      try {
        await skillsService.manageSkill({
          operation: "create",
          name: skill.name,
          scope: options.skillScope,
          content: skill.content,
        });
      } catch (error) {
        summary.failed.push({
          name: skill.name,
          reason: error instanceof Error ? error.message : "Skill import failed.",
        });
        continue;
      }
      summary.created.push(skill.name);
      for (const file of skill.files) {
        if (options.skillScope === "session") {
          continue;
        }
        try {
          await skillsService.manageSkill({
            operation: "write_file",
            name: skill.name,
            scope: options.skillScope,
            file_path: file.path,
            file_content: file.content,
          });
        } catch (error) {
          summary.failed.push({
            name: skill.name,
            reason:
              error instanceof Error
                ? error.message
                : `Failed to import supporting file ${file.path}.`,
          });
        }
      }
    }
    return summary;
  }

  private async planBundleSkillImport(
    bundle: RuntimeBundle,
    options: { skillScope: MetaScope; skipExisting: boolean },
  ): Promise<SkillImportSummary> {
    const summary = emptySkillImportSummary();
    if (bundle.skills.length === 0) {
      return summary;
    }
    if (!this.services.get(SKILLS_SERVICE)) {
      for (const skill of bundle.skills) {
        summary.failed.push({
          name: skill.name,
          reason: "Cannot inspect or import bundled skills without an attached skills provider.",
        });
      }
      return summary;
    }
    const existing = await this.listExistingSkillNames();
    for (const skill of bundle.skills) {
      if (existing.has(skill.name)) {
        if (!options.skipExisting) {
          summary.failed.push({
            name: skill.name,
            reason: "Skill already exists; import_bundle does not overwrite existing skills.",
          });
          continue;
        }
        const mismatch = await this.describeExistingSkillMismatch(skill);
        if (mismatch) {
          summary.failed.push({ name: skill.name, reason: mismatch });
          continue;
        }
        summary.skipped.push(skill.name);
      } else {
        summary.created.push(skill.name);
      }
      if (options.skillScope === "session") {
        for (const file of skill.files) {
          summary.skippedFiles.push({
            name: skill.name,
            path: file.path,
            reason: "session skills do not have supporting-file storage",
          });
        }
      }
    }
    return summary;
  }

  private async describeExistingSkillMismatch(skill: RuntimeBundleSkill): Promise<string | null> {
    let viewed: Record<string, unknown>;
    try {
      viewed = await this.invokeSkillView(skill.name);
    } catch (error) {
      return `Existing skill could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (viewed.content !== skill.content) {
      return "Existing skill content differs from bundled content.";
    }
    for (const file of skill.files) {
      let supporting: Record<string, unknown>;
      try {
        supporting = await this.invokeSkillView(skill.name, file.path);
      } catch (error) {
        return `Existing skill supporting file ${file.path} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      if (supporting.content !== file.content) {
        return `Existing skill supporting file ${file.path} differs from bundled content.`;
      }
    }
    return null;
  }

  private async assertBundleSkillRequirementsSatisfied(
    bundle: RuntimeBundle,
    skippedImport: boolean,
  ): Promise<void> {
    const requiredSkillIds = this.requiredBundleSkillIds(bundle);
    if (requiredSkillIds.size === 0) {
      return;
    }
    if (!this.services.get(SKILLS_SERVICE)) {
      throw new Error(
        "Runtime bundle contains active skill versions, but no skills provider is attached; topology was not imported.",
      );
    }
    const existing = await this.listExistingSkillNames();
    const missing = [...requiredSkillIds].filter((skillId) => !existing.has(skillId));
    if (missing.length > 0) {
      throw new Error(
        `${
          skippedImport
            ? "Runtime bundle skill import was skipped"
            : "Runtime bundle skill import did not install all required skills"
        }; topology was not imported. Missing skills: ${missing.join(", ")}.`,
      );
    }
  }

  private requiredBundleSkillIds(bundle: RuntimeBundle): Set<string> {
    return new Set(
      (bundle.state.skillVersions ?? [])
        .filter((skillVersion) => skillVersion.active && skillVersion.activationStatus !== "failed")
        .map((skillVersion) => skillVersion.skillId),
    );
  }

  private async listExistingSkillNames(): Promise<Set<string>> {
    const service = this.services.get(SKILLS_SERVICE);
    if (!service) return new Set();
    const skills = await service.listSkills().catch(() => []);
    const names = new Set<string>();
    for (const skill of skills) {
      names.add(skill.name);
    }
    return names;
  }

  private recordEvent(event: Omit<MetaEvent, "id" | "createdAt">): void {
    const recorded = {
      id: `event-${crypto.randomUUID()}`,
      createdAt: now(),
      ...event,
    };
    this.events.push(recorded);
    this.events = this.events.slice(-200);
    this.publishEvent?.({
      kind: recorded.kind,
      providerId: "meta-runtime",
      eventId: recorded.id,
      scope: recorded.scope,
      summary: recorded.summary,
      metadata: recorded.metadata,
    });
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
    const requiresApproval = this.recomputeProposalApproval(proposal);
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
    if (requiresApproval && !approved) {
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
      this.services.get(SKILLS_SERVICE) ?? null,
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
    params: Record<string, unknown>,
    approved = false,
  ): Promise<TopologyExperiment> {
    return promoteTopologyExperiment(this.experimentContext(), params, approved);
  }

  private async markExperimentRolledBack(
    params: Record<string, unknown>,
    approved = false,
  ): Promise<TopologyExperiment> {
    return markTopologyExperimentRolledBack(this.experimentContext(), params, approved);
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

  private dispatchRoute(params: Record<string, unknown>) {
    const { source, message, envelope, fanout } = params;
    return dispatchMetaRuntimeRoute(
      {
        services: this.services,
        routes: listById(this.routes),
        agents: this.agents,
        profiles: this.profiles,
        channels: this.channels,
        capabilities: this.capabilities,
        executorBindings: this.executorBindings,
        skillVersions: this.skillVersions,
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
      proposeChange: (params) => this.proposeChange(params),
      dispatchRoute: (params) => this.dispatchRoute(params),
      createExperiment: (params) => this.createExperiment(params),
      recordEvaluation: (params) => this.recordEvaluation(params),
      promoteExperiment: (params) => this.promoteExperiment(params),
      rollbackExperiment: (params) => this.markExperimentRolledBack(params),
      archiveTopologyPattern: (params) => this.archiveTopologyPattern(params),
      proposeFromPattern: (params) => this.proposeFromPattern(params),
      exportState: (scope) => this.exportState(scope),
      importState: (scope, state, mode) => this.importState(scope, state, mode),
      exportBundle: (params) => this.exportBundle(params),
      importBundle: (params) => this.importBundle(params),
    });
  }

  private recomputeProposalApproval(proposal: Proposal): boolean {
    const requiresApproval = classifyApproval(proposal.scope, proposal.ops);
    if (proposal.requiresApproval !== requiresApproval) {
      proposal.requiresApproval = requiresApproval;
    }
    return requiresApproval;
  }
}

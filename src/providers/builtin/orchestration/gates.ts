import { debug } from "../../../core/debug";
import { describeGatePolicy, resolveGatePolicy } from "./gate-policy";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type { Gate, GatePolicy, GateResolver, GateStatus, GateType } from "./types";

export interface GatesDeps {
  repo: OrchestrationRepository;
  policy?: GatePolicy;
  refresh: () => void;
}

const POLICY_SLICE_GATE_REF = "policy:slice_gate:evidence_complete:v1";
const POLICY_GOAL_ACCEPT_REF = "policy:goal_accept:minor_revision:v1";
const POLICY_PLAN_ACCEPT_REF = "policy:plan_accept:same_spec_no_blockers:v1";

export type GateResolutionHandler = (gate: Gate) => void;
export type GateOpenHandler = (gate: Gate) => void;

export class GatesCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly policy: GatePolicy | undefined;
  private readonly refresh: () => void;
  private handler: GateResolutionHandler | undefined;
  private openHandler: GateOpenHandler | undefined;

  constructor(deps: GatesDeps) {
    this.repo = deps.repo;
    this.policy = deps.policy;
    this.refresh = deps.refresh;
  }

  setResolutionHandler(handler: GateResolutionHandler): void {
    this.handler = handler;
  }

  setOpenHandler(handler: GateOpenHandler): void {
    this.openHandler = handler;
  }

  openGate(params: {
    scope?: string;
    gate_type: GateType;
    resolver?: GateResolver;
    subject_ref: string;
    summary: string;
    evidence_refs?: string[];
  }): Gate {
    const existing = this.repo.findOpenGate(params.gate_type, params.subject_ref);
    if (existing) {
      return existing;
    }

    const resolver = this.resolverForGate(params);
    const timestamp = new Date().toISOString();
    const gate: Gate = {
      id: `gate-${crypto.randomUUID().slice(0, 8)}`,
      scope: params.scope ?? "session",
      gate_type: params.gate_type,
      status: "open",
      resolver,
      subject_ref: params.subject_ref,
      summary: params.summary,
      evidence_refs: params.evidence_refs ?? [],
      created_at: timestamp,
    };
    const version = this.repo.bumpGateVersion(gate.id);
    const created = { ...gate, version };
    this.repo.writeGate(created);
    debug("orchestration", "open_gate", {
      gateId: gate.id,
      gateType: gate.gate_type,
      subjectRef: gate.subject_ref,
      version,
    });
    const autoResolved = this.maybeAutoResolvePolicyGate(created);
    const opened = autoResolved ?? created;
    if (opened.status === "open") {
      this.openHandler?.(opened);
    }
    if (autoResolved) return autoResolved;
    this.refresh();
    return created;
  }

  describePolicy(): Record<string, unknown> {
    return describeGatePolicy(this.policy);
  }

  resolveGate(params: {
    gate_id: string;
    status: Exclude<GateStatus, "open">;
    resolution?: string;
    expected_version?: number;
    resolved_by?: GateResolver;
    resolution_policy_ref?: string;
    resolution_evidence_refs?: string[];
  }): Gate | { error: "version_conflict"; currentVersion: number } {
    const gate = this.repo.loadGate(params.gate_id);
    if (!gate) {
      throw new Error(`Unknown gate: ${params.gate_id}`);
    }
    const current = this.repo.gateVersion(params.gate_id);
    if (params.expected_version !== undefined && params.expected_version !== current) {
      return { error: "version_conflict", currentVersion: current };
    }
    if (gate.status !== "open") {
      return gate;
    }

    const version = this.repo.bumpGateVersion(gate.id);
    const next: Gate = {
      ...gate,
      status: params.status,
      resolved_at: new Date().toISOString(),
      resolution: params.resolution,
      resolved_by: params.resolved_by ?? "user",
      resolution_policy_ref: params.resolution_policy_ref,
      resolution_evidence_refs: params.resolution_evidence_refs,
      version,
    };
    this.repo.writeGate(next as Gate & { version: number });
    debug("orchestration", "resolve_gate", {
      gateId: gate.id,
      status: params.status,
      version,
    });

    if (params.status === "accepted" && this.handler) {
      try {
        this.handler(next);
      } catch (err) {
        const revertVersion = this.repo.bumpGateVersion(gate.id);
        this.repo.writeGate({ ...gate, version: revertVersion });
        debug("orchestration", "resolve_gate_revert", {
          gateId: gate.id,
          revertVersion,
        });
        this.refresh();
        throw err;
      }
    }

    this.refresh();
    return next;
  }

  private maybeAutoResolvePolicyGate(gate: Gate & { version: number }): Gate | null {
    if (gate.resolver !== "policy") {
      return null;
    }

    if (gate.gate_type === "slice_gate") {
      if (gate.evidence_refs.length === 0) {
        return null;
      }
      const resolved = this.resolveGate({
        gate_id: gate.id,
        status: "accepted",
        resolution: "Auto-accepted by policy after typed evidence covered every slice criterion.",
        expected_version: gate.version,
        resolved_by: "policy",
        resolution_policy_ref: POLICY_SLICE_GATE_REF,
        resolution_evidence_refs: gate.evidence_refs,
      });
      return "error" in resolved ? null : resolved;
    }

    if (gate.gate_type === "goal_accept" && this.isMinorGoalRevisionGate(gate.subject_ref)) {
      const resolved = this.resolveGate({
        gate_id: gate.id,
        status: "accepted",
        resolution: "Auto-accepted by policy for a minor goal revision.",
        expected_version: gate.version,
        resolved_by: "policy",
        resolution_policy_ref: POLICY_GOAL_ACCEPT_REF,
        resolution_evidence_refs: gate.evidence_refs,
      });
      return "error" in resolved ? null : resolved;
    }

    if (gate.gate_type === "plan_accept" && this.canPolicyAcceptPlanRevision(gate.subject_ref)) {
      const resolved = this.resolveGate({
        gate_id: gate.id,
        status: "accepted",
        resolution:
          "Auto-accepted by policy because the plan revision keeps the accepted spec version and no blocking drift or budget gate is open.",
        expected_version: gate.version,
        resolved_by: "policy",
        resolution_policy_ref: POLICY_PLAN_ACCEPT_REF,
        resolution_evidence_refs: gate.evidence_refs,
      });
      return "error" in resolved ? null : resolved;
    }

    return null;
  }

  private resolverForGate(params: {
    scope?: string;
    gate_type: GateType;
    resolver?: GateResolver;
    subject_ref: string;
  }): GateResolver {
    const resolved =
      params.resolver ??
      resolveGatePolicy({
        repo: this.repo,
        policy: this.policy,
        gate_type: params.gate_type,
        scope: params.scope,
        subject_ref: params.subject_ref,
      });

    if (resolved !== "policy") {
      return resolved;
    }
    if (params.gate_type === "goal_accept" && !this.isMinorGoalRevisionGate(params.subject_ref)) {
      return "user";
    }
    if (
      params.gate_type === "plan_accept" &&
      !this.canPolicyAcceptPlanRevision(params.subject_ref)
    ) {
      return "user";
    }
    return resolved;
  }

  private isMinorGoalRevisionGate(subjectRef: string): boolean {
    const match = /^goal:(.+):v(\d+)$/.exec(subjectRef);
    if (!match?.[1] || !match[2]) {
      return false;
    }
    const version = Number(match[2]);
    const revision = this.repo
      .loadGoalRevisions(match[1])
      .find((candidate) => candidate.version === version);
    return revision?.magnitude === "minor";
  }

  private canPolicyAcceptPlanRevision(subjectRef: string): boolean {
    const match = /^plan_revision:(.+)$/.exec(subjectRef);
    if (!match?.[1]) {
      return false;
    }
    const revision = this.repo.loadPlanRevision(match[1]);
    const plan = this.repo.loadPlan();
    if (
      !revision ||
      !plan ||
      plan.status !== "active" ||
      !plan.active_revision_id ||
      !revision.spec_id ||
      revision.spec_version === undefined ||
      revision.spec_id !== plan.spec_id ||
      revision.spec_version !== plan.spec_version
    ) {
      return false;
    }
    const activeRevision = this.repo.loadPlanRevision(plan.active_revision_id);
    if (activeRevision?.status !== "accepted") {
      return false;
    }
    if (
      this.repo
        .listGates()
        .some(
          (candidate) =>
            candidate.status === "open" &&
            (candidate.gate_type === "budget_exceeded" ||
              candidate.gate_type === "drift_escalation"),
        )
    ) {
      return false;
    }
    return !this.repo
      .listDriftEventsForPlan(plan)
      .some((event) => event.status === "open" && event.severity === "blocking");
  }

  markApplied(gateId: string): void {
    const gate = this.repo.loadGate(gateId);
    if (!gate || gate.applied_at) {
      return;
    }
    if (gate.status !== "accepted") {
      throw codedError("invalid_gate", `Gate ${gateId} is ${gate.status}, not accepted.`);
    }
    const version = this.repo.bumpGateVersion(gateId);
    this.repo.writeGate({
      ...gate,
      applied_at: new Date().toISOString(),
      version,
    });
  }
}

import { debug } from "../../../core/debug";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type { Handoff, HandoffKind, HandoffPriority, HandoffStatus } from "./types";

export interface HandoffsDeps {
  repo: OrchestrationRepository;
  refresh: () => void;
}

export class HandoffsCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly refresh: () => void;

  constructor(deps: HandoffsDeps) {
    this.repo = deps.repo;
    this.refresh = deps.refresh;
  }

  createHandoff(params: {
    from_task: string;
    to_task: string;
    request: string;
    kind?: HandoffKind;
    priority?: HandoffPriority;
    spec_refs?: string[];
    evidence_refs?: string[];
    blocks_task?: boolean;
  }): Handoff & { version: number } {
    const fromDefinition = this.repo.loadTaskDefinition(params.from_task);
    const toDefinition = this.repo.loadTaskDefinition(params.to_task);
    if (!fromDefinition) {
      throw new Error(`Unknown from_task: ${params.from_task}`);
    }
    if (!toDefinition) {
      throw new Error(`Unknown to_task: ${params.to_task}`);
    }
    const plan = this.repo.requireActivePlan();
    if (!this.repo.taskBelongsToPlan(fromDefinition, plan)) {
      throw new Error(`Unknown from_task: ${params.from_task}`);
    }
    if (!this.repo.taskBelongsToPlan(toDefinition, plan)) {
      throw new Error(`Unknown to_task: ${params.to_task}`);
    }
    const invalidEvidenceRefs = this.repo.invalidEvidenceRefs(params.evidence_refs ?? []);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }

    const id = `handoff-${crypto.randomUUID().slice(0, 8)}`;
    const handoff: Handoff = {
      id,
      ...(plan.id ? { plan_id: plan.id } : {}),
      from_task: params.from_task,
      to_task: params.to_task,
      kind: params.kind,
      priority: params.priority,
      request: params.request,
      spec_refs: params.spec_refs,
      evidence_refs: params.evidence_refs,
      blocks_task: params.blocks_task,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    const version = this.repo.bumpHandoffVersion(id);
    this.repo.writeHandoff({ ...handoff, version });
    debug("orchestration", "create_handoff", {
      id,
      from: params.from_task,
      to: params.to_task,
      version,
    });
    this.refresh();
    return { ...handoff, version };
  }

  respondHandoff(params: {
    handoff_id: string;
    response: string;
    decision_refs?: string[];
    evidence_refs?: string[];
    unblock?: boolean;
    expected_version?: number;
  }): { version: number; status: HandoffStatus } | { error: string; currentVersion: number } {
    const handoff = this.repo.loadHandoff(params.handoff_id);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${params.handoff_id}`);
    }
    const current = this.repo.handoffVersion(params.handoff_id);
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "handoff_version_conflict", {
        handoffId: params.handoff_id,
        expected: params.expected_version,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }
    if (handoff.status !== "pending") {
      throw new Error(`Handoff ${params.handoff_id} is already ${handoff.status}.`);
    }
    const invalidEvidenceRefs = this.repo.invalidEvidenceRefs(params.evidence_refs ?? []);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }
    const version = this.repo.bumpHandoffVersion(params.handoff_id);
    const updated: Handoff = {
      ...handoff,
      status: "responded",
      responded_at: new Date().toISOString(),
      response: params.response,
      decision_refs: params.decision_refs,
      response_evidence_refs: params.evidence_refs,
      unblock: params.unblock,
      version,
    };
    this.repo.writeHandoff(updated as Handoff & { version: number });
    this.refresh();
    return { version, status: updated.status };
  }

  cancelHandoff(params: {
    handoff_id: string;
    expected_version?: number;
  }): { version: number; status: HandoffStatus } | { error: string; currentVersion: number } {
    const handoff = this.repo.loadHandoff(params.handoff_id);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${params.handoff_id}`);
    }
    const current = this.repo.handoffVersion(params.handoff_id);
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "handoff_version_conflict", {
        handoffId: params.handoff_id,
        expected: params.expected_version,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }
    if (handoff.status !== "pending") {
      throw new Error(`Handoff ${params.handoff_id} is already ${handoff.status}.`);
    }
    const version = this.repo.bumpHandoffVersion(params.handoff_id);
    const updated: Handoff = {
      ...handoff,
      status: "cancelled",
      responded_at: new Date().toISOString(),
      version,
    };
    this.repo.writeHandoff(updated as Handoff & { version: number });
    this.refresh();
    return { version, status: updated.status };
  }
}

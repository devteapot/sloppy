import type { GatesCoordinator } from "./gates";
import type { OrchestrationRepository } from "./repository";
import { codedError } from "./storage";
import type { Gate, Goal, GoalRevision, GoalRevisionMagnitude, ProtocolMessage } from "./types";

export interface GoalsDeps {
  repo: OrchestrationRepository;
  gates: GatesCoordinator;
  refresh: () => void;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "goal";
}

function goalSubjectRef(goalId: string, version: number): string {
  return `goal:${goalId}:v${version}`;
}

function normalizeMagnitude(value: GoalRevisionMagnitude | undefined): GoalRevisionMagnitude {
  return value === "minor" ? "minor" : "material";
}

function normalizeEvidenceRefs(value: string[] | undefined): string[] {
  return [...new Set(value ?? [])].filter((item) => item.length > 0);
}

export class GoalsCoordinator {
  private readonly repo: OrchestrationRepository;
  private readonly gates: GatesCoordinator;
  private readonly refresh: () => void;

  constructor(deps: GoalsDeps) {
    this.repo = deps.repo;
    this.gates = deps.gates;
    this.refresh = deps.refresh;
  }

  createGoal(params: { title: string; intent: string; autonomous?: boolean }): Goal {
    const timestamp = new Date().toISOString();
    const id = `goal-${slugify(params.title)}-${crypto.randomUUID().slice(0, 6)}`;
    const goal: Goal = {
      id,
      status: "draft",
      title: params.title,
      intent: params.intent,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      autonomous: params.autonomous ? true : undefined,
    };
    this.repo.writeGoal(goal);
    this.repo.writeGoalRevision({
      goal_id: id,
      version: 1,
      title: params.title,
      intent: params.intent,
      magnitude: "material",
      reason: "Initial goal.",
      evidence_refs: [],
      created_at: timestamp,
    });
    this.refresh();
    return goal;
  }

  reviseGoal(params: {
    goal_id: string;
    title?: string;
    intent?: string;
    magnitude?: GoalRevisionMagnitude;
    reason?: string;
    evidence_refs?: string[];
  }): Goal {
    const goal = this.requireGoal(params.goal_id);
    if (goal.status === "archived") {
      throw codedError("invalid_goal_state", `Goal ${goal.id} is archived.`);
    }
    const timestamp = new Date().toISOString();
    const next: Goal = {
      ...goal,
      status: "draft",
      title: params.title ?? goal.title,
      intent: params.intent ?? goal.intent,
      version: goal.version + 1,
      updated_at: timestamp,
      accepted_at: undefined,
    };
    const revision: GoalRevision = {
      goal_id: next.id,
      version: next.version,
      title: next.title,
      intent: next.intent,
      magnitude: normalizeMagnitude(params.magnitude),
      reason: params.reason ?? "Goal revised.",
      evidence_refs: normalizeEvidenceRefs(params.evidence_refs),
      created_at: timestamp,
    };
    this.repo.writeGoal(next);
    this.repo.writeGoalRevision(revision);
    this.refresh();
    return next;
  }

  proposeGoalRevision(params: {
    goal_id: string;
    title?: string;
    intent?: string;
    magnitude: GoalRevisionMagnitude;
    reason: string;
    evidence_refs?: string[];
  }): {
    goal: Goal;
    revision: GoalRevision;
    message_id: string;
    gate_id: string;
    gate_status: Gate["status"];
    status: "accepted" | "gate_open";
  } {
    const goal = this.reviseGoal({
      goal_id: params.goal_id,
      title: params.title,
      intent: params.intent,
      magnitude: params.magnitude,
      reason: params.reason,
      evidence_refs: params.evidence_refs,
    });
    const revision = this.currentRevision(goal);
    const message = this.writeGoalRevisionMessage({ goal, revision });
    const gate = this.openGoalAcceptanceGate(goal, revision);
    const latestGoal = this.repo.loadGoal(goal.id) ?? goal;

    if (gate.status === "accepted") {
      this.resolveGoalRevisionMessage({
        message_id: message.id,
        gate,
        evidence_refs: revision.evidence_refs,
      });
    }

    this.refresh();
    return {
      goal: latestGoal,
      revision: this.currentRevision(latestGoal),
      message_id: message.id,
      gate_id: gate.id,
      gate_status: gate.status,
      status: gate.status === "accepted" ? "accepted" : "gate_open",
    };
  }

  requestGoalAcceptance(goalId: string): { goal: Goal; gate_id: string; status: "gate_open" } {
    const goal = this.requireGoal(goalId);
    if (goal.status === "archived") {
      throw codedError("invalid_goal_state", `Goal ${goal.id} is archived.`);
    }
    if (goal.status === "accepted") {
      return { goal, gate_id: "", status: "gate_open" };
    }
    const gate = this.openGoalAcceptanceGate(goal, this.currentRevision(goal));
    return { goal, gate_id: gate.id, status: "gate_open" };
  }

  acceptGoalFromGate(gate: Gate): Goal | null {
    if (gate.gate_type !== "goal_accept" || gate.applied_at) {
      return null;
    }
    const match = /^goal:(.+):v(\d+)$/.exec(gate.subject_ref);
    if (!match?.[1] || !match[2]) {
      return null;
    }
    const goal = this.repo.loadGoal(match[1]);
    const version = Number(match[2]);
    if (!goal || goal.version !== version) {
      return null;
    }
    if (goal.status === "accepted") {
      this.gates.markApplied(gate.id);
      return goal;
    }
    const timestamp = new Date().toISOString();
    const next: Goal = {
      ...goal,
      status: "accepted",
      updated_at: timestamp,
      accepted_at: timestamp,
    };
    this.repo.writeGoal(next);
    const revision = this.repo.loadGoalRevisions(goal.id).find((item) => item.version === version);
    if (revision) {
      this.repo.writeGoalRevision({ ...revision, accepted_at: timestamp });
    }
    this.gates.markApplied(gate.id);
    this.refresh();
    return next;
  }

  archiveGoal(goalId: string): { id: string; status: Goal["status"] } {
    const goal = this.requireGoal(goalId);
    const next: Goal = {
      ...goal,
      status: "archived",
      updated_at: new Date().toISOString(),
    };
    this.repo.writeGoal(next);
    this.refresh();
    return { id: next.id, status: next.status };
  }

  updateAutonomousLifecycle(params: {
    goal_id: string;
    stage: string;
    refs?: Record<string, string>;
  }): Goal {
    const goal = this.requireGoal(params.goal_id);
    const timestamp = new Date().toISOString();
    const next: Goal = {
      ...goal,
      updated_at: timestamp,
      autonomous_lifecycle: {
        stage: params.stage,
        updated_at: timestamp,
        refs: params.refs ?? {},
      },
    };
    this.repo.writeGoal(next);
    this.refresh();
    return next;
  }

  private requireGoal(goalId: string): Goal {
    const goal = this.repo.loadGoal(goalId);
    if (!goal) {
      throw new Error(`Unknown goal: ${goalId}`);
    }
    return goal;
  }

  private currentRevision(goal: Goal): GoalRevision {
    const revision = this.repo
      .loadGoalRevisions(goal.id)
      .find((item) => item.version === goal.version);
    return (
      revision ?? {
        goal_id: goal.id,
        version: goal.version,
        title: goal.title,
        intent: goal.intent,
        magnitude: "material",
        reason: "Goal revised.",
        evidence_refs: [],
        created_at: goal.updated_at,
        accepted_at: goal.accepted_at,
      }
    );
  }

  private openGoalAcceptanceGate(goal: Goal, revision: GoalRevision): Gate {
    return this.gates.openGate({
      scope: `goal:${goal.id}`,
      gate_type: "goal_accept",
      resolver: revision.magnitude === "material" ? "user" : undefined,
      subject_ref: goalSubjectRef(goal.id, goal.version),
      summary: `Accept ${revision.magnitude} goal revision "${goal.title}" version ${goal.version}.`,
      evidence_refs: revision.evidence_refs,
    });
  }

  private writeGoalRevisionMessage(params: {
    goal: Goal;
    revision: GoalRevision;
  }): ProtocolMessage {
    const timestamp = new Date().toISOString();
    const id = `msg-${crypto.randomUUID().slice(0, 8)}`;
    const message: ProtocolMessage = {
      id,
      kind: "GoalRevision",
      version: this.repo.bumpMessageVersion(id),
      from_role: "orchestrator",
      to_role: params.revision.magnitude === "minor" ? "resolver" : "user",
      artifact_refs: [goalSubjectRef(params.goal.id, params.goal.version)],
      evidence_refs: params.revision.evidence_refs,
      status: "open",
      summary: `Goal revision ${params.goal.id} v${params.goal.version} (${params.revision.magnitude}): ${params.revision.reason}`,
      body: params.revision.intent,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.repo.writeMessage(message);
    return message;
  }

  private resolveGoalRevisionMessage(params: {
    message_id: string;
    gate: Gate;
    evidence_refs: string[];
  }): void {
    const message = this.repo.loadMessage(params.message_id);
    if (!message || message.status !== "open") {
      return;
    }
    const timestamp = params.gate.resolved_at ?? new Date().toISOString();
    const version = this.repo.bumpMessageVersion(message.id);
    this.repo.writeMessage({
      ...message,
      status: "resolved",
      version,
      resolution: {
        decided_by: "policy",
        answer: params.gate.resolution ?? "Goal revision accepted by policy.",
        evidence_refs: params.evidence_refs,
        policy_ref: params.gate.resolution_policy_ref,
        resolved_at: timestamp,
      },
      updated_at: timestamp,
    });
  }
}

export { goalSubjectRef };

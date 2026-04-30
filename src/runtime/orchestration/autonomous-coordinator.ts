import type { SlopNode } from "@slop-ai/consumer/browser";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";

/**
 * Watches goal and gate state for autonomous goals, spawning spec-agent and
 * planner sub-agents at the appropriate gate boundaries:
 *
 *   goal.autonomous=true (status=draft) → spawn spec-agent
 *   spec_accept gate accepted (autonomous goal) → spawn planner
 *
 * The plan_accept gate's downstream effect (creating tasks, scheduler
 * dispatching executors) is already handled by the existing scheduler and
 * gates handler; this coordinator just triggers the upstream phases.
 */
export class AutonomousGoalCoordinator {
  private stops: Array<() => void> = [];
  private spawnedForGoal = new Set<string>(); // goal ids we've already spawned a spec-agent for
  private spawnedPlannerForSpec = new Set<string>(); // spec ids we've already spawned a planner for
  private latestGoals: Array<Record<string, unknown>> = [];
  private latestGates: Array<Record<string, unknown>> = [];
  private latestSpecs: Array<Record<string, unknown>> = [];

  constructor(
    private options: {
      hub: ProviderRuntimeHub;
      orchestrationProviderId?: string;
      delegationProviderId?: string;
      specProviderId?: string;
    },
  ) {}

  async start(): Promise<void> {
    const orchestrationId = this.options.orchestrationProviderId ?? "orchestration";
    const specId = this.options.specProviderId ?? "specs";

    this.stops.push(
      await this.options.hub.watchPath(orchestrationId, "/goals", (tree) => {
        this.latestGoals = childProps(tree);
        void this.evaluate();
      }),
    );
    this.stops.push(
      await this.options.hub.watchPath(orchestrationId, "/gates", (tree) => {
        this.latestGates = childProps(tree);
        void this.evaluate();
      }),
    );
    try {
      this.stops.push(
        await this.options.hub.watchPath(specId, "/specs", (tree) => {
          this.latestSpecs = childProps(tree);
          void this.evaluate();
        }),
      );
    } catch (err) {
      debug("autonomous", "spec_watch_skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    for (const stop of this.stops) {
      try {
        stop();
      } catch {
        // ignore
      }
    }
    this.stops = [];
  }

  private async evaluate(): Promise<void> {
    for (const goal of this.latestGoals) {
      const goalId = stringProp(goal, "id");
      if (!goalId) continue;
      if (goal.autonomous !== true) continue;
      const status = stringProp(goal, "status");
      if (status !== "draft") continue;
      if (this.spawnedForGoal.has(goalId)) continue;
      this.spawnedForGoal.add(goalId);
      await this.spawnSpecAgent(goalId, goal);
    }

    for (const gate of this.latestGates) {
      if (gate.gate_type !== "spec_accept") continue;
      if (gate.status !== "accepted") continue;
      const subjectRef = stringProp(gate, "subject_ref");
      if (!subjectRef) continue;
      const match = /^spec:(.+):v(\d+)$/.exec(subjectRef);
      if (!match) continue;
      const specId = match[1];
      const specVersion = Number(match[2]);
      if (this.spawnedPlannerForSpec.has(specId)) continue;
      const spec = this.latestSpecs.find((entry) => stringProp(entry, "id") === specId);
      if (!spec) continue;
      const goalId = stringProp(spec, "goal_id");
      if (!goalId) continue;
      const goal = this.latestGoals.find((entry) => stringProp(entry, "id") === goalId);
      if (!goal || goal.autonomous !== true) continue;
      this.spawnedPlannerForSpec.add(specId);
      await this.spawnPlanner(goalId, specId, specVersion, goal, spec);
    }
  }

  private async spawnSpecAgent(goalId: string, goal: Record<string, unknown>): Promise<void> {
    const delegationId = this.options.delegationProviderId ?? "delegation";
    const title = stringProp(goal, "title") ?? goalId;
    const intent = stringProp(goal, "intent") ?? "";
    const goalPrompt = [
      `# Goal: ${title}`,
      "",
      "## Intent",
      intent,
      "",
      "## Your task",
      "Author a spec for this goal via /specs affordances. Create the spec with goal_id set, add concrete acceptance criteria (prefer code over text), then return.",
    ].join("\n");
    const result = await this.options.hub.invoke(
      delegationId,
      "/session",
      "spawn_agent",
      {
        name: `spec-agent:${goalId}`,
        goal: goalPrompt,
        role: "spec-agent",
      },
      { actor: "autonomous-coordinator" },
    );
    debug("autonomous", "spawn_spec_agent", {
      goalId,
      status: result.status,
      error: result.error?.message,
    });
  }

  private async spawnPlanner(
    goalId: string,
    specId: string,
    specVersion: number,
    goal: Record<string, unknown>,
    spec: Record<string, unknown>,
  ): Promise<void> {
    const delegationId = this.options.delegationProviderId ?? "delegation";
    const title = stringProp(goal, "title") ?? goalId;
    const specBody = stringProp(spec, "body") ?? "";
    const plannerPrompt = [
      `# Goal: ${title}`,
      `# Spec: ${specId} (v${specVersion})`,
      "",
      "## Spec body",
      specBody,
      "",
      "## Your task",
      "Author a plan revision for this spec via /orchestration.create_plan_revision. Set goal_id, spec_id, spec_version, planned_commit, and provide a complete slice set. Each slice declares spec_refs, acceptance_criteria, and structural_assumptions.",
    ].join("\n");
    const result = await this.options.hub.invoke(
      delegationId,
      "/session",
      "spawn_agent",
      {
        name: `planner:${goalId}`,
        goal: plannerPrompt,
        role: "planner",
      },
      { actor: "autonomous-coordinator" },
    );
    debug("autonomous", "spawn_planner", {
      goalId,
      specId,
      specVersion,
      status: result.status,
      error: result.error?.message,
    });
  }
}

function childProps(tree: SlopNode | null): Array<Record<string, unknown>> {
  return (tree?.children ?? [])
    .map((child: SlopNode) => child.properties)
    .filter(
      (props: unknown): props is Record<string, unknown> =>
        props !== undefined && props !== null && typeof props === "object",
    );
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

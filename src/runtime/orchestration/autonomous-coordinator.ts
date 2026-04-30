import type { SlopNode } from "@slop-ai/consumer/browser";
import { debug } from "../../core/debug";
import type { ProviderRuntimeHub } from "../../core/hub";
import { BUILTIN_PROVIDER_IDS } from "../../providers/builtin/ids";

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
  private evaluateQueued = false;
  private evaluating = false;

  constructor(
    private options: {
      hub: ProviderRuntimeHub;
      orchestrationProviderId?: string;
      delegationProviderId?: string;
      specProviderId?: string;
    },
  ) {}

  async start(): Promise<void> {
    const orchestrationId = this.orchestrationProviderId();
    const specId = this.specProviderId();

    this.stops.push(
      await this.options.hub.watchPath(orchestrationId, "/goals", (tree) => {
        this.latestGoals = childProps(tree);
        this.queueEvaluate();
      }),
    );
    this.stops.push(
      await this.options.hub.watchPath(orchestrationId, "/gates", (tree) => {
        this.latestGates = childProps(tree);
        this.queueEvaluate();
      }),
    );
    try {
      this.stops.push(
        await this.options.hub.watchPath(specId, "/specs", (tree) => {
          this.latestSpecs = childProps(tree);
          this.queueEvaluate();
        }),
      );
    } catch (err) {
      debug("autonomous", "spec_watch_skipped", {
        providerId: specId,
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

  private queueEvaluate(): void {
    this.evaluateQueued = true;
    if (!this.evaluating) {
      void this.drainEvaluateQueue();
    }
  }

  private async drainEvaluateQueue(): Promise<void> {
    this.evaluating = true;
    try {
      while (this.evaluateQueued) {
        this.evaluateQueued = false;
        await this.evaluateOnce();
      }
    } finally {
      this.evaluating = false;
      if (this.evaluateQueued) {
        void this.drainEvaluateQueue();
      }
    }
  }

  private async evaluateOnce(): Promise<void> {
    const goals = [...this.latestGoals];
    const gates = [...this.latestGates];
    const specs = [...this.latestSpecs];

    for (const goal of goals) {
      const goalId = stringProp(goal, "id");
      if (!goalId) continue;
      if (goal.autonomous !== true) continue;
      const status = stringProp(goal, "status");
      if (status !== "draft") continue;
      if (this.spawnedForGoal.has(goalId)) continue;
      this.spawnedForGoal.add(goalId);
      await this.spawnSpecAgent(goalId, goal);
      await this.refreshGates();
      await this.refreshSpecs();
      this.queueEvaluate();
    }

    for (const gate of gates) {
      debug("autonomous", "evaluate_gate", {
        gateType: gate.gate_type,
        status: gate.status,
        subjectRef: gate.subject_ref,
        specs: specs.map((entry) => ({
          id: stringProp(entry, "id"),
          goalId: stringProp(entry, "goal_id"),
        })),
        goals: goals.map((entry) => ({
          id: stringProp(entry, "id"),
          autonomous: entry.autonomous,
          status: entry.status,
        })),
      });
      if (gate.gate_type !== "spec_accept") continue;
      if (gate.status !== "accepted") continue;
      await this.refreshSpecs();
      const subjectRef = stringProp(gate, "subject_ref");
      if (!subjectRef) continue;
      const match = /^spec:(.+):v(\d+)$/.exec(subjectRef);
      if (!match) continue;
      const specId = match[1];
      const acceptedGateVersion = Number(match[2]);
      if (this.spawnedPlannerForSpec.has(specId)) continue;
      let spec = this.latestSpecs.find((entry) => stringProp(entry, "id") === specId);
      if (!spec) {
        spec = await this.fetchSpec(specId);
      }
      if (!spec) continue;
      if (stringProp(spec, "status") !== "accepted") continue;
      const goalId = stringProp(spec, "goal_id");
      if (!goalId) continue;
      const goal = this.latestGoals.find((entry) => stringProp(entry, "id") === goalId);
      if (!goal || goal.autonomous !== true) continue;
      const acceptedSpecVersion = numberProp(spec, "version") ?? acceptedGateVersion;
      this.spawnedPlannerForSpec.add(specId);
      await this.spawnPlanner(goalId, specId, acceptedSpecVersion, goal, spec);
    }
  }

  private async refreshGates(): Promise<void> {
    const orchestrationId = this.orchestrationProviderId();
    try {
      const tree = await this.options.hub.queryState({
        providerId: orchestrationId,
        path: "/gates",
        depth: 1,
      });
      this.latestGates = childProps(tree);
    } catch (err) {
      debug("autonomous", "gate_refresh_skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async fetchSpec(specId: string): Promise<Record<string, unknown> | undefined> {
    const providerId = this.specProviderId();
    try {
      const tree = await this.options.hub.queryState({
        providerId,
        path: `/specs/${specId}`,
        depth: 1,
      });
      const props = tree?.properties;
      if (props !== undefined && props !== null && typeof props === "object") {
        return props as Record<string, unknown>;
      }
    } catch (err) {
      debug("autonomous", "spec_fetch_skipped", {
        providerId,
        specId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }

  private async refreshSpecs(): Promise<void> {
    const providerId = this.specProviderId();
    try {
      const tree = await this.options.hub.queryState({ providerId, path: "/specs", depth: 1 });
      this.latestSpecs = childProps(tree);
    } catch (err) {
      debug("autonomous", "spec_refresh_skipped", {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private orchestrationProviderId(): string {
    return this.options.orchestrationProviderId ?? BUILTIN_PROVIDER_IDS.orchestration;
  }

  private delegationProviderId(): string {
    return this.options.delegationProviderId ?? BUILTIN_PROVIDER_IDS.delegation;
  }

  private specProviderId(): string {
    return this.options.specProviderId ?? BUILTIN_PROVIDER_IDS.spec;
  }

  private async spawnSpecAgent(goalId: string, goal: Record<string, unknown>): Promise<void> {
    const delegationId = this.delegationProviderId();
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
    const delegationId = this.delegationProviderId();
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

function numberProp(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

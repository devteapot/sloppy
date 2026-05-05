import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import {
  OrchestrationProvider,
  type OrchestrationProviderOptions,
} from "../src/providers/builtin/orchestration";
import { SpecProvider } from "../src/providers/builtin/spec";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

async function orchestrationHarness(
  options: Omit<Partial<OrchestrationProviderOptions>, "workspaceRoot"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sloppy-docs12-orch-"));
  tempPaths.push(root);
  const provider = new OrchestrationProvider({
    workspaceRoot: root,
    sessionId: "docs12",
    ...options,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await consumer.connect();
  await consumer.subscribe("/", 4);
  return { root, provider, consumer };
}

async function writeBunTest(
  root: string,
  name: string,
  body = 'import { expect, test } from "bun:test";\n\ntest("passes", () => expect(true).toBe(true));\n',
) {
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests", name), body, "utf8");
}

function blobPath(root: string, ref: string | undefined): string {
  if (!ref?.startsWith("blob:")) {
    throw new Error(`Expected blob ref, got ${ref}`);
  }
  return join(root, ".sloppy", "orchestration", "blobs", `${ref.slice("blob:".length)}.txt`);
}

async function combinedHarness(
  options: Omit<Partial<OrchestrationProviderOptions>, "workspaceRoot"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sloppy-docs12-combined-"));
  tempPaths.push(root);
  const orchestration = new OrchestrationProvider({
    workspaceRoot: root,
    sessionId: "docs12",
    ...options,
  });
  const spec = new SpecProvider({ workspaceRoot: root });
  const orchestrationConsumer = new SlopConsumer(new InProcessTransport(orchestration.server));
  const specConsumer = new SlopConsumer(new InProcessTransport(spec.server));
  await orchestrationConsumer.connect();
  await specConsumer.connect();
  await orchestrationConsumer.subscribe("/", 4);
  await specConsumer.subscribe("/", 5);
  return { root, orchestration, orchestrationConsumer, spec, specConsumer };
}

function firstCriterionId(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

describe("docs/12 orchestration artifacts", () => {
  test("goal revisions are persisted and accepted through a goal gate", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      const created = await consumer.invoke("/goals", "create_goal", {
        title: "Ship importer",
        intent: "Import CSV files with validation.",
      });
      expect(created.status).toBe("ok");
      const goalId = (created.data as { id: string }).id;

      const revised = await consumer.invoke(`/goals/${goalId}`, "revise_goal", {
        intent: "Import CSV and TSV files with validation.",
      });
      expect(revised.status).toBe("ok");
      expect((revised.data as { version: number }).version).toBe(2);

      const acceptance = await consumer.invoke(`/goals/${goalId}`, "accept_goal", {});
      expect(acceptance.status).toBe("ok");
      const gateId = (acceptance.data as { gate_id: string }).gate_id;

      const resolved = await consumer.invoke(`/gates/${gateId}`, "resolve_gate", {
        status: "accepted",
        resolution: "Intent is clear.",
      });
      expect(resolved.status).toBe("ok");

      const goal = await consumer.query(`/goals/${goalId}`, 2);
      expect(goal.properties?.status).toBe("accepted");
      expect(goal.properties?.accepted_at).toBeString();
      expect(
        existsSync(join(root, ".sloppy", "orchestration", "goals", goalId, "revisions", "2.json")),
      ).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("minor goal revisions can policy-accept while material revisions force user gates", async () => {
    const { provider, consumer } = await orchestrationHarness({
      gatePolicy: { gates: { goal_accept: "policy" } },
    });
    try {
      const created = await consumer.invoke("/goals", "create_goal", {
        title: "Ship importer",
        intent: "Import CSV files with validation.",
      });
      expect(created.status).toBe("ok");
      const goalId = (created.data as { id: string }).id;

      const minor = await consumer.invoke(`/goals/${goalId}`, "propose_goal_revision", {
        intent: "Import CSV files with validation and clearer errors.",
        magnitude: "minor",
        reason: "Clarify the accepted error-reporting intent.",
        evidence_refs: ["docs/12-orchestration-design.md"],
      });
      expect(minor.status).toBe("ok");
      const minorData = minor.data as {
        gate_id: string;
        gate_status: string;
        status: string;
        message_id: string;
        revision: { magnitude: string; reason: string; evidence_refs: string[] };
      };
      expect(minorData.status).toBe("accepted");
      expect(minorData.gate_status).toBe("accepted");
      expect(minorData.revision).toEqual(
        expect.objectContaining({
          magnitude: "minor",
          reason: "Clarify the accepted error-reporting intent.",
          evidence_refs: ["docs/12-orchestration-design.md"],
        }),
      );

      const minorGate = await consumer.query(`/gates/${minorData.gate_id}`, 1);
      expect(minorGate.properties?.resolver).toBe("policy");
      expect(minorGate.properties?.resolved_by).toBe("policy");
      expect(minorGate.properties?.resolution_policy_ref).toBe(
        "policy:goal_accept:minor_revision:v1",
      );
      const minorMessage = await consumer.query(`/messages/${minorData.message_id}`, 1);
      expect(minorMessage.properties?.status).toBe("resolved");

      const material = await consumer.invoke(`/goals/${goalId}`, "propose_goal_revision", {
        intent: "Import CSV, TSV, and XLSX files with validation.",
        magnitude: "material",
        reason: "Expand the goal scope to new file formats.",
      });
      expect(material.status).toBe("ok");
      const materialData = material.data as {
        gate_id: string;
        gate_status: string;
        revision: { magnitude: string };
      };
      expect(materialData.gate_status).toBe("open");
      expect(materialData.revision.magnitude).toBe("material");

      const materialGate = await consumer.query(`/gates/${materialData.gate_id}`, 1);
      expect(materialGate.properties?.status).toBe("open");
      expect(materialGate.properties?.resolver).toBe("user");
    } finally {
      provider.stop();
    }
  });

  test("spec acceptance requires a spec_accept gate and plan execution rejects stale spec versions", async () => {
    const { orchestration, orchestrationConsumer, spec, specConsumer } = await combinedHarness();
    try {
      const created = await specConsumer.invoke("/specs", "create_spec", {
        title: "Importer spec",
        body: "# Importer spec",
        goal_id: "goal-importer",
        goal_version: 1,
      });
      expect(created.status).toBe("ok");
      const specId = (created.data as { id: string; version: number }).id;
      const initialVersion = (created.data as { version: number }).version;

      const gate = await orchestrationConsumer.invoke("/gates", "open_gate", {
        gate_type: "spec_accept",
        subject_ref: `spec:${specId}:v${initialVersion}`,
        summary: "Accept importer spec.",
      });
      expect(gate.status).toBe("ok");
      const gateId = (gate.data as { id: string }).id;
      await orchestrationConsumer.invoke(`/gates/${gateId}`, "resolve_gate", {
        status: "accepted",
      });

      const accepted = await specConsumer.invoke(`/specs/${specId}`, "accept_spec", {
        gate_id: gateId,
      });
      expect(accepted.status).toBe("ok");
      const acceptedVersion = (accepted.data as { version: number }).version;
      const specTree = await specConsumer.query(`/specs/${specId}`, 2);
      expect(specTree.properties?.status).toBe("accepted");
      expect(specTree.properties?.goal_id).toBe("goal-importer");

      const revision = await orchestrationConsumer.invoke(
        "/orchestration",
        "create_plan_revision",
        {
          query: "Implement importer",
          spec_id: specId,
          spec_version: acceptedVersion,
          slices: [
            {
              name: "parse",
              goal: "Implement parsing.",
              acceptance_criteria: ["Parser accepts CSV input"],
            },
          ],
        },
      );
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await orchestrationConsumer.invoke(`/gates/${planGateId}`, "resolve_gate", {
        status: "accepted",
      });

      const added = await specConsumer.invoke(`/specs/${specId}`, "add_requirement", {
        text: "Parser accepts TSV input.",
        criterion_kind: "text",
        verification_hint: "Add a TSV parser test.",
      });
      expect(added.status).toBe("ok");

      const tasks = await orchestrationConsumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      expect(taskId).toBeString();
      const schedule = await orchestrationConsumer.invoke(`/tasks/${taskId}`, "schedule", {});
      expect(schedule.status).toBe("error");
      expect(schedule.error?.code).toBe("stale_spec_version");
    } finally {
      orchestration.stop();
      spec.stop();
    }
  });

  test("plan policy auto-accepts same-spec revisions only without blocking gates", async () => {
    const { orchestration, orchestrationConsumer, spec, specConsumer } = await combinedHarness({
      gatePolicy: { gates: { plan_accept: "policy" } },
    });
    try {
      const created = await specConsumer.invoke("/specs", "create_spec", {
        title: "Importer spec",
        body: "# Importer spec",
      });
      const specId = (created.data as { id: string; version: number }).id;
      const specVersion = (created.data as { version: number }).version;
      const specGate = await orchestrationConsumer.invoke("/gates", "open_gate", {
        gate_type: "spec_accept",
        subject_ref: `spec:${specId}:v${specVersion}`,
        summary: "Accept importer spec.",
      });
      const specGateId = (specGate.data as { id: string }).id;
      await orchestrationConsumer.invoke(`/gates/${specGateId}`, "resolve_gate", {
        status: "accepted",
      });
      const accepted = await specConsumer.invoke(`/specs/${specId}`, "accept_spec", {
        gate_id: specGateId,
      });
      const acceptedSpecVersion = (accepted.data as { version: number }).version;

      const first = await orchestrationConsumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement importer",
        spec_id: specId,
        spec_version: acceptedSpecVersion,
        slices: [
          {
            name: "parse",
            goal: "Implement parsing.",
            acceptance_criteria: ["Parser accepts CSV input"],
          },
        ],
      });
      expect(first.status).toBe("ok");
      const firstGateId = (first.data as { gate_id: string }).gate_id;
      const firstGate = await orchestrationConsumer.query(`/gates/${firstGateId}`, 1);
      expect(firstGate.properties?.resolver).toBe("user");
      await orchestrationConsumer.invoke(`/gates/${firstGateId}`, "resolve_gate", {
        status: "accepted",
      });

      const second = await orchestrationConsumer.invoke("/orchestration", "create_plan_revision", {
        query: "Refine importer",
        spec_id: specId,
        spec_version: acceptedSpecVersion,
        slices: [
          {
            name: "docs",
            goal: "Document parser behavior.",
            acceptance_criteria: ["Docs mention CSV parsing"],
          },
        ],
      });
      expect(second.status).toBe("ok");
      const secondData = second.data as { id: string; gate_id: string; status: string };
      expect(secondData.status).toBe("accepted");
      const secondGate = await orchestrationConsumer.query(`/gates/${secondData.gate_id}`, 1);
      expect(secondGate.properties?.status).toBe("accepted");
      expect(secondGate.properties?.resolved_by).toBe("policy");
      expect(secondGate.properties?.resolution_policy_ref).toBe(
        "policy:plan_accept:same_spec_no_blockers:v1",
      );

      await orchestrationConsumer.invoke("/gates", "open_gate", {
        gate_type: "drift_escalation",
        subject_ref: "plan:blocking-drift",
        summary: "Blocking drift must be reviewed.",
      });
      const third = await orchestrationConsumer.invoke("/orchestration", "create_plan_revision", {
        query: "Refine importer again",
        spec_id: specId,
        spec_version: acceptedSpecVersion,
        slices: [
          {
            name: "tests",
            goal: "Add parser tests.",
            acceptance_criteria: ["Tests mention CSV parsing"],
          },
        ],
      });
      expect(third.status).toBe("ok");
      const thirdGateId = (third.data as { gate_id: string }).gate_id;
      const thirdGate = await orchestrationConsumer.query(`/gates/${thirdGateId}`, 1);
      expect(thirdGate.properties?.status).toBe("open");
      expect(thirdGate.properties?.resolver).toBe("user");
    } finally {
      orchestration.stop();
      spec.stop();
    }
  });

  test("HITL plan revision creates gated slices and final audit blocks plan completion until run", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      await writeBunTest(root, "parser.test.ts");
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        planned_commit: "HEAD",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      expect(taskId).toBeString();
      expect(criterionId).toBeString();

      const task = await consumer.query(`/tasks/${taskId}`, 1);
      const started = await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: task.properties?.version,
      });
      expect(started.status).toBe("ok");

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            output: "pass",
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
        risk: {
          files_modified: [],
          irreversible_actions: [],
          deps_added: [],
        },
      });
      expect(evidence.status).toBe("ok");
      const sliceGateId = (evidence.data as { gate_id: string }).gate_id;
      expect(sliceGateId).toBeString();

      const beforeGateComplete = await consumer.query(`/tasks/${taskId}`, 1);
      const blocked = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: beforeGateComplete.properties?.version,
      });
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("slice_gate_required");

      await consumer.invoke(`/gates/${sliceGateId}`, "resolve_gate", { status: "accepted" });
      const afterGate = await consumer.query(`/tasks/${taskId}`, 1);
      const completed = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: afterGate.properties?.version,
      });
      expect(completed.status).toBe("ok");

      const blockedPlan = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(blockedPlan.status).toBe("error");
      expect(blockedPlan.error?.code).toBe("final_audit_required");

      const audit = await consumer.invoke("/audit", "run_final_audit", {});
      expect(audit.status).toBe("ok");
      expect((audit.data as { status: string }).status).toBe("passed");
      const replayed = (audit.data as { replayed_checks: Array<{ output_ref?: string }> })
        .replayed_checks;
      expect(existsSync(blobPath(root, replayed[0]?.output_ref))).toBe(true);

      const completePlan = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(completePlan.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("policy-resolved slice gates auto-accept after typed evidence covers criteria", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      expect(taskId).toBeString();
      expect(criterionId).toBeString();
      expect(tasks.children?.[0]?.properties?.slice_gate_resolver).toBe("policy");

      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
      });
      expect(evidence.status).toBe("ok");
      const sliceGateId = (evidence.data as { gate_id: string }).gate_id;
      expect(sliceGateId).toBeString();

      const sliceGate = await consumer.query(`/gates/${sliceGateId}`, 1);
      expect(sliceGate.properties?.status).toBe("accepted");
      expect(sliceGate.properties?.resolver).toBe("policy");
      expect(sliceGate.properties?.resolved_by).toBe("policy");
      expect(sliceGate.properties?.resolution_policy_ref).toBe(
        "policy:slice_gate:evidence_complete:v1",
      );
      expect(sliceGate.properties?.resolution_evidence_refs).toContain("check-parser");

      const afterGate = await consumer.query(`/tasks/${taskId}`, 1);
      expect(afterGate.properties?.slice_gate_accepted).toBe(true);
      const completed = await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: afterGate.properties?.version,
      });
      expect(completed.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("goal-scoped gate policy defaults slice gates to policy resolution", async () => {
    const { provider, consumer } = await orchestrationHarness({
      gatePolicy: {
        gates: { slice_gate: "user" },
        goals: {
          "goal-importer": {
            gates: { slice_gate: "policy" },
          },
        },
      },
    });
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement importer",
        goal_id: "goal-importer",
        slices: [
          {
            name: "parser",
            goal: "Implement importer parsing.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      const root = await consumer.query("/orchestration", 1);
      expect(root.properties?.gate_policy).toEqual(
        expect.objectContaining({
          configured: true,
          goal_scope_count: 1,
        }),
      );

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      expect(taskId).toBeString();
      expect(criterionId).toBeString();

      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
      });
      expect(evidence.status).toBe("ok");

      const sliceGateId = (evidence.data as { gate_id: string }).gate_id;
      const sliceGate = await consumer.query(`/gates/${sliceGateId}`, 1);
      expect(sliceGate.properties?.status).toBe("accepted");
      expect(sliceGate.properties?.resolver).toBe("policy");
      expect(sliceGate.properties?.resolved_by).toBe("policy");
      expect(sliceGate.properties?.resolution_policy_ref).toBe(
        "policy:slice_gate:evidence_complete:v1",
      );
    } finally {
      provider.stop();
    }
  });

  test("typed digests summarize gates, policy resolutions, drift, and next slices", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
          {
            name: "docs",
            goal: "Document parser behavior.",
            depends_on: ["parser"],
            acceptance_criteria: ["Docs describe empty input behavior"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const parser = tasks.children?.find((child) => child.properties?.name === "parser");
      const taskId = parser?.id;
      const criterionId = firstCriterionId(parser?.properties?.acceptance_criteria);
      expect(taskId).toBeString();
      expect(criterionId).toBeString();

      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
      });
      expect(evidence.status).toBe("ok");

      const escalation = await consumer.invoke("/gates", "open_gate", {
        gate_type: "irreversible_action",
        subject_ref: "command:deploy",
        summary: "Deploy parser changes.",
      });
      expect(escalation.status).toBe("ok");

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const data = digest.data as {
        id: string;
        previous_digest_id?: string;
        status: string;
        headline: string[];
        actions: Array<{
          kind: string;
          target_ref: string;
          action_path: string;
          action_name: string;
          params: Record<string, unknown>;
        }>;
        delivery: {
          push_required: boolean;
          push_reasons: string[];
          delivery_id?: string;
        };
        sections: {
          escalations: Array<{ gate_type: string; subject_ref: string }>;
          auto_resolutions: { count: number; entries: Array<{ policy_ref?: string }> };
          drift_dashboard: { progress: { criteria_satisfied: number; criteria_total: number } };
          whats_next: { next_ready_slices: string[]; pending_gate_count: number };
        };
      };
      expect(data.status).toBe("blocked");
      expect(data.headline[0]).toContain("Implement parser");
      expect(data.sections.escalations).toContainEqual(
        expect.objectContaining({
          gate_type: "irreversible_action",
          subject_ref: "command:deploy",
        }),
      );
      expect(data.sections.auto_resolutions.count).toBe(1);
      expect(data.sections.auto_resolutions.entries[0]?.policy_ref).toBe(
        "policy:slice_gate:evidence_complete:v1",
      );
      expect(data.actions).toContainEqual(
        expect.objectContaining({
          kind: "accept_gate",
          target_ref: `gate:${(escalation.data as { id: string }).id}`,
          action_path: `/gates/${(escalation.data as { id: string }).id}`,
          action_name: "resolve_gate",
          params: { status: "accepted" },
        }),
      );
      expect(data.actions).toContainEqual(
        expect.objectContaining({
          kind: "cancel_plan",
          action_path: "/orchestration",
          action_name: "complete_plan",
        }),
      );
      expect(data.delivery.push_required).toBe(true);
      expect(data.delivery.push_reasons).toContain("escalation");
      expect(data.delivery.delivery_id).toBeString();
      expect(data.sections.drift_dashboard.progress.criteria_satisfied).toBe(1);
      expect(data.sections.drift_dashboard.progress.criteria_total).toBe(2);
      expect(data.sections.whats_next.pending_gate_count).toBeGreaterThanOrEqual(1);
      expect(data.sections.whats_next.next_ready_slices.length).toBe(0);
      expect(existsSync(join(root, ".sloppy", "orchestration", "digests", `${data.id}.json`))).toBe(
        true,
      );

      const digestCollection = await consumer.query("/digests", 2);
      expect(digestCollection.properties?.latest_digest_id).toBe(data.id);
      expect(digestCollection.properties?.pending_delivery_count).toBe(1);
      const storedDigest = digestCollection.children?.[0]?.properties as
        | { sections?: { auto_resolutions?: { count?: number } } }
        | undefined;
      expect(storedDigest?.sections?.auto_resolutions?.count).toBe(1);
      const delivered = await consumer.invoke("/digests", "mark_digest_delivery_delivered", {
        delivery_id: data.delivery.delivery_id,
      });
      expect(delivered.status).toBe("ok");
      expect((delivered.data as { status: string }).status).toBe("delivered");
      const afterDelivery = await consumer.query("/digests", 1);
      expect(afterDelivery.properties?.pending_delivery_count).toBe(0);

      const second = await consumer.invoke("/digests", "generate_digest", {});
      expect(second.status).toBe("ok");
      expect((second.data as { previous_digest_id?: string }).previous_digest_id).toBe(data.id);
    } finally {
      provider.stop();
    }
  });

  test("digest policy auto-generates escalation and status-change digests", async () => {
    const { provider, consumer } = await orchestrationHarness({
      digestPolicy: { cadence: "continuous" },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Watch gates",
      });
      const gate = await consumer.invoke("/gates", "open_gate", {
        gate_type: "irreversible_action",
        subject_ref: "command:deploy",
        summary: "Deploy parser changes.",
      });
      expect(gate.status).toBe("ok");

      const afterOpen = await consumer.query("/digests", 2);
      expect(afterOpen.properties?.count).toBe(1);
      const escalationDigest = afterOpen.children?.[0]?.properties as
        | { cadence?: string; trigger_reason?: string; cadence_source?: string; status?: string }
        | undefined;
      expect(escalationDigest).toEqual(
        expect.objectContaining({
          cadence: "continuous",
          trigger_reason: "escalation",
          cadence_source: "policy",
          status: "blocked",
        }),
      );

      const gateId = (gate.data as { id: string }).id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });

      const afterResolve = await consumer.query("/digests", 2);
      expect(afterResolve.properties?.count).toBe(2);
      const statusNode = afterResolve.children?.find(
        (child) => child.properties?.trigger_reason === "goal_status_change",
      );
      const statusDigest = statusNode?.properties as
        | {
            previous_digest_id?: string;
            cadence?: string;
            trigger_reason?: string;
            cadence_source?: string;
          }
        | undefined;
      expect(statusDigest).toEqual(
        expect.objectContaining({
          previous_digest_id: afterOpen.children?.[0]?.id,
          cadence: "continuous",
          trigger_reason: "goal_status_change",
          cadence_source: "policy",
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("plan completion emits a final digest even under manual digest policy", async () => {
    const { provider, consumer } = await orchestrationHarness({
      digestPolicy: { cadence: "manual" },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Finish plan",
      });
      const created = await consumer.invoke("/orchestration", "create_task", {
        name: "finish",
        goal: "Finish the work.",
      });
      const taskId = (created.data as { id: string }).id;
      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
        status: "not_required",
        summary: "No external check required.",
      });
      await consumer.invoke(`/tasks/${taskId}`, "complete", { result: "done" });

      const completed = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(completed.status).toBe("ok");

      const digests = await consumer.query("/digests", 2);
      expect(digests.properties?.count).toBe(1);
      expect(digests.children?.[0]?.properties).toEqual(
        expect.objectContaining({
          cadence: "final",
          trigger_reason: "final",
          cadence_source: "trigger",
          status: "completed",
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("digest push delivery dispatches pending records through configured transports", async () => {
    const delivered: Array<{ deliveryId: string; digestId: string; status: string }> = [];
    const { root, provider, consumer } = await orchestrationHarness({
      digestDeliveryChannel: "test",
      digestDeliveryTransports: [
        {
          channel: "test",
          deliver: async ({ delivery, digest }) => {
            delivered.push({
              deliveryId: delivery.id,
              digestId: digest.id,
              status: digest.status,
            });
            return { ok: true, external_ref: `test:${digest.id}` };
          },
        },
      ],
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Deliver digest",
      });
      const gate = await consumer.invoke("/gates", "open_gate", {
        gate_type: "irreversible_action",
        subject_ref: "command:deploy",
        summary: "Deploy parser changes.",
      });
      expect(gate.status).toBe("ok");

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const digestData = digest.data as { id: string; delivery: { delivery_id?: string } };
      expect(digestData.delivery.delivery_id).toBeString();

      const beforeDelivery = await consumer.query("/digests", 1);
      expect(beforeDelivery.properties?.pending_delivery_count).toBe(1);
      expect(beforeDelivery.properties?.delivery).toEqual(
        expect.objectContaining({
          default_channel: "test",
          configured_transport_channels: ["test"],
        }),
      );
      expect(
        (beforeDelivery.properties?.pending_deliveries as Array<{ channel?: string }>)[0]?.channel,
      ).toBe("test");

      const dispatched = await consumer.invoke("/digests", "deliver_pending_digests", {});
      expect(dispatched.status).toBe("ok");
      const dispatchData = dispatched.data as {
        attempted: number;
        delivered: number;
        failed: number;
        results: Array<{
          delivery_id: string;
          digest_id: string;
          status: string;
          external_ref?: string;
        }>;
      };
      expect(dispatchData.attempted).toBe(1);
      expect(dispatchData.delivered).toBe(1);
      expect(dispatchData.failed).toBe(0);
      expect(dispatchData.results[0]).toEqual(
        expect.objectContaining({
          digest_id: digestData.id,
          status: "delivered",
          external_ref: `test:${digestData.id}`,
        }),
      );
      expect(delivered).toEqual([
        {
          deliveryId: dispatchData.results[0]?.delivery_id,
          digestId: digestData.id,
          status: "blocked",
        },
      ]);

      const afterDelivery = await consumer.query("/digests", 1);
      expect(afterDelivery.properties?.pending_delivery_count).toBe(0);
      const persisted = readFileSync(
        join(
          root,
          ".sloppy",
          "orchestration",
          "digest-deliveries",
          `${dispatchData.results[0]?.delivery_id}.json`,
        ),
        "utf8",
      );
      expect(persisted).toContain(`test:${digestData.id}`);
      expect(persisted).toContain('"attempt_count": 1');
    } finally {
      provider.stop();
    }
  });

  test("digest transport failures are recorded and kept pending for retry", async () => {
    const { provider, consumer } = await orchestrationHarness({
      digestDeliveryChannel: "broken",
      digestDeliveryTransports: [
        {
          channel: "broken",
          deliver: () => ({ ok: false, error: "bridge unavailable" }),
        },
      ],
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Deliver digest",
      });
      const gate = await consumer.invoke("/gates", "open_gate", {
        gate_type: "irreversible_action",
        subject_ref: "command:deploy",
        summary: "Deploy parser changes.",
      });
      expect(gate.status).toBe("ok");

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");

      const dispatched = await consumer.invoke("/digests", "deliver_pending_digests", {});
      expect(dispatched.status).toBe("ok");
      const dispatchData = dispatched.data as {
        attempted: number;
        delivered: number;
        failed: number;
        results: Array<{ status: string; error?: string }>;
      };
      expect(dispatchData.attempted).toBe(1);
      expect(dispatchData.delivered).toBe(0);
      expect(dispatchData.failed).toBe(1);
      expect(dispatchData.results[0]).toEqual(
        expect.objectContaining({
          status: "pending",
          error: "bridge unavailable",
        }),
      );

      const afterFailure = await consumer.query("/digests", 1);
      expect(afterFailure.properties?.pending_delivery_count).toBe(1);
      expect(
        (
          afterFailure.properties?.pending_deliveries as Array<{
            attempt_count?: number;
            last_error?: string;
          }>
        )[0],
      ).toEqual(
        expect.objectContaining({
          attempt_count: 1,
          last_error: "bridge unavailable",
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("built-in Slack digest transport posts payloads and records delivery refs", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { provider, consumer } = await orchestrationHarness({
      digestDeliveryChannel: "slack",
      digestDeliverySlack: {
        webhookUrl: "https://hooks.example.test/sloppy",
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return new Response(JSON.stringify({ id: "slack-message-1" }), { status: 200 });
        },
      },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Deliver Slack digest",
      });
      await consumer.invoke("/gates", "open_gate", {
        gate_type: "irreversible_action",
        subject_ref: "command:deploy",
        summary: "Deploy parser changes.",
      });
      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");

      const dispatched = await consumer.invoke("/digests", "deliver_pending_digests", {});
      expect(dispatched.status).toBe("ok");
      const result = (
        dispatched.data as {
          results: Array<{ status: string; external_ref?: string }>;
        }
      ).results[0];
      expect(result).toEqual(
        expect.objectContaining({
          status: "delivered",
          external_ref: "slack-message-1",
        }),
      );
      expect(requests[0]?.url).toBe("https://hooks.example.test/sloppy");
      expect(String(requests[0]?.body.text)).toContain("Deliver Slack digest");
    } finally {
      provider.stop();
    }
  });

  test("built-in email digest transport records retryable failures", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const { provider, consumer } = await orchestrationHarness({
      digestDeliveryChannel: "email",
      digestDeliveryEmail: {
        endpointUrl: "https://email.example.test/send",
        from: "sloppy@example.test",
        to: ["ops@example.test"],
        apiKey: "test-key",
        fetch: async (_url, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return new Response("temporary outage", { status: 503 });
        },
      },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Deliver email digest",
      });
      await consumer.invoke("/gates", "open_gate", {
        gate_type: "irreversible_action",
        subject_ref: "command:deploy",
        summary: "Deploy parser changes.",
      });
      await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });

      const dispatched = await consumer.invoke("/digests", "deliver_pending_digests", {});
      expect(dispatched.status).toBe("ok");
      const result = (
        dispatched.data as {
          results: Array<{ status: string; error?: string }>;
        }
      ).results[0];
      expect(result).toEqual(
        expect.objectContaining({
          status: "pending",
          error: "temporary outage",
        }),
      );
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
      expect(requests[0]?.body).toEqual(
        expect.objectContaining({
          from: "sloppy@example.test",
          to: ["ops@example.test"],
        }),
      );

      const afterFailure = await consumer.query("/digests", 1);
      expect(
        (
          afterFailure.properties?.pending_deliveries as Array<{
            attempt_count?: number;
            last_error?: string;
          }>
        )[0],
      ).toEqual(
        expect.objectContaining({
          attempt_count: 1,
          last_error: "temporary outage",
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("configured wall-time budgets surface in digests and open budget gates", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        budget: { wall_time_ms: 1 },
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const data = digest.data as {
        status: string;
        sections: {
          escalations: Array<{ gate_id: string; gate_type: string; subject_ref: string }>;
          budget: {
            configured: boolean;
            exceeded: boolean;
            exceeded_limits: string[];
            wall_time_ms?: number;
            gate_id?: string;
          };
        };
      };
      expect(data.status).toBe("blocked");
      expect(data.sections.budget.configured).toBe(true);
      expect(data.sections.budget.exceeded).toBe(true);
      expect(data.sections.budget.exceeded_limits).toContain("wall_time_ms");
      expect(data.sections.budget.wall_time_ms).toBe(1);
      expect(data.sections.budget.gate_id).toBeString();
      expect(data.sections.escalations).toContainEqual(
        expect.objectContaining({
          gate_id: data.sections.budget.gate_id,
          gate_type: "budget_exceeded",
        }),
      );

      const root = await consumer.query("/orchestration", 1);
      const budget = root.properties?.budget as { configured?: boolean; exceeded?: boolean };
      expect(budget.configured).toBe(true);
      expect(budget.exceeded).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("retry budgets reject over-budget replacements and open budget gates", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Retry bounded work",
        budget: { retries_per_slice: 1 },
      });
      const original = await consumer.invoke("/orchestration", "create_task", {
        name: "parser",
        goal: "Implement parser.",
      });
      const originalId = (original.data as { id: string }).id;
      await consumer.invoke(`/tasks/${originalId}`, "start", {});
      await consumer.invoke(`/tasks/${originalId}`, "fail", { error: "first attempt failed" });

      const retry = await consumer.invoke("/orchestration", "create_task", {
        name: "parser-retry",
        goal: "Retry parser implementation.",
        retry_of: originalId,
      });
      expect(retry.status).toBe("ok");
      const retryId = (retry.data as { id: string }).id;
      const retryTask = await consumer.query(`/tasks/${retryId}`, 1);
      expect(retryTask.properties?.attempt_count).toBe(1);

      await consumer.invoke(`/tasks/${retryId}`, "start", {});
      await consumer.invoke(`/tasks/${retryId}`, "fail", { error: "second attempt failed" });

      const overBudget = await consumer.invoke("/orchestration", "create_task", {
        name: "parser-third",
        goal: "Retry parser implementation again.",
        retry_of: retryId,
      });
      expect(overBudget.status).toBe("error");
      expect(overBudget.error?.code).toBe("retry_budget_exceeded");

      const gates = await consumer.query("/gates", 2);
      const retryGate = gates.children?.find(
        (child) =>
          child.properties?.gate_type === "budget_exceeded" &&
          typeof child.properties?.subject_ref === "string" &&
          child.properties.subject_ref.includes("retries_per_slice"),
      );
      expect(retryGate?.properties?.status).toBe("open");

      const root = await consumer.query("/orchestration", 1);
      const budget = root.properties?.budget as {
        exceeded?: boolean;
        exceeded_limits?: string[];
        retries_per_slice?: number;
        retry_attempts_used?: number;
        retry_gate_id?: string;
      };
      expect(budget.exceeded).toBe(true);
      expect(budget.exceeded_limits).toContain("retries_per_slice");
      expect(budget.retries_per_slice).toBe(1);
      expect(budget.retry_attempts_used).toBe(1);
      expect(budget.retry_gate_id).toBe(retryGate?.id);

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const data = digest.data as {
        sections: {
          budget: { exceeded_limits: string[]; retry_gate_id?: string };
          escalations: Array<{ gate_id: string; gate_type: string }>;
        };
      };
      expect(data.sections.budget.exceeded_limits).toContain("retries_per_slice");
      expect(data.sections.budget.retry_gate_id).toBe(retryGate?.id);
      expect(data.sections.escalations).toContainEqual(
        expect.objectContaining({
          gate_id: retryGate?.id,
          gate_type: "budget_exceeded",
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("token and cost budgets record usage and open budget gates", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Budgeted model work",
        budget: { token_limit: 10, cost_usd: 0.05 },
      });

      const recorded = await consumer.invoke("/orchestration", "record_budget_usage", {
        source: "manual",
        model: "test-model",
        input_tokens: 8,
        output_tokens: 5,
        cost_usd: 0.07,
        evidence_refs: ["usage:test-model"],
      });
      expect(recorded.status).toBe("ok");
      const data = recorded.data as {
        usage: { id: string; total_tokens: number; cost_usd?: number };
        budget: {
          exceeded: boolean;
          exceeded_limits: string[];
          tokens_used?: number;
          cost_usd_used?: number;
          token_gate_id?: string;
          cost_gate_id?: string;
        };
      };
      expect(data.usage.total_tokens).toBe(13);
      expect(data.usage.cost_usd).toBe(0.07);
      expect(data.budget.exceeded).toBe(true);
      expect(data.budget.exceeded_limits).toContain("token_limit");
      expect(data.budget.exceeded_limits).toContain("cost_usd");
      expect(data.budget.tokens_used).toBe(13);
      expect(data.budget.cost_usd_used).toBe(0.07);
      expect(data.budget.token_gate_id).toBeString();
      expect(data.budget.cost_gate_id).toBeString();
      expect(
        existsSync(join(root, ".sloppy", "orchestration", "budget-usage", `${data.usage.id}.json`)),
      ).toBe(true);

      const rootState = await consumer.query("/orchestration", 1);
      const budget = rootState.properties?.budget as {
        token_limit?: number;
        tokens_used?: number;
        cost_usd?: number;
        cost_usd_used?: number;
      };
      expect(rootState.properties?.budget_usage_count).toBe(1);
      expect(budget.token_limit).toBe(10);
      expect(budget.tokens_used).toBe(13);
      expect(budget.cost_usd).toBe(0.05);
      expect(budget.cost_usd_used).toBe(0.07);

      const budgetState = await consumer.query("/budget", 2);
      expect(budgetState.properties?.usage_count).toBe(1);
      expect(budgetState.children?.[0]?.id).toBe(data.usage.id);
      expect(budgetState.children?.[0]?.properties?.model).toBe("test-model");

      const gates = await consumer.query("/gates", 2);
      const planId = rootState.properties?.plan_id;
      expect(planId).toBeString();
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "budget_exceeded" &&
            child.properties?.subject_ref === `plan:${planId}:budget:token_limit`,
        ),
      ).toBe(true);

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const digestData = digest.data as {
        actions: Array<{
          kind: string;
          action_path: string;
          action_name: string;
          params: Record<string, unknown>;
        }>;
        sections: {
          budget: {
            token_limit?: number;
            tokens_used?: number;
            token_gate_id?: string;
            cost_usd?: number;
            cost_usd_used?: number;
            cost_gate_id?: string;
          };
          escalations: Array<{ gate_id: string; gate_type: string }>;
        };
        source_refs: string[];
      };
      expect(digestData.sections.budget.token_limit).toBe(10);
      expect(digestData.sections.budget.tokens_used).toBe(13);
      expect(digestData.sections.budget.token_gate_id).toBe(data.budget.token_gate_id);
      expect(digestData.sections.budget.cost_usd).toBe(0.05);
      expect(digestData.sections.budget.cost_usd_used).toBe(0.07);
      expect(digestData.sections.budget.cost_gate_id).toBe(data.budget.cost_gate_id);
      expect(digestData.sections.escalations).toContainEqual(
        expect.objectContaining({
          gate_id: data.budget.token_gate_id,
          gate_type: "budget_exceeded",
        }),
      );
      expect(digestData.source_refs).toContain(`budget_usage:${data.usage.id}`);

      const raiseAction = digestData.actions.find((action) => action.kind === "raise_budget");
      expect(raiseAction).toEqual(
        expect.objectContaining({
          action_path: "/budget",
          action_name: "raise_budget_cap",
        }),
      );
      const raisedTokenLimit = raiseAction?.params.token_limit;
      const raisedCostUsd = raiseAction?.params.cost_usd;
      expect(raisedTokenLimit).toBeNumber();
      expect(raisedCostUsd).toBeNumber();
      expect(raisedTokenLimit as number).toBeGreaterThan(13);
      expect(raisedCostUsd as number).toBeGreaterThan(0.07);

      const raised = await consumer.invoke(
        raiseAction?.action_path ?? "/budget",
        raiseAction?.action_name ?? "raise_budget_cap",
        raiseAction?.params ?? {},
      );
      expect(raised.status).toBe("ok");
      const raisedData = raised.data as {
        budget: { exceeded: boolean; token_limit?: number; cost_usd?: number };
        resolved_gate_ids: string[];
      };
      expect(raisedData.budget.exceeded).toBe(false);
      expect(raisedData.budget.token_limit).toBe(raisedTokenLimit as number);
      expect(raisedData.budget.cost_usd).toBe(raisedCostUsd as number);
      expect(raisedData.resolved_gate_ids).toContain(data.budget.token_gate_id as string);
      expect(raisedData.resolved_gate_ids).toContain(data.budget.cost_gate_id as string);

      const afterRaise = await consumer.query("/orchestration", 1);
      const raisedBudget = afterRaise.properties?.budget as {
        exceeded?: boolean;
        token_limit?: number;
        cost_usd?: number;
      };
      expect(raisedBudget.exceeded).toBe(false);
      expect(raisedBudget.token_limit).toBe(raisedTokenLimit as number);
      expect(raisedBudget.cost_usd).toBe(raisedCostUsd as number);

      const lowered = await consumer.invoke("/budget", "raise_budget_cap", {
        token_limit: 5,
      });
      expect(lowered.status).toBe("error");
      expect(lowered.error?.code).toBe("budget_cap_not_raised");
    } finally {
      provider.stop();
    }
  });

  test("final audit replays allowlisted commands and blocks completion on failure", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      await writeBunTest(
        root,
        "parser.test.ts",
        'import { expect, test } from "bun:test";\n\ntest("fails", () => expect(false).toBe(true));\n',
      );
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
      });
      const sliceGateId = (evidence.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${sliceGateId}`, "resolve_gate", { status: "accepted" });
      const task = await consumer.query(`/tasks/${taskId}`, 1);
      await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: task.properties?.version,
      });

      const audit = await consumer.invoke("/audit", "run_final_audit", {});
      expect(audit.status).toBe("ok");
      const data = audit.data as {
        status: string;
        replayed_checks: Array<{
          actual_exit_code?: number | null;
          failure_reason?: string;
          output_ref?: string;
        }>;
      };
      expect(data.status).toBe("failed");
      expect(data.replayed_checks[0]?.actual_exit_code).not.toBe(0);
      expect(data.replayed_checks[0]?.failure_reason).toBe("nonzero_exit");
      expect(readFileSync(blobPath(root, data.replayed_checks[0]?.output_ref), "utf8")).toContain(
        "stderr:",
      );

      const completePlan = await consumer.invoke("/orchestration", "complete_plan", {
        status: "completed",
      });
      expect(completePlan.status).toBe("error");
      expect(completePlan.error?.code).toBe("final_audit_required");
    } finally {
      provider.stop();
    }
  });

  test("final audit fails unsupported replay commands without executing them", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            command: "echo should-not-run",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
      });
      const sliceGateId = (evidence.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${sliceGateId}`, "resolve_gate", { status: "accepted" });
      const task = await consumer.query(`/tasks/${taskId}`, 1);
      await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: task.properties?.version,
      });

      const audit = await consumer.invoke("/audit", "run_final_audit", {});
      expect(audit.status).toBe("ok");
      const check = (
        audit.data as {
          replayed_checks: Array<{
            actual_exit_code?: number | null;
            failure_reason?: string;
            output_ref?: string;
          }>;
        }
      ).replayed_checks[0];
      expect(check?.actual_exit_code).toBeNull();
      expect(check?.failure_reason).toBe("unsupported_command");
      expect(readFileSync(blobPath(root, check?.output_ref), "utf8")).toContain(
        "unsupported_command",
      );
    } finally {
      provider.stop();
    }
  });

  test("final audit times out long-running allowlisted commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-docs12-timeout-"));
    tempPaths.push(root);
    const provider = new OrchestrationProvider({
      workspaceRoot: root,
      sessionId: "docs12",
      finalAuditCommandTimeoutMs: 10,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));
    await consumer.connect();
    await consumer.subscribe("/", 4);
    try {
      await writeBunTest(
        root,
        "slow.test.ts",
        'import { expect, test } from "bun:test";\n\ntest("slow", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 200));\n  expect(true).toBe(true);\n});\n',
      );
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            command: "bun test tests/slow.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
      });
      const sliceGateId = (evidence.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${sliceGateId}`, "resolve_gate", { status: "accepted" });
      const task = await consumer.query(`/tasks/${taskId}`, 1);
      await consumer.invoke(`/tasks/${taskId}`, "complete", {
        result: "done",
        expected_version: task.properties?.version,
      });

      const audit = await consumer.invoke("/audit", "run_final_audit", {});
      expect(audit.status).toBe("ok");
      const check = (
        audit.data as {
          replayed_checks: Array<{
            actual_exit_code?: number | null;
            failure_reason?: string;
            output_ref?: string;
          }>;
        }
      ).replayed_checks[0];
      expect(check?.actual_exit_code).toBeNull();
      expect(check?.failure_reason).toBe("timeout");
      expect(readFileSync(blobPath(root, check?.output_ref), "utf8")).toContain("timed out");
    } finally {
      provider.stop();
    }
  });

  test("typed protocol messages enforce one-way role constraints", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const valid = await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "EscalationRequest",
        from_role: "executor",
        to_role: "planner",
        summary: "Slice is blocked.",
      });
      expect(valid.status).toBe("ok");

      const invalid = await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "executor",
        to_role: "spec-agent",
        summary: "Bypass planner.",
      });
      expect(invalid.status).toBe("error");
      expect(invalid.error?.code).toBe("invalid_message_direction");
    } finally {
      provider.stop();
    }
  });

  test("precedents structurally match, track use, and invalidate on spec revisions", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      const created = await consumer.invoke("/precedents", "create_precedent", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["3.2"],
        code_areas: ["src/runtime/orchestration"],
        question: "Where is slice gate evidence defined?",
        answer: "The slice gate evidence schema is defined in docs/12 section 3.2.",
        evidence_refs: ["docs/12-orchestration-design.md"],
      });
      expect(created.status).toBe("ok");
      const precedentId = (created.data as { id: string }).id;
      expect(existsSync(join(root, ".sloppy", "precedents", `${precedentId}.json`))).toBe(true);

      const matches = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["3.2"],
        code_areas: ["src/runtime/orchestration"],
        question: "Where is slice gate evidence defined?",
      });
      expect(matches.status).toBe("ok");
      const matchData = matches.data as {
        matches: Array<{ precedent_id: string; auto_resolvable: boolean; score: number }>;
      };
      expect(matchData.matches[0]?.precedent_id).toBe(precedentId);
      expect(matchData.matches[0]?.auto_resolvable).toBe(true);
      expect(matchData.matches[0]?.score).toBe(1);

      const precedent = await consumer.query(`/precedents/${precedentId}`, 1);
      const used = await consumer.invoke(`/precedents/${precedentId}`, "record_precedent_use", {
        expected_version: precedent.properties?.version,
      });
      expect(used.status).toBe("ok");
      expect((used.data as { use_count: number }).use_count).toBe(1);

      const invalidated = await consumer.invoke("/precedents", "invalidate_precedents", {
        spec_revision_id: "spec-revision-2",
        spec_sections_referenced: ["3.2"],
      });
      expect(invalidated.status).toBe("ok");
      expect(
        (invalidated.data as { invalidated_precedent_ids: string[] }).invalidated_precedent_ids,
      ).toContain(precedentId);

      const afterInvalidation = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["3.2"],
        code_areas: ["src/runtime/orchestration"],
        question: "Where is slice gate evidence defined?",
      });
      expect(afterInvalidation.status).toBe("ok");
      expect((afterInvalidation.data as { matches: unknown[] }).matches).toHaveLength(0);
    } finally {
      provider.stop();
    }
  });

  test("high-confidence precedents auto-resolve opted-in SpecQuestions", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const created = await consumer.invoke("/precedents", "create_precedent", {
        project_id: "sloppy",
        question_class: "inference",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        question: "Should retry slices inherit the original slice budget?",
        answer: "Retry slices inherit the logical slice retry budget.",
        reasoning: "Retry accounting is attached to the root logical slice.",
        evidence_refs: ["docs/12-orchestration-design.md"],
      });
      expect(created.status).toBe("ok");
      const precedentId = (created.data as { id: string }).id;

      const submitted = await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "planner",
        to_role: "spec-agent",
        summary: "Should retry slices inherit the original slice budget?",
        question_class: "inference",
        project_id: "sloppy",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        auto_resolve_with_precedent: true,
      });
      expect(submitted.status).toBe("ok");
      const message = submitted.data as {
        id: string;
        status: string;
        artifact_refs: string[];
        resolution?: {
          answer?: string;
          policy_ref?: string;
          precedent_id?: string;
          match_score?: number;
        };
      };
      expect(message.status).toBe("resolved");
      expect(message.resolution?.policy_ref).toBe("policy:spec_question:precedent_high_match:v1");
      expect(message.resolution?.precedent_id).toBe(precedentId);
      expect(message.resolution?.answer).toContain("logical slice retry budget");
      expect(message.resolution?.match_score).toBe(1);
      expect(message.artifact_refs).toContain(`precedent:${precedentId}`);

      const precedent = await consumer.query(`/precedents/${precedentId}`, 1);
      expect(precedent.properties?.use_count).toBe(1);
      expect(precedent.properties?.health).toEqual(
        expect.objectContaining({ matches_promoted: 1 }),
      );

      const messageState = await consumer.query(`/messages/${message.id}`, 1);
      expect(messageState.properties?.status).toBe("resolved");
      expect(messageState.properties?.spec_question).toEqual(
        expect.objectContaining({
          question_class: "inference",
          auto_resolve_with_precedent: true,
        }),
      );

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const digestData = digest.data as {
        sections: {
          auto_resolutions: {
            count: number;
            entries: Array<{
              message_id?: string;
              policy_ref?: string;
              precedent_id?: string;
            }>;
          };
        };
        source_refs: string[];
      };
      expect(digestData.sections.auto_resolutions.count).toBe(1);
      expect(digestData.sections.auto_resolutions.entries[0]).toEqual(
        expect.objectContaining({
          message_id: message.id,
          policy_ref: "policy:spec_question:precedent_high_match:v1",
          precedent_id: precedentId,
        }),
      );
      expect(digestData.source_refs).toContain(`message:${message.id}`);
      expect(digestData.source_refs).toContain(`precedent:${precedentId}`);
    } finally {
      provider.stop();
    }
  });

  test("borderline precedents can auto-resolve through a tie-break policy hook", async () => {
    const tieBreakBands: string[] = [];
    const { provider, consumer } = await orchestrationHarness({
      precedentTieBreaker: async (input) => {
        tieBreakBands.push(input.match.band);
        return {
          equivalent: true,
          reasoning: "The candidate question asks for the same retry budget inheritance rule.",
          evidence_refs: ["judge:test"],
        };
      },
    });
    try {
      const created = await consumer.invoke("/precedents", "create_precedent", {
        project_id: "sloppy",
        question_class: "inference",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        question: "Should retry slices inherit the original slice budget?",
        answer: "Retry slices inherit the logical slice retry budget.",
        reasoning: "Retry accounting is attached to the root logical slice.",
        evidence_refs: ["docs/12-orchestration-design.md"],
      });
      expect(created.status).toBe("ok");
      const precedentId = (created.data as { id: string }).id;

      const matches = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "inference",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        question: "Should retry slices inherit slice budget?",
      });
      expect(matches.status).toBe("ok");
      const match = (
        matches.data as {
          matches: Array<{ precedent_id: string; band: string; auto_resolvable: boolean }>;
        }
      ).matches[0];
      expect(match).toEqual(
        expect.objectContaining({
          precedent_id: precedentId,
          band: "borderline",
          auto_resolvable: false,
        }),
      );

      const submitted = await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "planner",
        to_role: "spec-agent",
        summary: "Should retry slices inherit slice budget?",
        question_class: "inference",
        project_id: "sloppy",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        auto_resolve_with_precedent: true,
      });
      expect(submitted.status).toBe("ok");
      const message = submitted.data as {
        status: string;
        resolution?: {
          evidence_refs?: string[];
          match_band?: string;
          policy_ref?: string;
          precedent_id?: string;
          reasoning?: string;
        };
      };
      expect(tieBreakBands).toEqual(["borderline"]);
      expect(message.status).toBe("resolved");
      expect(message.resolution).toEqual(
        expect.objectContaining({
          policy_ref: "policy:spec_question:precedent_borderline_tiebreak:v1",
          precedent_id: precedentId,
          match_band: "borderline",
          reasoning: "The candidate question asks for the same retry budget inheritance rule.",
        }),
      );
      expect(message.resolution?.evidence_refs).toContain("docs/12-orchestration-design.md");
      expect(message.resolution?.evidence_refs).toContain("judge:test");

      const precedent = await consumer.query(`/precedents/${precedentId}`, 1);
      expect(precedent.properties?.use_count).toBe(1);
      expect(precedent.properties?.health).toEqual(
        expect.objectContaining({ matches_promoted: 1 }),
      );
    } finally {
      provider.stop();
    }
  });

  test("embedding-backed precedents produce high, borderline, and low match bands", async () => {
    const embeddingFor = (question: string): number[] | undefined => {
      switch (question) {
        case "How should frozen spec snapshots be cached?":
          return [1, 0, 0];
        case "Can memoized immutable spec views use that cache?":
          return [0.98, 0.1, 0];
        case "Is this cache rule similar enough for generated views?":
          return [0.7, 0.7, 0];
        case "Should dashboard colors change?":
          return [0, 1, 0];
        default:
          return undefined;
      }
    };
    const { provider, consumer } = await orchestrationHarness({
      precedentEmbeddingProvider: ({ question }) => embeddingFor(question),
    });
    try {
      const created = await consumer.invoke("/precedents", "create_precedent", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["spec.snapshots"],
        code_areas: ["src/providers/builtin/spec.ts"],
        question: "How should frozen spec snapshots be cached?",
        answer: "Use immutable version snapshots keyed by spec id and version.",
      });
      expect(created.status).toBe("ok");
      const precedentId = (created.data as { id: string }).id;
      expect((created.data as { question: { embedding?: number[] } }).question.embedding).toEqual([
        1, 0, 0,
      ]);

      const high = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["spec.snapshots"],
        code_areas: ["src/providers/builtin/spec.ts"],
        question: "Can memoized immutable spec views use that cache?",
      });
      const highMatch = (
        high.data as {
          matches: Array<{
            precedent_id: string;
            band: string;
            auto_resolvable: boolean;
            score_source?: string;
          }>;
        }
      ).matches[0];
      expect(highMatch).toEqual(
        expect.objectContaining({
          precedent_id: precedentId,
          band: "high",
          auto_resolvable: true,
          score_source: "embedding",
        }),
      );

      const borderline = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["spec.snapshots"],
        code_areas: ["src/providers/builtin/spec.ts"],
        question: "Is this cache rule similar enough for generated views?",
      });
      expect(
        (
          borderline.data as {
            matches: Array<{ band: string; auto_resolvable: boolean; score_source?: string }>;
          }
        ).matches[0],
      ).toEqual(
        expect.objectContaining({
          band: "borderline",
          auto_resolvable: false,
          score_source: "embedding",
        }),
      );

      const low = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["spec.snapshots"],
        code_areas: ["src/providers/builtin/spec.ts"],
        question: "Should dashboard colors change?",
      });
      expect(
        (low.data as { matches: Array<{ band: string; score_source?: string }> }).matches[0],
      ).toEqual(
        expect.objectContaining({
          band: "low",
          score_source: "embedding",
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("precedent matching falls back to lexical scoring for older records without embeddings", async () => {
    const { provider, consumer } = await orchestrationHarness({
      precedentEmbeddingProvider: ({ question }) =>
        question === "Where is slice gate evidence defined?" ? undefined : [1, 0, 0],
    });
    try {
      const created = await consumer.invoke("/precedents", "create_precedent", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["3.2"],
        code_areas: ["src/runtime/orchestration"],
        question: "Where is slice gate evidence defined?",
        answer: "The slice gate evidence schema is defined in docs/12 section 3.2.",
      });
      expect(created.status).toBe("ok");
      expect((created.data as { question: { embedding?: number[] } }).question.embedding).toBe(
        undefined,
      );

      const matches = await consumer.invoke("/precedents", "find_precedent_matches", {
        project_id: "sloppy",
        question_class: "lookup",
        spec_sections_referenced: ["3.2"],
        code_areas: ["src/runtime/orchestration"],
        question: "Where is slice gate evidence defined?",
      });
      expect(
        (
          matches.data as {
            matches: Array<{ score: number; score_source?: string; auto_resolvable: boolean }>;
          }
        ).matches[0],
      ).toEqual(
        expect.objectContaining({
          score: 1,
          score_source: "lexical",
          auto_resolvable: true,
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("borderline tie-break rejection records an escalation attempt without resolving", async () => {
    const { provider, consumer } = await orchestrationHarness({
      precedentTieBreaker: () => ({
        equivalent: false,
        reasoning: "The new question changes the retry ownership rule.",
        evidence_refs: ["judge:reject"],
        policy_ref: "policy:test:reject",
      }),
    });
    try {
      const created = await consumer.invoke("/precedents", "create_precedent", {
        project_id: "sloppy",
        question_class: "inference",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        question: "Should retry slices inherit the original slice budget?",
        answer: "Retry slices inherit the logical slice retry budget.",
      });
      const precedentId = (created.data as { id: string }).id;

      const submitted = await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "planner",
        to_role: "spec-agent",
        summary: "Should retry slices inherit slice budget?",
        question_class: "inference",
        project_id: "sloppy",
        spec_sections_referenced: ["planner.assumptions"],
        code_areas: ["src/runtime/orchestration"],
        auto_resolve_with_precedent: true,
      });
      expect(submitted.status).toBe("ok");
      const message = submitted.data as {
        status: string;
        artifact_refs: string[];
        spec_question?: {
          precedent_resolution_attempt?: {
            decision?: string;
            precedent_id?: string;
            policy_ref?: string;
            reasoning?: string;
            match_band?: string;
          };
        };
      };
      expect(message.status).toBe("open");
      expect(message.artifact_refs).toContain(`precedent:${precedentId}`);
      expect(message.spec_question?.precedent_resolution_attempt).toEqual(
        expect.objectContaining({
          decision: "escalated",
          precedent_id: precedentId,
          policy_ref: "policy:test:reject",
          reasoning: "The new question changes the retry ownership rule.",
          match_band: "borderline",
        }),
      );

      const precedent = await consumer.query(`/precedents/${precedentId}`, 1);
      expect(precedent.properties?.health).toEqual(
        expect.objectContaining({ matches_escalated_anyway: 1 }),
      );
    } finally {
      provider.stop();
    }
  });

  test("case records are guidance only and judgment questions cannot become precedents", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      const invalid = await consumer.invoke("/precedents", "create_precedent", {
        question_class: "judgment",
        spec_sections_referenced: ["UX"],
        code_areas: ["apps/dashboard"],
        question: "Should this interaction be modal?",
        answer: "Use the existing inline pattern.",
      });
      expect(invalid.status).toBe("error");
      expect(invalid.error?.code).toBe("invalid_params");

      const created = await consumer.invoke("/precedents", "create_case_record", {
        project_id: "sloppy",
        question_class: "judgment",
        spec_sections_referenced: ["UX"],
        code_areas: ["apps/dashboard"],
        question: "Should this interaction be modal?",
        answer:
          "Use the existing inline pattern unless the user is confirming a destructive action.",
      });
      expect(created.status).toBe("ok");
      const caseId = (created.data as { id: string }).id;
      expect(existsSync(join(root, ".sloppy", "precedents", "cases", `${caseId}.json`))).toBe(true);

      const matches = await consumer.invoke("/precedents", "find_case_record_matches", {
        project_id: "sloppy",
        question_class: "judgment",
        spec_sections_referenced: ["UX"],
        code_areas: ["apps/dashboard"],
        question: "Should this interaction be modal?",
      });
      expect(matches.status).toBe("ok");
      expect((matches.data as { matches: Array<{ case_record_id: string }> }).matches[0]).toEqual(
        expect.objectContaining({ case_record_id: caseId }),
      );

      const rootState = await consumer.query("/orchestration", 1);
      expect(rootState.properties?.precedent_counts).toEqual(
        expect.objectContaining({
          total: 0,
          case_records: 1,
        }),
      );
    } finally {
      provider.stop();
    }
  });

  test("irreversible actions and blast-radius violations persist drift and force user gates", async () => {
    const { root, provider, consumer } = await orchestrationHarness({
      guardrails: {
        blast_radius: { max_files_modified: 1 },
      },
    });
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "parser.ts"), "export const parser = true;\n", "utf8");
      await writeFile(join(root, "src", "tokens.ts"), "export const tokens = true;\n", "utf8");

      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
        risk: {
          files_modified: ["src/parser.ts", "src/tokens.ts"],
          irreversible_actions: ["deploy-production"],
          deps_added: [],
        },
      });
      expect(evidence.status).toBe("ok");
      const data = evidence.data as {
        gate_id?: string;
        gate_ids: string[];
        drift_event_ids: string[];
      };
      expect(data.gate_ids.length).toBeGreaterThanOrEqual(3);
      expect(data.drift_event_ids.length).toBeGreaterThanOrEqual(2);

      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "irreversible_action" &&
            child.properties?.status === "open",
        ),
      ).toBe(true);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "drift_escalation" &&
            child.properties?.subject_ref === `slice:${taskId}:guardrail:blast_radius`,
        ),
      ).toBe(true);
      const sliceGate = gates.children?.find(
        (child) => child.properties?.gate_type === "slice_gate",
      );
      expect(sliceGate?.properties?.status).toBe("open");
      expect(sliceGate?.properties?.resolver).toBe("user");

      const drift = await consumer.query("/drift", 2);
      expect(drift.properties?.blocking_open).toBeGreaterThanOrEqual(2);
      expect(drift.children?.map((child) => child.properties?.kind)).toContain(
        "blast_radius_violation",
      );
      expect(drift.children?.map((child) => child.properties?.kind)).toContain(
        "irreversible_action_declared",
      );
    } finally {
      provider.stop();
    }
  });

  test("external-call blast-radius caps open drift escalation gates", async () => {
    const { provider, consumer } = await orchestrationHarness({
      guardrails: {
        blast_radius: { max_external_calls: 1 },
      },
    });
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Integrate remote service",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "remote",
            goal: "Call the remote service.",
            acceptance_criteria: ["Remote service response is handled"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-remote",
            type: "test",
            command: "bun test tests/remote.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-remote"],
            kind: "replayable",
          },
        ],
        risk: {
          files_modified: [],
          irreversible_actions: [],
          deps_added: [],
          external_calls: ["api.example.com/auth", "api.example.com/import"],
        },
      });
      expect(evidence.status).toBe("ok");

      const drift = await consumer.query("/drift", 2);
      const blast = drift.children?.find(
        (child) => child.properties?.kind === "blast_radius_violation",
      );
      expect(blast).toBeDefined();
      expect(blast?.properties?.metrics).toEqual(
        expect.objectContaining({
          external_calls: 2,
          max_external_calls: 1,
        }),
      );

      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "drift_escalation" &&
            child.properties?.subject_ref === `slice:${taskId}:guardrail:blast_radius`,
        ),
      ).toBe(true);

      const verifications = await consumer.invoke(`/tasks/${taskId}`, "get_verifications", {});
      expect(verifications.status).toBe("ok");
      const claim = (verifications.data as { evidence_claims: Array<{ risk?: unknown }> })
        .evidence_claims[0] as { risk?: { external_calls?: string[] } } | undefined;
      expect(claim?.risk?.external_calls).toEqual([
        "api.example.com/auth",
        "api.example.com/import",
      ]);
    } finally {
      provider.stop();
    }
  });

  test("evidence regression opens a blocking drift escalation", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser-pass",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser-pass"],
            kind: "replayable",
          },
        ],
      });

      const regression = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser-fail",
            command: "bun test tests/parser.test.ts",
            exit_code: 1,
            verification: "replayable",
          },
        ],
      });
      expect(regression.status).toBe("ok");
      const data = regression.data as { drift_event_ids: string[] };
      expect(data.drift_event_ids.length).toBe(1);

      const drift = await consumer.query("/drift", 2);
      expect(drift.children?.[0]?.properties?.kind).toBe("evidence_regression");
      expect(drift.children?.[0]?.properties?.severity).toBe("blocking");
      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "drift_escalation" &&
            child.properties?.subject_ref === `slice:${taskId}:drift:evidence_regression`,
        ),
      ).toBe(true);
      const regressionGate = gates.children?.find(
        (child) =>
          child.properties?.gate_type === "drift_escalation" &&
          child.properties?.subject_ref === `slice:${taskId}:drift:evidence_regression`,
      );
      expect(regressionGate).toBeDefined();
      expect(regressionGate?.properties?.scope).toMatch(/^plan:/);

      const followup = await consumer.invoke("/orchestration", "create_task", {
        name: "follow-up",
        goal: "Should wait while evidence regression is unresolved.",
      });
      const followupId = (followup.data as { id: string }).id;
      const blocked = await consumer.invoke(`/tasks/${followupId}`, "start", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("plan_halted");

      await consumer.invoke(`/gates/${regressionGate?.id as string}`, "resolve_gate", {
        status: "accepted",
      });
      const unblocked = await consumer.invoke(`/tasks/${followupId}`, "start", {});
      expect(unblocked.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("repeated same-class failures create a planner drift escalation", async () => {
    const { provider, consumer } = await orchestrationHarness({
      guardrails: { repeated_failure_limit: 2 },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Retry parser",
      });
      const original = await consumer.invoke("/orchestration", "create_task", {
        name: "parser",
        goal: "Implement parser.",
      });
      const originalId = (original.data as { id: string }).id;
      await consumer.invoke(`/tasks/${originalId}`, "start", {});
      await consumer.invoke(`/tasks/${originalId}`, "fail", { error: "test: parser failed" });

      const retry = await consumer.invoke("/orchestration", "create_task", {
        name: "parser retry",
        goal: "Retry parser.",
        retry_of: originalId,
      });
      const retryId = (retry.data as { id: string }).id;
      await consumer.invoke(`/tasks/${retryId}`, "start", {});
      await consumer.invoke(`/tasks/${retryId}`, "fail", { error: "test: parser still failed" });

      const drift = await consumer.query("/drift", 2);
      expect(drift.children?.[0]?.properties?.kind).toBe("repeated_failure");
      expect(drift.children?.[0]?.properties?.severity).toBe("blocking");
      expect(drift.children?.[0]?.properties?.metrics).toEqual(
        expect.objectContaining({
          failure_class: "test",
          attempts: 2,
          limit: 2,
        }),
      );

      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "drift_escalation" &&
            typeof child.properties?.subject_ref === "string" &&
            child.properties.subject_ref.includes("repeated_failure:test"),
        ),
      ).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("progress drift metrics distinguish improvement from stalled criteria distance", async () => {
    const { provider, consumer } = await orchestrationHarness({
      guardrails: { progress_stall_limit: 1 },
    });
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });

      const baseline = await consumer.invoke("/digests", "generate_digest", {});
      expect(baseline.status).toBe("ok");
      expect(
        (baseline.data as { sections: { drift_dashboard: { recent_events: unknown[] } } }).sections
          .drift_dashboard.recent_events,
      ).not.toContainEqual(expect.objectContaining({ kind: "progress_drift" }));

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});
      await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        observations: [
          {
            id: "obs-parser",
            type: "review",
            description: "Parser behavior was inspected.",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["obs-parser"],
            kind: "observed",
          },
        ],
      });

      const improved = await consumer.invoke("/digests", "generate_digest", {});
      expect(improved.status).toBe("ok");
      const improvedData = improved.data as {
        sections: {
          drift_dashboard: {
            progress: { prior_distance: number; current_distance: number; velocity: number };
            recent_events: Array<{ kind: string }>;
          };
        };
      };
      expect(improvedData.sections.drift_dashboard.progress.prior_distance).toBe(1);
      expect(improvedData.sections.drift_dashboard.progress.current_distance).toBe(0);
      expect(improvedData.sections.drift_dashboard.progress.velocity).toBe(1);
      expect(improvedData.sections.drift_dashboard.recent_events).not.toContainEqual(
        expect.objectContaining({ kind: "progress_drift" }),
      );
    } finally {
      provider.stop();
    }
  });

  test("stalled progress and projected budget exhaustion record progress drift", async () => {
    const { provider, consumer } = await orchestrationHarness({
      guardrails: {
        progress_stall_limit: 1,
        progress_projection_requires_budget: true,
      },
    });
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        budget: { wall_time_ms: 10_000 },
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });

      await consumer.invoke("/digests", "generate_digest", {});
      const stalled = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(stalled.status).toBe("ok");
      const data = stalled.data as {
        sections: {
          drift_dashboard: {
            progress: {
              current_distance: number;
              non_improving_evaluations?: number;
              projected_budget_exhaustion?: boolean;
            };
            recent_events: Array<{ kind: string; summary: string }>;
          };
        };
      };
      expect(data.sections.drift_dashboard.progress.current_distance).toBe(1);
      expect(
        data.sections.drift_dashboard.progress.non_improving_evaluations,
      ).toBeGreaterThanOrEqual(1);
      expect(data.sections.drift_dashboard.progress.projected_budget_exhaustion).toBe(true);
      expect(data.sections.drift_dashboard.recent_events).toContainEqual(
        expect.objectContaining({
          kind: "progress_drift",
        }),
      );
      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "drift_escalation" &&
            child.properties?.scope === `plan:${(revision.data as { plan_id: string }).plan_id}` &&
            child.properties?.subject_ref ===
              `plan:${(revision.data as { plan_id: string }).plan_id}:drift:progress:budget_projection`,
        ),
      ).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("coherence threshold breaches record drift events and digest metrics", async () => {
    const { provider, consumer } = await orchestrationHarness({
      guardrails: { coherence_question_density_limit: 1 },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", {
        query: "Clarify parser",
      });
      await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "planner",
        to_role: "spec-agent",
        summary: "Should parser errors include row numbers?",
      });
      await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "planner",
        to_role: "spec-agent",
        summary: "Should parser errors include column names?",
      });

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const data = digest.data as {
        sections: {
          drift_dashboard: {
            coherence: {
              question_density: number;
              thresholds: { question_density_limit?: number };
              breaches: string[];
            };
            recent_events: Array<{ kind: string; summary: string }>;
          };
        };
      };
      expect(data.sections.drift_dashboard.coherence.question_density).toBe(2);
      expect(data.sections.drift_dashboard.coherence.thresholds.question_density_limit).toBe(1);
      expect(data.sections.drift_dashboard.coherence.breaches).toContain("question_density");
      expect(data.sections.drift_dashboard.recent_events).toContainEqual(
        expect.objectContaining({ kind: "coherence_drift" }),
      );
    } finally {
      provider.stop();
    }
  });

  test("coverage gaps are surfaced in drift state and digest payloads", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "parser.ts"), "export const parser = true;\n", "utf8");

      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        observations: [
          {
            id: "obs-parser",
            type: "review",
            description: "Parser file was touched but no acceptance criterion was satisfied.",
          },
        ],
        risk: {
          files_modified: ["src/parser.ts"],
          irreversible_actions: [],
          deps_added: [],
        },
      });
      expect(evidence.status).toBe("ok");

      const rootState = await consumer.query("/orchestration", 1);
      expect(rootState.properties?.drift_metrics).toEqual(
        expect.objectContaining({
          intent: expect.objectContaining({ coverage_gap_count: 1 }),
        }),
      );

      const digest = await consumer.invoke("/digests", "generate_digest", {
        cadence: "on_escalation",
      });
      expect(digest.status).toBe("ok");
      const digestData = digest.data as {
        sections: {
          drift_dashboard: {
            intent: { coverage_gap_count: number };
            recent_events: Array<{ kind: string; severity: string }>;
          };
        };
        source_refs: string[];
      };
      expect(digestData.sections.drift_dashboard.intent.coverage_gap_count).toBe(1);
      expect(digestData.sections.drift_dashboard.recent_events).toContainEqual(
        expect.objectContaining({
          kind: "coverage_gap",
          severity: "warning",
        }),
      );
      expect(digestData.source_refs.some((ref) => ref.startsWith("drift:"))).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("dependency and public-surface drift opens blocking escalation gates", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        observations: [
          {
            id: "obs-public-api",
            type: "review",
            description: "Parser exports changed while adding a runtime dependency.",
          },
        ],
        risk: {
          files_modified: [],
          irreversible_actions: [],
          deps_added: ["left-pad"],
          public_surface_delta: "exported parseInput(options)",
        },
      });
      expect(evidence.status).toBe("ok");
      const data = evidence.data as {
        gate_ids: string[];
        drift_event_ids: string[];
      };
      expect(data.gate_ids.length).toBeGreaterThanOrEqual(2);
      expect(data.drift_event_ids.length).toBeGreaterThanOrEqual(2);

      const drift = await consumer.query("/drift", 2);
      expect(drift.children?.map((child) => child.properties?.kind)).toEqual(
        expect.arrayContaining(["coverage_gap", "intent_drift"]),
      );
      expect(
        drift.children?.filter((child) => child.properties?.severity === "blocking").length,
      ).toBeGreaterThanOrEqual(2);

      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some(
          (child) =>
            child.properties?.gate_type === "drift_escalation" &&
            child.properties?.subject_ref === `slice:${taskId}:drift:intent`,
        ),
      ).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("self-attested evidence cannot satisfy a slice gate", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "claim-only",
            command: "not run",
            verification: "self_attested",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["claim-only"],
            kind: "replayable",
          },
        ],
      });
      expect(evidence.status).toBe("error");
      expect(evidence.error?.code).toBe("invalid_evidence");
    } finally {
      provider.stop();
    }
  });

  test("cross-slice same-class failures cluster and breach failure_cluster threshold", async () => {
    // Distinct logical slices failing with the same class is a different signal than
    // one slice retried — it means the planner mis-modeled something structural.
    const { provider, consumer } = await orchestrationHarness({
      guardrails: { repeated_failure_limit: 2 },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "Cluster repro" });

      const driveFail = async (name: string) => {
        const created = await consumer.invoke("/orchestration", "create_task", {
          name,
          goal: `Goal for ${name}`,
        });
        const id = (created.data as { id: string }).id;
        await consumer.invoke(`/tasks/${id}`, "start", {});
        await consumer.invoke(`/tasks/${id}`, "fail", { error: `test: ${name} blew up` });
        return id;
      };

      await driveFail("alpha");
      await driveFail("beta");

      // Trigger plan-level evaluation.
      const digest = await consumer.invoke("/digests", "generate_digest", {});
      expect(digest.status).toBe("ok");
      const coherence = (
        digest.data as {
          sections: { drift_dashboard: { coherence: Record<string, unknown> } };
        }
      ).sections.drift_dashboard.coherence;
      expect(coherence.largest_failure_cluster_size).toBeGreaterThanOrEqual(2);
      expect(coherence.largest_failure_cluster_class).toBe("test");
      const breaches = coherence.breaches as string[];
      expect(breaches).toContain("failure_cluster");
    } finally {
      provider.stop();
    }
  });

  test("judgment SpecQuestion attaches structurally similar case records as resolver hints", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      // Pre-existing case record with the same structural keys.
      const created = await consumer.invoke("/precedents", "create_case_record", {
        project_id: "local",
        question_class: "judgment",
        spec_sections_referenced: ["§auth", "§sessions"],
        code_areas: ["src/auth/session.ts"],
        question: "Should sessions expire on logout?",
        canonical_summary: "session expiry on logout",
        raised_by_role: "planner",
        decided_by: "user",
        answer: "Yes — invalidate immediately.",
      });
      expect(created.status).toBe("ok");
      const caseId = (created.data as { id: string }).id;

      // New SpecQuestion with overlapping keys: matches should surface.
      const message = await consumer.invoke("/messages", "submit_protocol_message", {
        kind: "SpecQuestion",
        from_role: "planner",
        to_role: "spec-agent",
        summary: "Should sessions also expire on password change?",
        question_class: "judgment",
        project_id: "local",
        spec_sections_referenced: ["§auth", "§sessions"],
        code_areas: ["src/auth/session.ts"],
      });
      expect(message.status).toBe("ok");
      const data = message.data as {
        spec_question?: {
          case_record_matches?: Array<{ case_record_id: string }>;
        };
      };
      expect(data.spec_question?.case_record_matches?.length ?? 0).toBeGreaterThan(0);
      expect(
        data.spec_question?.case_record_matches?.some((entry) => entry.case_record_id === caseId),
      ).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("digest trends compute deltas vs previous digest; near_misses surfaces succeeded-after-retry", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "Trend repro" });

      const created = await consumer.invoke("/orchestration", "create_task", {
        name: "alpha",
        goal: "Goal alpha",
      });
      const alphaId = (created.data as { id: string }).id;
      await consumer.invoke(`/tasks/${alphaId}`, "start", {});
      await consumer.invoke(`/tasks/${alphaId}`, "fail", { error: "test: alpha" });

      const baseline = await consumer.invoke("/digests", "generate_digest", {});
      expect(baseline.status).toBe("ok");
      const baselineData = baseline.data as { id: string; sections: { trends?: unknown } };
      // No previous digest yet — trends should be absent.
      expect(baselineData.sections.trends).toBeUndefined();

      // Retry the failed slice and complete it.
      const retry = await consumer.invoke("/orchestration", "create_task", {
        name: "alpha-retry",
        goal: "Goal alpha retry",
        retry_of: alphaId,
      });
      const retryId = (retry.data as { id: string }).id;
      await consumer.invoke(`/tasks/${retryId}`, "start", {});
      await consumer.invoke(`/tasks/${retryId}`, "record_verification", {
        kind: "test",
        status: "not_required",
        summary: "No external check.",
        criteria: ["all"],
      });
      await consumer.invoke(`/tasks/${retryId}`, "complete", { result: "done" });

      const next = await consumer.invoke("/digests", "generate_digest", {});
      expect(next.status).toBe("ok");
      const nextData = next.data as {
        sections: {
          trends?: {
            previous_digest_id: string;
            deltas: {
              completed_slice_count: number;
              failed_slice_count: number;
            };
          };
          near_misses: Array<{ kind: string; ref: string }>;
        };
      };
      expect(nextData.sections.trends).toBeDefined();
      expect(nextData.sections.trends?.previous_digest_id).toBe(baselineData.id);
      // alpha was failed in baseline; after retry+complete it's superseded and retry is completed.
      expect(nextData.sections.trends?.deltas.completed_slice_count).toBeGreaterThanOrEqual(1);

      const succeeded = nextData.sections.near_misses.find(
        (entry) => entry.kind === "succeeded_after_retry",
      );
      expect(succeeded).toBeDefined();
      expect(succeeded?.ref).toBe(`slice:${retryId}`);
    } finally {
      provider.stop();
    }
  });

  test("plan-halt gate fires on cross-slice cluster and blocks new task dispatch until resolved", async () => {
    const { provider, consumer } = await orchestrationHarness({
      guardrails: { repeated_failure_limit: 2 },
    });
    try {
      await consumer.invoke("/orchestration", "create_plan", { query: "Halt repro" });

      const driveFail = async (name: string) => {
        const created = await consumer.invoke("/orchestration", "create_task", {
          name,
          goal: `Goal for ${name}`,
        });
        const id = (created.data as { id: string }).id;
        await consumer.invoke(`/tasks/${id}`, "start", {});
        await consumer.invoke(`/tasks/${id}`, "fail", { error: `test: ${name} failed` });
      };

      await driveFail("alpha");
      await driveFail("beta");

      // Plan-halt gate should now be open.
      const gates = await consumer.query("/gates", 2);
      const haltGate = gates.children?.find(
        (child) =>
          child.properties?.gate_type === "drift_escalation" &&
          typeof child.properties?.subject_ref === "string" &&
          (child.properties.subject_ref as string).endsWith(":drift:stuck"),
      );
      expect(haltGate).toBeDefined();
      expect(haltGate?.properties?.status).toBe("open");

      // New task scheduling/start refuses while halted.
      const blocked = await consumer.invoke("/orchestration", "create_task", {
        name: "gamma",
        goal: "Should not start",
      });
      const gammaId = (blocked.data as { id: string }).id;
      const startBlocked = await consumer.invoke(`/tasks/${gammaId}`, "start", {});
      expect(startBlocked.status).toBe("error");
      expect(startBlocked.error?.code).toBe("plan_halted");

      // Resolving the halt gate restores dispatch.
      const haltGateId = haltGate?.id as string;
      await consumer.invoke(`/gates/${haltGateId}`, "resolve_gate", { status: "accepted" });
      const startOk = await consumer.invoke(`/tasks/${gammaId}`, "start", {});
      expect(startOk.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("irreversibility classifier auto-tags risky commands the executor did not declare", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Deploy",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "deploy",
            goal: "Push to production.",
            acceptance_criteria: ["Deployment lands"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "deploy",
            type: "custom",
            command: "git push --force origin main",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["deploy"],
            kind: "replayable",
          },
        ],
        // Note: executor did NOT declare irreversible_actions.
        risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
      });
      expect(evidence.status).toBe("ok");

      const drift = await consumer.query("/drift", 2);
      const irreversible = drift.children?.find(
        (child) => child.properties?.kind === "irreversible_action_declared",
      );
      expect(irreversible).toBeDefined();
      expect(irreversible?.properties?.metrics).toEqual(
        expect.objectContaining({ action: "git push --force" }),
      );

      const gates = await consumer.query("/gates", 2);
      expect(
        gates.children?.some((child) => child.properties?.gate_type === "irreversible_action"),
      ).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("abstraction emergence: file outside structural_assumptions opens warning intent drift", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Implement parser",
        slice_gate_resolver: "policy",
        slices: [
          {
            name: "parser",
            goal: "Implement parser.",
            spec_refs: ["spec-1"],
            structural_assumptions: ["src/parser/"],
            acceptance_criteria: ["Parser handles empty input"],
          },
        ],
      });
      const gateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${gateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      await consumer.invoke(`/tasks/${taskId}`, "start", {});

      // files_modified entries must exist on disk for the evidence-claim validator.
      await mkdir(join(root, "src", "parser"), { recursive: true });
      await mkdir(join(root, "src", "utils"), { recursive: true });
      await writeFile(join(root, "src", "parser", "index.ts"), "// parser\n", "utf8");
      await writeFile(join(root, "src", "utils", "cache.ts"), "// cache\n", "utf8");

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-parser",
            type: "test",
            command: "bun test tests/parser.test.ts",
            exit_code: 0,
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: criterionId,
            evidence_refs: ["check-parser"],
            kind: "replayable",
          },
        ],
        risk: {
          // src/parser/index.ts is in scope; src/utils/cache.ts is an emergent abstraction.
          files_modified: ["src/parser/index.ts", "src/utils/cache.ts"],
          irreversible_actions: [],
          deps_added: [],
        },
      });
      expect(evidence.status).toBe("ok");

      const drift = await consumer.query("/drift", 2);
      const intent = drift.children?.find(
        (child) =>
          child.properties?.kind === "intent_drift" &&
          (child.properties?.metrics as { abstraction_files?: string[] } | undefined)
            ?.abstraction_files,
      );
      expect(intent).toBeDefined();
      const metrics = intent?.properties?.metrics as { abstraction_files: string[] };
      expect(metrics.abstraction_files).toContain("src/utils/cache.ts");
      expect(metrics.abstraction_files).not.toContain("src/parser/index.ts");
      expect(intent?.properties?.severity).toBe("warning");
    } finally {
      provider.stop();
    }
  });
});

describe("docs/12 spec provider snapshots", () => {
  test("criterion metadata and immutable versions are exposed", async () => {
    const { root, orchestration, spec, specConsumer } = await combinedHarness();
    try {
      const created = await specConsumer.invoke("/specs", "create_spec", {
        title: "Snapshot spec",
        goal_id: "goal-snapshot",
        goal_version: 3,
      });
      expect(created.status).toBe("ok");
      const specId = (created.data as { id: string }).id;
      const requirement = await specConsumer.invoke(`/specs/${specId}`, "add_requirement", {
        text: "Run parser tests.",
        criterion_kind: "code",
        verification_hint: "bun test tests/parser.test.ts",
      });
      expect(requirement.status).toBe("ok");

      const requirements = await specConsumer.query(`/specs/${specId}/requirements`, 2);
      expect(requirements.children?.[0]?.properties?.criterion_kind).toBe("code");
      expect(requirements.children?.[0]?.properties?.verification_hint).toContain("bun test");

      const versions = await specConsumer.query(`/specs/${specId}/versions`, 2);
      expect(versions.children?.length).toBeGreaterThanOrEqual(2);
      expect(
        existsSync(join(root, ".sloppy", "specs", "specs", specId, "versions", "1.json")),
      ).toBe(true);
      expect(
        readFileSync(join(root, ".sloppy", "specs", "specs", specId, "versions", "1.json"), "utf8"),
      ).toContain("Snapshot spec");
    } finally {
      orchestration.stop();
      spec.stop();
    }
  });

  test("accepting a new plan revision supersedes prior-revision non-terminal tasks", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const first = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Initial plan",
        slices: [
          {
            name: "step-one",
            goal: "Do step one.",
            acceptance_criteria: ["Step one done"],
          },
        ],
      });
      expect(first.status).toBe("ok");
      const firstGateId = (first.data as { gate_id: string }).gate_id;
      const firstAccept = await consumer.invoke(`/gates/${firstGateId}`, "resolve_gate", {
        status: "accepted",
      });
      expect(firstAccept.status).toBe("ok");

      const tasksBefore = await consumer.query("/tasks", 2);
      const firstTaskId = tasksBefore.children?.[0]?.id;
      expect(firstTaskId).toBeString();

      const second = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Revised plan",
        slices: [
          {
            name: "step-two",
            goal: "Do step two instead.",
            acceptance_criteria: ["Step two done"],
          },
        ],
      });
      expect(second.status).toBe("ok");
      const secondGateId = (second.data as { gate_id: string }).gate_id;
      const secondAccept = await consumer.invoke(`/gates/${secondGateId}`, "resolve_gate", {
        status: "accepted",
      });
      expect(secondAccept.status).toBe("ok");

      const supersededTask = await consumer.query(`/tasks/${firstTaskId}`, 1);
      expect(supersededTask.properties?.status).toBe("superseded");
    } finally {
      provider.stop();
    }
  });

  test("create_plan_revision rejects unaccepted spec versions", async () => {
    const { orchestration, orchestrationConsumer, spec, specConsumer } = await combinedHarness();
    try {
      const created = await specConsumer.invoke("/specs", "create_spec", {
        title: "Draft spec",
        body: "# Draft spec",
      });
      expect(created.status).toBe("ok");
      const specId = (created.data as { id: string; version: number }).id;
      const specVersion = (created.data as { version: number }).version;

      const revision = await orchestrationConsumer.invoke(
        "/orchestration",
        "create_plan_revision",
        {
          query: "Plan against draft",
          spec_id: specId,
          spec_version: specVersion,
          slices: [
            {
              name: "slice",
              goal: "Do work.",
              acceptance_criteria: ["Work done"],
            },
          ],
        },
      );
      expect(revision.status).toBe("error");
      expect(revision.error?.code).toBe("spec_not_accepted");
    } finally {
      orchestration.stop();
      spec.stop();
    }
  });

  test("final audit replays only active-revision evidence", async () => {
    const { root, provider, consumer } = await orchestrationHarness();
    try {
      await writeBunTest(root, "first.test.ts");
      await writeBunTest(root, "second.test.ts");

      const first = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Plan v1",
        slices: [
          {
            name: "first",
            goal: "Implement first.",
            acceptance_criteria: ["First criterion"],
          },
        ],
      });
      expect(first.status).toBe("ok");
      await consumer.invoke(
        `/gates/${(first.data as { gate_id: string }).gate_id}`,
        "resolve_gate",
        {
          status: "accepted",
        },
      );
      const tasksA = await consumer.query("/tasks", 2);
      const taskA = tasksA.children?.[0]?.id;
      const criterionA = firstCriterionId(tasksA.children?.[0]?.properties?.acceptance_criteria);
      const taskAState = await consumer.query(`/tasks/${taskA}`, 1);
      await consumer.invoke(`/tasks/${taskA}`, "start", {
        expected_version: taskAState.properties?.version,
      });
      const evA = await consumer.invoke(`/tasks/${taskA}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-first",
            type: "test",
            command: "bun test tests/first.test.ts",
            exit_code: 0,
            output: "pass",
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          { criterion_id: criterionA, evidence_refs: ["check-first"], kind: "replayable" },
        ],
        risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
      });
      const sliceGateA = (evA.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${sliceGateA}`, "resolve_gate", { status: "accepted" });
      const taskAFinal = await consumer.query(`/tasks/${taskA}`, 1);
      await consumer.invoke(`/tasks/${taskA}`, "complete", {
        result: "done",
        expected_version: taskAFinal.properties?.version,
      });

      const second = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Plan v2",
        slices: [
          {
            name: "second",
            goal: "Implement second.",
            acceptance_criteria: ["Second criterion"],
          },
        ],
      });
      expect(second.status).toBe("ok");
      await consumer.invoke(
        `/gates/${(second.data as { gate_id: string }).gate_id}`,
        "resolve_gate",
        { status: "accepted" },
      );
      const tasksB = await consumer.query("/tasks", 2);
      const taskB = tasksB.children?.find((child) => child.id !== taskA)?.id;
      expect(taskB).toBeString();
      const criterionB = firstCriterionId(
        tasksB.children?.find((child) => child.id === taskB)?.properties?.acceptance_criteria,
      );
      const taskBState = await consumer.query(`/tasks/${taskB}`, 1);
      await consumer.invoke(`/tasks/${taskB}`, "start", {
        expected_version: taskBState.properties?.version,
      });
      const evB = await consumer.invoke(`/tasks/${taskB}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-second",
            type: "test",
            command: "bun test tests/second.test.ts",
            exit_code: 0,
            output: "pass",
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          { criterion_id: criterionB, evidence_refs: ["check-second"], kind: "replayable" },
        ],
        risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
      });
      const sliceGateB = (evB.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${sliceGateB}`, "resolve_gate", { status: "accepted" });
      const taskBFinal = await consumer.query(`/tasks/${taskB}`, 1);
      await consumer.invoke(`/tasks/${taskB}`, "complete", {
        result: "done",
        expected_version: taskBFinal.properties?.version,
      });

      const audit = await consumer.invoke("/audit", "run_final_audit", {});
      expect(audit.status).toBe("ok");
      const replayed = (audit.data as { replayed_checks: Array<{ command: string }> })
        .replayed_checks;
      expect(replayed.length).toBe(1);
      expect(replayed[0].command).toBe("bun test tests/second.test.ts");
    } finally {
      provider.stop();
    }
  });

  test("create_task retries inherit docs/12 fields from the source slice", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Plan",
        slices: [
          {
            name: "slice",
            goal: "Do work.",
            acceptance_criteria: ["Real criterion"],
          },
        ],
      });
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const original = await consumer.query(`/tasks/${taskId}`, 1);
      const originalRev = original.properties?.plan_revision_id;
      expect(originalRev).toBeString();

      await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: original.properties?.version,
      });
      await consumer.invoke(`/tasks/${taskId}`, "fail", {
        error: "Need a retry",
      });

      const retry = await consumer.invoke("/orchestration", "create_task", {
        name: "slice-retry",
        goal: "Do work.",
        acceptance_criteria: ["Real criterion"],
        retry_of: taskId,
      });
      expect(retry.status).toBe("ok");
      const retryId = (retry.data as { id: string }).id;
      const retryNode = await consumer.query(`/tasks/${retryId}`, 1);
      expect(retryNode.properties?.plan_revision_id).toBe(originalRev);
      expect(retryNode.properties?.requires_slice_gate).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("submit_evidence_claim rejects criterion kind=replayable when evidence is observed", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Plan",
        slices: [
          {
            name: "slice",
            goal: "Do work.",
            acceptance_criteria: ["Real criterion"],
          },
        ],
      });
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      const task = await consumer.query(`/tasks/${taskId}`, 1);
      await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: task.properties?.version,
      });

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        observations: [
          {
            id: "obs-1",
            type: "manual",
            description: "Looked at it",
            verification: "observed",
          },
        ],
        criterion_satisfaction: [
          { criterion_id: criterionId, evidence_refs: ["obs-1"], kind: "replayable" },
        ],
        risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
      });
      expect(evidence.status).toBe("error");
      expect(evidence.error?.code).toBe("criterion_kind_mismatch");
    } finally {
      provider.stop();
    }
  });

  describe("observed-only criterion coverage", () => {
    async function setupSlice() {
      const harness = await orchestrationHarness();
      const revision = await harness.consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Plan",
        slices: [
          {
            name: "slice",
            goal: "Do work.",
            acceptance_criteria: ["Real criterion"],
          },
        ],
      });
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await harness.consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });
      const tasks = await harness.consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      const criterionId = firstCriterionId(tasks.children?.[0]?.properties?.acceptance_criteria);
      const task = await harness.consumer.query(`/tasks/${taskId}`, 1);
      await harness.consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: task.properties?.version,
      });
      return { ...harness, taskId, criterionId };
    }

    async function listDriftEvents(consumer: SlopConsumer): Promise<Array<{ kind: string }>> {
      const events = await consumer.query("/drift", 2);
      return (events.children ?? []).map((child) => ({
        kind: (child.properties?.kind as string) ?? "",
      }));
    }

    test("replayable-only evidence does not raise observed_only_coverage drift", async () => {
      const { provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          checks: [
            {
              id: "c1",
              type: "test",
              command: "bun test",
              exit_code: 0,
              output: "pass",
              verification: "replayable",
            },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["c1"], kind: "replayable" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(evidence.status).toBe("ok");
        const events = await listDriftEvents(consumer);
        expect(events.find((event) => event.kind === "observed_only_coverage")).toBeUndefined();
      } finally {
        provider.stop();
      }
    });

    test("observed-only evidence opens the slice gate but raises observed_only_coverage drift", async () => {
      const { provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          observations: [
            { id: "o1", type: "manual", description: "Looked at it", verification: "observed" },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["o1"], kind: "observed" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(evidence.status).toBe("ok");
        const sliceGateId = (evidence.data as { gate_id?: string }).gate_id;
        expect(sliceGateId).toBeString();
        const events = await listDriftEvents(consumer);
        expect(events.some((event) => event.kind === "observed_only_coverage")).toBe(true);
      } finally {
        provider.stop();
      }
    });

    test("mixed replayable + observed evidence is treated as replayable (no warning)", async () => {
      const { provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          checks: [
            {
              id: "c1",
              type: "test",
              command: "bun test",
              exit_code: 0,
              output: "pass",
              verification: "replayable",
            },
          ],
          observations: [
            { id: "o1", type: "manual", description: "also looked", verification: "observed" },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["c1", "o1"], kind: "replayable" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(evidence.status).toBe("ok");
        const events = await listDriftEvents(consumer);
        expect(events.find((event) => event.kind === "observed_only_coverage")).toBeUndefined();
      } finally {
        provider.stop();
      }
    });

    test("legacy record_verification with observed-only evidence raises observed_only_coverage", async () => {
      const { root, provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        await writeFile(join(root, "review-notes.md"), "manual review", "utf8");
        const verified = await consumer.invoke(`/tasks/${taskId}`, "record_verification", {
          status: "passed",
          summary: "Reviewed manually",
          evidence: "Looked at it; LGTM",
          criteria: [criterionId],
          evidence_refs: ["review-notes.md"],
        });
        expect(verified.status).toBe("ok");
        const events = await listDriftEvents(consumer);
        expect(events.some((event) => event.kind === "observed_only_coverage")).toBe(true);
      } finally {
        provider.stop();
      }
    });

    test("duplicate criterion rows in one claim are aggregated", async () => {
      const { provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          checks: [
            {
              id: "c1",
              type: "test",
              command: "bun test",
              exit_code: 0,
              output: "pass",
              verification: "replayable",
            },
          ],
          observations: [
            { id: "o1", type: "manual", description: "also looked", verification: "observed" },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["o1"], kind: "observed" },
            { criterion_id: criterionId, evidence_refs: ["c1"], kind: "replayable" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(evidence.status).toBe("ok");
        const events = await listDriftEvents(consumer);
        expect(events.find((event) => event.kind === "observed_only_coverage")).toBeUndefined();
      } finally {
        provider.stop();
      }
    });

    test("observed-only follow-up after a replayable claim does not re-warn", async () => {
      const { provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        const first = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          checks: [
            {
              id: "c1",
              type: "test",
              command: "bun test",
              exit_code: 0,
              output: "pass",
              verification: "replayable",
            },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["c1"], kind: "replayable" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(first.status).toBe("ok");

        const second = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          observations: [
            { id: "o1", type: "manual", description: "later look", verification: "observed" },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["o1"], kind: "observed" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(second.status).toBe("ok");

        const events = await listDriftEvents(consumer);
        expect(events.find((event) => event.kind === "observed_only_coverage")).toBeUndefined();
      } finally {
        provider.stop();
      }
    });

    test("self-attested evidence cannot satisfy criteria", async () => {
      const { provider, consumer, taskId, criterionId } = await setupSlice();
      try {
        const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
          checks: [
            {
              id: "c1",
              type: "test",
              command: "trust me",
              exit_code: 0,
              output: "ok",
              verification: "self_attested",
            },
          ],
          criterion_satisfaction: [
            { criterion_id: criterionId, evidence_refs: ["c1"], kind: "observed" },
          ],
          risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
        });
        expect(evidence.status).toBe("error");
        expect(evidence.error?.code).toBe("invalid_evidence");
      } finally {
        provider.stop();
      }
    });
  });

  test("submit_evidence_claim rejects unknown criterion_ids", async () => {
    const { provider, consumer } = await orchestrationHarness();
    try {
      const revision = await consumer.invoke("/orchestration", "create_plan_revision", {
        query: "Plan",
        slices: [
          {
            name: "slice",
            goal: "Do work.",
            acceptance_criteria: ["Real criterion"],
          },
        ],
      });
      expect(revision.status).toBe("ok");
      const planGateId = (revision.data as { gate_id: string }).gate_id;
      await consumer.invoke(`/gates/${planGateId}`, "resolve_gate", { status: "accepted" });

      const tasks = await consumer.query("/tasks", 2);
      const taskId = tasks.children?.[0]?.id;
      expect(taskId).toBeString();
      const task = await consumer.query(`/tasks/${taskId}`, 1);
      const started = await consumer.invoke(`/tasks/${taskId}`, "start", {
        expected_version: task.properties?.version,
      });
      expect(started.status).toBe("ok");

      const evidence = await consumer.invoke(`/tasks/${taskId}`, "submit_evidence_claim", {
        checks: [
          {
            id: "check-1",
            type: "test",
            command: "bun test",
            exit_code: 0,
            output: "pass",
            verification: "replayable",
          },
        ],
        criterion_satisfaction: [
          {
            criterion_id: "criterion-bogus",
            evidence_refs: ["check-1"],
            kind: "replayable",
          },
        ],
        risk: { files_modified: [], irreversible_actions: [], deps_added: [] },
      });
      expect(evidence.status).toBe("error");
      expect(evidence.error?.code).toBe("unknown_criterion");
    } finally {
      provider.stop();
    }
  });
});

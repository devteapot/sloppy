import { action } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import {
  normalizeHandoffKind,
  normalizeHandoffPriority,
  normalizeStringList,
  normalizeTaskKind,
  normalizeTaskList,
} from "./normalization";
import { OPTIONAL_EXPECTED_VERSION_PARAM, type TaskState } from "./types";

export function buildRootDescriptor(wiring: DescriptorWiring) {
  const { repo, lifecycle, plans, handoffs, sessionId } = wiring;
  const plan = repo.loadPlan();
  const taskIds = repo.listTaskIdsForPlan(plan);
  const states = taskIds
    .map((id) => repo.loadTaskState(id))
    .filter((state): state is TaskState => state !== null);
  const handoffList = repo.listHandoffsForPlan(plan);
  const findingList = repo.listFindingsForPlan(plan);
  const counts = {
    total: states.length,
    pending: states.filter((s) => s.status === "pending").length,
    scheduled: states.filter((s) => s.status === "scheduled").length,
    running: states.filter((s) => s.status === "running").length,
    verifying: states.filter((s) => s.status === "verifying").length,
    completed: states.filter((s) => s.status === "completed").length,
    failed: states.filter((s) => s.status === "failed").length,
    cancelled: states.filter((s) => s.status === "cancelled").length,
    superseded: states.filter((s) => s.status === "superseded").length,
  };

  return {
    type: "context",
    props: {
      session_id: sessionId,
      plan_id: plan?.id,
      plan_status: plan?.status ?? "none",
      plan_query: plan?.query,
      plan_strategy: plan?.strategy,
      plan_max_agents: plan?.max_agents,
      plan_created_at: plan?.created_at,
      plan_version: plan ? repo.planVersion() : undefined,
      task_counts: counts,
      handoff_counts: {
        total: handoffList.length,
        pending: handoffList.filter((h) => h.status === "pending").length,
      },
      finding_counts: {
        total: findingList.length,
        open: findingList.filter((finding) => finding.status === "open").length,
        blocking_open: findingList.filter(
          (finding) => finding.status === "open" && finding.severity === "blocking",
        ).length,
      },
    },
    summary: plan
      ? `Plan "${plan.query}" (${counts.completed}/${counts.total} done)`
      : "No active orchestration plan.",
    actions: {
      create_plan: action(
        {
          query: "string",
          strategy: {
            type: "string",
            description: "Decomposition strategy (e.g. sequential, parallel, breadth-first).",
          },
          max_agents: {
            type: "number",
            description: "Maximum concurrent sub-agents this plan permits.",
          },
        },
        async ({ query, strategy, max_agents }) =>
          plans.createPlan({
            query: query as string,
            strategy: typeof strategy === "string" ? strategy : undefined,
            max_agents: typeof max_agents === "number" ? max_agents : undefined,
          }),
        {
          label: "Create Plan",
          description: "Create a new orchestration plan. Fails if an active plan already exists.",
          estimate: "instant",
        },
      ),
      complete_plan: action(
        {
          status: {
            type: "string",
            description: "Final plan status: completed or cancelled.",
          },
          expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
        },
        async ({ status, expected_version }) =>
          plans.completePlan({
            status: (status as string) === "cancelled" ? "cancelled" : "completed",
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
          }),
        {
          label: "Complete Plan",
          description: "Mark the active plan as completed or cancelled.",
          estimate: "instant",
        },
      ),
      create_task: action(
        {
          name: "string",
          goal: "string",
          kind: {
            type: "string",
            description:
              "Optional task kind: implementation, audit, repair, docs, or verification.",
            enum: ["implementation", "audit", "repair", "docs", "verification"],
            optional: true,
          },
          client_ref: {
            type: "string",
            description:
              "Optional local reference for this task, e.g. 'scaffold' or 'task-1'. Later dependencies may use this value.",
            optional: true,
          },
          spec_refs: {
            type: "array",
            description:
              "Optional spec requirement or decision refs this task is responsible for satisfying.",
            items: { type: "string" },
            optional: true,
          },
          audit_of: {
            type: "string",
            description: "Optional task id this audit task evaluates.",
            optional: true,
          },
          finding_refs: {
            type: "array",
            description: "Optional audit finding ids this repair task addresses.",
            items: { type: "string" },
            optional: true,
          },
          depends_on: {
            type: "array",
            description:
              "Optional list of dependency references. Prefer real task ids; existing task names, client_ref values, and aliases like task-1 are also accepted and normalized to ids.",
            items: { type: "string" },
            optional: true,
          },
          acceptance_criteria: {
            type: "array",
            description:
              "Optional concrete criteria that verification must cover before completion. Use short, checkable statements tied to this task's goal.",
            items: { type: "string" },
            optional: true,
          },
          retry_of: {
            type: "string",
            description:
              "Optional failed/cancelled/superseded task id this task replaces. When set, the old task is marked superseded_by the new one.",
            optional: true,
          },
        },
        async ({
          name,
          goal,
          kind,
          client_ref,
          spec_refs,
          audit_of,
          finding_refs,
          depends_on,
          acceptance_criteria,
          retry_of,
        }) =>
          lifecycle.createTask({
            name: name as string,
            goal: goal as string,
            kind: normalizeTaskKind(kind),
            client_ref: typeof client_ref === "string" ? client_ref : undefined,
            spec_refs: normalizeStringList(spec_refs),
            audit_of: typeof audit_of === "string" ? audit_of : undefined,
            finding_refs: normalizeStringList(finding_refs),
            depends_on: normalizeStringList(depends_on),
            acceptance_criteria: normalizeStringList(acceptance_criteria),
            retry_of: typeof retry_of === "string" ? retry_of : undefined,
          }),
        {
          label: "Create Task",
          description:
            "Define one task under the active plan. For multiple dependent tasks, prefer create_tasks so local refs and forward dependencies are resolved in one call. Use retry_of when replacing a failed or cancelled task.",
          estimate: "instant",
        },
      ),
      create_tasks: action(
        {
          tasks: {
            type: "array",
            description:
              "Batch-create tasks under the active plan. Each item is { name, goal, kind?, client_ref?, spec_refs?, audit_of?, finding_refs?, depends_on?, acceptance_criteria? }. Dependencies may refer to ids, names, client_ref values, or aliases from this same batch, so this is the preferred way to create a DAG without guessing generated task ids. Use minimal true blocking dependencies: for app builds, scaffold may block data/UI work, while docs and final verification wait for implementation. Do not make UI depend on data-model just because it imports the store; put the shared import path and API contract in both task goals instead.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short task name." },
                goal: { type: "string", description: "Detailed task goal." },
                kind: {
                  type: "string",
                  description:
                    "Optional task kind: implementation, audit, repair, docs, or verification.",
                  enum: ["implementation", "audit", "repair", "docs", "verification"],
                  optional: true,
                },
                client_ref: {
                  type: "string",
                  description:
                    "Optional local reference, e.g. 'scaffold' or 'ui'. Dependencies in this batch may refer to it.",
                  optional: true,
                },
                spec_refs: {
                  type: "array",
                  description:
                    "Optional spec requirement or decision refs this task is responsible for satisfying.",
                  items: { type: "string" },
                  optional: true,
                },
                audit_of: {
                  type: "string",
                  description: "Optional task id this audit task evaluates.",
                  optional: true,
                },
                finding_refs: {
                  type: "array",
                  description: "Optional audit finding ids this repair task addresses.",
                  items: { type: "string" },
                  optional: true,
                },
                depends_on: {
                  type: "array",
                  description:
                    "Optional dependency refs: ids, names, client_ref values, or aliases in this batch. Include only real blockers; implementation siblings that can agree on a stated interface should usually be parallel.",
                  items: { type: "string" },
                  optional: true,
                },
                acceptance_criteria: {
                  type: "array",
                  description:
                    "Optional concrete criteria that must be verified before this task can complete.",
                  items: { type: "string" },
                  optional: true,
                },
              },
              required: ["name", "goal"],
              additionalProperties: false,
            },
          },
        },
        async ({ tasks }) => lifecycle.createTasks({ tasks: normalizeTaskList(tasks) }),
        {
          label: "Create Tasks",
          description:
            "Batch-create a dependency graph of tasks. Prefer this over several create_task calls when tasks depend on each other, because local refs can be resolved without polling or guessed ids. Callers must supply explicit depends_on edges; the provider validates the DAG but does not infer dependencies.",
          estimate: "instant",
        },
      ),
      create_handoff: action(
        {
          from_task: "string",
          to_task: "string",
          kind: {
            type: "string",
            description:
              "Optional handoff kind: question, artifact_request, review_request, decision_request, or dependency_signal.",
            enum: [
              "question",
              "artifact_request",
              "review_request",
              "decision_request",
              "dependency_signal",
            ],
            optional: true,
          },
          priority: {
            type: "string",
            description: "Optional handoff priority: low, normal, or high.",
            enum: ["low", "normal", "high"],
            optional: true,
          },
          request: "string",
          spec_refs: {
            type: "array",
            description: "Optional spec refs this handoff is about.",
            items: { type: "string" },
            optional: true,
          },
          evidence_refs: {
            type: "array",
            description:
              "Optional files, commands, URLs, screenshots, or state paths that explain the request.",
            items: { type: "string" },
            optional: true,
          },
          blocks_task: {
            type: "boolean",
            description:
              "True when the receiving task should treat this handoff as blocking until responded.",
          },
        },
        async ({
          from_task,
          to_task,
          kind,
          priority,
          request,
          spec_refs,
          evidence_refs,
          blocks_task,
        }) =>
          handoffs.createHandoff({
            from_task: from_task as string,
            to_task: to_task as string,
            kind: normalizeHandoffKind(kind),
            priority: normalizeHandoffPriority(priority),
            request: request as string,
            spec_refs: normalizeStringList(spec_refs),
            evidence_refs: normalizeStringList(evidence_refs),
            blocks_task: typeof blocks_task === "boolean" ? blocks_task : undefined,
          }),
        {
          label: "Create Handoff",
          description:
            "Request that one task pass data or context to another. The response lives in the handoff record.",
          estimate: "instant",
        },
      ),
    },
    meta: {
      focus: true,
      salience: 1,
    },
  };
}

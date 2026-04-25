import { action } from "@slop-ai/server";

import { buildBudgetStatus, normalizePlanBudgetInput } from "./budget";
import type { DescriptorWiring } from "./descriptor-wiring";
import {
  normalizeGateResolver,
  normalizeHandoffKind,
  normalizeHandoffPriority,
  normalizeStringList,
  normalizeTaskKind,
  normalizeTaskList,
} from "./normalization";
import { OPTIONAL_EXPECTED_VERSION_PARAM, type TaskState } from "./types";

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildRootDescriptor(wiring: DescriptorWiring) {
  const { repo, lifecycle, plans, handoffs, gates, messages, digests, drift, sessionId } = wiring;
  const plan = repo.loadPlan();
  const taskIds = repo.listActiveRevisionTaskIds(plan);
  const states = taskIds
    .map((id) => repo.loadTaskState(id))
    .filter((state): state is TaskState => state !== null);
  const handoffList = repo.listHandoffsForPlan(plan);
  const findingList = repo.listFindingsForPlan(plan);
  const gateList = repo.listGates();
  const protocolMessages = repo.listMessages();
  const precedentList = repo.listPrecedents();
  const caseRecordList = repo.listCaseRecords();
  const planRevisions = repo.listPlanRevisions();
  const digestList = repo.listDigests();
  const driftEvents = repo.listDriftEventsForPlan(plan);
  const budget = buildBudgetStatus(plan, {
    ...repo.retryBudgetUsageForPlan(plan),
    ...repo.tokenCostBudgetUsageForPlan(plan),
  });
  const budgetUsageList = repo.listBudgetUsageForPlan(plan);
  const progressMetrics = drift.progressMetricsForPlan(plan, taskIds);
  const coherenceMetrics = drift.coherenceMetricsForPlan(plan, taskIds);
  const goalRevisions = plan?.goal_id ? repo.loadGoalRevisions(plan.goal_id) : [];
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
      plan_goal_id: plan?.goal_id,
      plan_goal_version: plan?.goal_version,
      plan_spec_id: plan?.spec_id,
      plan_spec_version: plan?.spec_version,
      planned_commit: plan?.planned_commit,
      active_revision_id: plan?.active_revision_id,
      gate_mode: plan?.gate_mode ?? "legacy",
      budget,
      budget_usage_count: budgetUsageList.length,
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
      gate_counts: {
        total: gateList.length,
        open: gateList.filter((gate) => gate.status === "open").length,
      },
      gate_policy: gates.describePolicy(),
      message_counts: {
        total: protocolMessages.length,
        open: protocolMessages.filter((message) => message.status === "open").length,
        precedent_resolved: protocolMessages.filter(
          (message) =>
            message.kind === "SpecQuestion" &&
            message.resolution?.decided_by === "policy" &&
            message.resolution.precedent_id !== undefined,
        ).length,
        semantic_precedent_resolved: protocolMessages.filter(
          (message) =>
            message.kind === "SpecQuestion" &&
            message.resolution?.precedent_id !== undefined &&
            message.resolution.match_score_source === "embedding",
        ).length,
        precedent_escalated: protocolMessages.filter(
          (message) =>
            message.kind === "SpecQuestion" &&
            message.spec_question?.precedent_resolution_attempt?.decision === "escalated",
        ).length,
      },
      precedent_counts: {
        total: precedentList.length,
        active: precedentList.filter(
          (precedent) => !precedent.health.contradicted && !precedent.health.invalidated_by,
        ).length,
        contradicted: precedentList.filter((precedent) => precedent.health.contradicted).length,
        invalidated: precedentList.filter((precedent) => precedent.health.invalidated_by).length,
        case_records: caseRecordList.length,
      },
      plan_revision_count: planRevisions.length,
      digest_count: digestList.length,
      latest_digest_id: digestList.at(-1)?.id,
      latest_digest_status: digestList.at(-1)?.status,
      digest_policy: digests.describePolicy(),
      drift_event_count: driftEvents.length,
      open_drift_event_count: driftEvents.filter((event) => event.status === "open").length,
      blocking_drift_event_count: driftEvents.filter(
        (event) => event.status === "open" && event.severity === "blocking",
      ).length,
      guardrails: drift.describe(),
      drift_metrics: {
        progress: progressMetrics,
        coherence: coherenceMetrics,
        intent: {
          coverage_gap_count: driftEvents.filter(
            (event) => event.kind === "coverage_gap" && event.status === "open",
          ).length,
          off_plan_slice_count: repo.listTaskIds().filter((taskId) => !taskIds.includes(taskId))
            .length,
          goal_revision_pressure: goalRevisions.length > 0 ? goalRevisions.length - 1 : 0,
          latest_goal_revision_magnitude: goalRevisions.at(-1)?.magnitude,
          minor_goal_revision_count: goalRevisions.filter(
            (revision) => revision.magnitude === "minor",
          ).length,
          material_goal_revision_count: goalRevisions.filter(
            (revision) => revision.magnitude !== "minor",
          ).length,
        },
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
          goal_id: {
            type: "string",
            description: "Optional upstream goal id.",
            optional: true,
          },
          goal_version: {
            type: "number",
            description: "Optional upstream goal version.",
            optional: true,
          },
          spec_id: {
            type: "string",
            description: "Optional upstream spec id.",
            optional: true,
          },
          spec_version: {
            type: "number",
            description: "Optional upstream immutable spec version.",
            optional: true,
          },
          planned_commit: {
            type: "string",
            description: "Optional commit or changeset the plan was authored against.",
            optional: true,
          },
          budget: {
            type: "object",
            description:
              "Optional plan-scoped budget. Supports wall_time_ms, retries_per_slice, token_limit, and cost_usd.",
            properties: {
              wall_time_ms: {
                type: "number",
                description: "Optional wall-time budget in milliseconds.",
                optional: true,
              },
              retries_per_slice: {
                type: "number",
                description: "Optional retry budget per logical slice.",
                optional: true,
              },
              token_limit: {
                type: "number",
                description: "Optional total token budget for recorded model usage.",
                optional: true,
              },
              cost_usd: {
                type: "number",
                description: "Optional USD cost budget for recorded usage.",
                optional: true,
              },
            },
            additionalProperties: false,
            optional: true,
          },
        },
        async ({
          query,
          strategy,
          max_agents,
          goal_id,
          goal_version,
          spec_id,
          spec_version,
          planned_commit,
          budget,
        }) =>
          plans.createPlan({
            query: query as string,
            strategy: typeof strategy === "string" ? strategy : undefined,
            max_agents: typeof max_agents === "number" ? max_agents : undefined,
            goal_id: normalizeString(goal_id),
            goal_version: normalizeNumber(goal_version),
            spec_id: normalizeString(spec_id),
            spec_version: normalizeNumber(spec_version),
            planned_commit: normalizeString(planned_commit),
            budget: normalizePlanBudgetInput(budget),
          }),
        {
          label: "Create Plan",
          description: "Create a new orchestration plan. Fails if an active plan already exists.",
          estimate: "instant",
        },
      ),
      create_plan_revision: action(
        {
          query: "string",
          strategy: {
            type: "string",
            description: "Decomposition strategy for this plan revision.",
            optional: true,
          },
          max_agents: {
            type: "number",
            description: "Maximum concurrent agents this revision permits.",
            optional: true,
          },
          goal_id: {
            type: "string",
            description: "Optional upstream goal id.",
            optional: true,
          },
          goal_version: {
            type: "number",
            description: "Optional upstream goal version.",
            optional: true,
          },
          spec_id: {
            type: "string",
            description: "Optional upstream spec id.",
            optional: true,
          },
          spec_version: {
            type: "number",
            description: "Optional upstream immutable spec version.",
            optional: true,
          },
          planned_commit: {
            type: "string",
            description: "Optional commit or changeset this plan was authored against.",
            optional: true,
          },
          planner_assumptions: {
            type: "array",
            description: "Optional assumptions made by the planner.",
            items: { type: "string" },
            optional: true,
          },
          structural_assumptions: {
            type: "array",
            description: "Optional codebase shape assumptions for this revision.",
            items: { type: "string" },
            optional: true,
          },
          slice_gate_resolver: {
            type: "string",
            description:
              "Default resolver for slice gates created by this plan revision. Use policy only for deterministic evidence-complete auto-acceptance.",
            enum: ["user", "policy"],
            optional: true,
          },
          budget: {
            type: "object",
            description:
              "Optional plan-scoped budget. Supports wall_time_ms, retries_per_slice, token_limit, and cost_usd.",
            properties: {
              wall_time_ms: {
                type: "number",
                description: "Optional wall-time budget in milliseconds.",
                optional: true,
              },
              retries_per_slice: {
                type: "number",
                description: "Optional retry budget per logical slice.",
                optional: true,
              },
              token_limit: {
                type: "number",
                description: "Optional total token budget for recorded model usage.",
                optional: true,
              },
              cost_usd: {
                type: "number",
                description: "Optional USD cost budget for recorded usage.",
                optional: true,
              },
            },
            additionalProperties: false,
            optional: true,
          },
          slices: {
            type: "array",
            description:
              "Complete slice set for this proposed plan revision. Each item matches create_tasks task objects and may include planner_assumptions and structural_assumptions.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short slice name." },
                goal: { type: "string", description: "Detailed slice goal." },
                kind: {
                  type: "string",
                  description:
                    "Optional slice kind: implementation, audit, repair, docs, or verification.",
                  enum: ["implementation", "audit", "repair", "docs", "verification"],
                  optional: true,
                },
                client_ref: {
                  type: "string",
                  description: "Optional stable local reference.",
                  optional: true,
                },
                spec_refs: {
                  type: "array",
                  description: "Optional spec refs this slice satisfies.",
                  items: { type: "string" },
                  optional: true,
                },
                depends_on: {
                  type: "array",
                  description: "Optional dependency refs within the proposed slice set.",
                  items: { type: "string" },
                  optional: true,
                },
                acceptance_criteria: {
                  type: "array",
                  description: "Optional criteria that evidence must cover.",
                  items: { type: "string" },
                  optional: true,
                },
                planner_assumptions: {
                  type: "array",
                  description: "Optional assumptions for this slice.",
                  items: { type: "string" },
                  optional: true,
                },
                structural_assumptions: {
                  type: "array",
                  description: "Optional structural assumptions for this slice.",
                  items: { type: "string" },
                  optional: true,
                },
                slice_gate_resolver: {
                  type: "string",
                  description: "Optional per-slice override for the slice gate resolver.",
                  enum: ["user", "policy"],
                  optional: true,
                },
                executor_binding: {
                  type: "object",
                  description:
                    "Optional per-slice executor binding selecting which engine runs this slice. Shape: { kind: 'llm', profileId, modelOverride? } or { kind: 'acp', adapterId, timeoutMs? }.",
                  optional: true,
                  properties: {
                    kind: { type: "string", enum: ["llm", "acp"] },
                    profileId: { type: "string", optional: true },
                    modelOverride: { type: "string", optional: true },
                    adapterId: { type: "string", optional: true },
                    timeoutMs: { type: "number", optional: true },
                  },
                },
              },
              required: ["name", "goal"],
              additionalProperties: false,
            },
          },
        },
        async ({
          query,
          strategy,
          max_agents,
          goal_id,
          goal_version,
          spec_id,
          spec_version,
          planned_commit,
          planner_assumptions,
          structural_assumptions,
          slice_gate_resolver,
          budget,
          slices,
        }) =>
          plans.createPlanRevision({
            query: query as string,
            strategy: normalizeString(strategy),
            max_agents: normalizeNumber(max_agents),
            goal_id: normalizeString(goal_id),
            goal_version: normalizeNumber(goal_version),
            spec_id: normalizeString(spec_id),
            spec_version: normalizeNumber(spec_version),
            planned_commit: normalizeString(planned_commit),
            planner_assumptions: normalizeStringList(planner_assumptions) ?? [],
            structural_assumptions: normalizeStringList(structural_assumptions) ?? [],
            slice_gate_resolver: normalizeGateResolver(slice_gate_resolver),
            budget: normalizePlanBudgetInput(budget),
            slices: normalizeTaskList(slices),
          }),
        {
          label: "Create Plan Revision",
          description:
            "Create a proposed docs/12 plan revision and open a user-resolved plan_accept gate.",
          estimate: "instant",
        },
      ),
      accept_plan_revision: action(
        {
          revision_id: "string",
          gate_id: {
            type: "string",
            description: "Optional accepted plan_accept gate id.",
            optional: true,
          },
        },
        async ({ revision_id, gate_id }) =>
          plans.acceptPlanRevision({
            revision_id: revision_id as string,
            gate_id: typeof gate_id === "string" ? gate_id : undefined,
          }),
        {
          label: "Accept Plan Revision",
          description:
            "Activate a proposed plan revision after its plan_accept gate has been accepted.",
          estimate: "instant",
        },
      ),
      submit_protocol_message: action(
        {
          kind: "string",
          from_role: "string",
          to_role: "string",
          summary: "string",
          body: {
            type: "string",
            description: "Optional message body.",
            optional: true,
          },
          artifact_refs: {
            type: "array",
            description: "Optional artifact refs.",
            items: { type: "string" },
            optional: true,
          },
          evidence_refs: {
            type: "array",
            description: "Optional evidence refs.",
            items: { type: "string" },
            optional: true,
          },
        },
        async ({ kind, from_role, to_role, summary, body, artifact_refs, evidence_refs }) =>
          messages.submitMessage({
            kind,
            from_role,
            to_role,
            summary: summary as string,
            body: normalizeString(body),
            artifact_refs: normalizeStringList(artifact_refs) ?? [],
            evidence_refs: normalizeStringList(evidence_refs) ?? [],
          }),
        {
          label: "Submit Protocol Message",
          description: "Append a typed orchestration protocol message.",
          estimate: "instant",
        },
      ),
      run_final_audit: action(async () => plans.runFinalAudit(), {
        label: "Run Final Audit",
        description:
          "Replay allowlisted evidence commands for the active plan and record the result.",
        estimate: "fast",
      }),
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
      record_budget_usage: action(
        {
          task_id: {
            type: "string",
            description: "Optional task/slice id that consumed the budget.",
            optional: true,
          },
          source: {
            type: "string",
            description: "Usage source: llm, manual, delegation, or external.",
            enum: ["llm", "manual", "delegation", "external"],
            optional: true,
          },
          model: {
            type: "string",
            description: "Optional model or service label for this usage.",
            optional: true,
          },
          input_tokens: {
            type: "number",
            description: "Input tokens consumed.",
            optional: true,
          },
          output_tokens: {
            type: "number",
            description: "Output tokens consumed.",
            optional: true,
          },
          total_tokens: {
            type: "number",
            description: "Total tokens consumed. Defaults to input_tokens + output_tokens.",
            optional: true,
          },
          cost_usd: {
            type: "number",
            description: "Optional USD cost attributed to this usage.",
            optional: true,
          },
          evidence_refs: {
            type: "array",
            description: "Optional refs supporting the usage record.",
            items: { type: "string" },
            optional: true,
          },
        },
        async ({
          task_id,
          source,
          model,
          input_tokens,
          output_tokens,
          total_tokens,
          cost_usd,
          evidence_refs,
        }) =>
          plans.recordBudgetUsage({
            task_id: normalizeString(task_id),
            source: normalizeString(source),
            model: normalizeString(model),
            input_tokens: normalizeNumber(input_tokens),
            output_tokens: normalizeNumber(output_tokens),
            total_tokens: normalizeNumber(total_tokens),
            cost_usd: normalizeNumber(cost_usd),
            evidence_refs: normalizeStringList(evidence_refs) ?? [],
          }),
        {
          label: "Record Budget Usage",
          description:
            "Append token/cost budget usage for the active plan and open budget gates when caps are exceeded.",
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

import { existsSync } from "node:fs";

import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import { normalizeStringList, normalizeVerificationStatus } from "./normalization";
import { truncateText } from "./storage";
import { OPTIONAL_EXPECTED_VERSION_PARAM, type TaskStatus } from "./types";

export function buildTaskActions(
  wiring: DescriptorWiring,
  id: string,
  status: TaskStatus | "unknown" | undefined,
): ItemDescriptor["actions"] {
  const { repo, lifecycle, verification } = wiring;
  const hasResult = existsSync(repo.resultPath(id));
  const canReadResult =
    hasResult &&
    (status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "superseded");
  const actions: ItemDescriptor["actions"] = {
    ...(canReadResult
      ? {
          get_result: action(async () => verification.getResult(id), {
            label: "Get Result",
            description:
              "Read the full result.md for this terminal task. During running/verifying, use result_preview from task state instead of polling.",
            idempotent: true,
            estimate: "fast",
          }),
        }
      : {}),
    get_verifications: action(async () => verification.getVerifications(id), {
      label: "Get Verifications",
      description: "Read all recorded verification evidence for this task.",
      idempotent: true,
      estimate: "fast",
    }),
  };
  if (!status) return actions;

  const isPending = status === "pending";
  const isScheduled = status === "scheduled";
  const isRunning = status === "running";
  const isVerifying = status === "verifying";
  const isActive = isPending || isScheduled || isRunning || isVerifying;
  const canRecordVerification = isRunning || isVerifying || status === "completed";

  const depsMet = lifecycle.unmetDependencies(id).length === 0;

  if (canRecordVerification) {
    actions.record_verification = action(
      {
        kind: {
          type: "string",
          description:
            "Optional verification kind, e.g. build, test, lint, format, compile, smoke, review, benchmark, or check.",
          optional: true,
        },
        status: {
          type: "string",
          description:
            "Verification status: passed, failed, skipped, not_required, or unknown. Use not_required only when this task has no meaningful external check.",
          enum: ["passed", "failed", "skipped", "not_required", "unknown"],
        },
        summary: {
          type: "string",
          description: "Short human-readable outcome summary.",
        },
        criteria: {
          type: "array",
          description:
            "Optional acceptance criteria covered by this verification. Use criterion ids like ac-1/ac-2 from task state, or ['all'] only when the evidence truly covers every criterion.",
          items: { type: "string" },
          optional: true,
        },
        command: {
          type: "string",
          description:
            "Optional command or procedure used, e.g. 'npm run build' or 'manual browser smoke test'.",
          optional: true,
        },
        evidence: {
          type: "string",
          description:
            "Optional concise evidence: important output lines, observed result, or link/path to the artifact.",
          optional: true,
        },
        evidence_refs: {
          type: "array",
          description:
            "Optional artifact references that support the verification, e.g. file paths, command names, URLs, screenshot ids, or state paths.",
          items: { type: "string" },
          optional: true,
        },
      },
      async ({ kind, status, summary, criteria, command, evidence, evidence_refs }) =>
        verification.recordVerification({
          task_id: id,
          kind: typeof kind === "string" ? kind : undefined,
          status: normalizeVerificationStatus(status),
          summary: typeof summary === "string" ? summary : "",
          criteria: normalizeStringList(criteria),
          command: typeof command === "string" ? command : undefined,
          evidence: typeof evidence === "string" ? evidence : undefined,
          evidence_refs: normalizeStringList(evidence_refs),
        }),
      {
        label: "Record Verification",
        description:
          "Attach domain-neutral verification evidence to this task. If the task has acceptance_criteria, completion requires passed/not_required verification coverage for every criterion.",
        estimate: "instant",
      },
    );
  }

  if (isPending && depsMet) {
    actions.schedule = action(
      { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
      async ({ expected_version }) =>
        lifecycle.scheduleTask({
          task_id: id,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Schedule Task",
        description:
          "Claim this pending task for runtime scheduling. The scheduler uses this CAS-backed transition before spawning a delegated agent.",
        estimate: "instant",
      },
    );
    actions.start = action(
      { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
      async ({ expected_version }) =>
        lifecycle.startTask({
          task_id: id,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Start Task",
        description: "Mark the task as running.",
        estimate: "instant",
      },
    );
  }

  if (isScheduled && depsMet) {
    actions.start = action(
      { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
      async ({ expected_version }) =>
        lifecycle.startTask({
          task_id: id,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Start Task",
        description: "Move a scheduled task into running state.",
        estimate: "instant",
      },
    );
  }

  if (isActive) {
    actions.append_progress = action(
      { message: "string" },
      async ({ message }) => lifecycle.appendProgress({ task_id: id, message: message as string }),
      {
        label: "Append Progress",
        description: "Append a timestamped line to the task progress log.",
        estimate: "instant",
      },
    );
    actions.cancel = action(
      { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
      async ({ expected_version }) =>
        lifecycle.cancelTask({
          task_id: id,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Cancel Task",
        description: "Mark the task as cancelled.",
        dangerous: true,
        estimate: "instant",
      },
    );
  }

  if (isRunning || isVerifying) {
    actions.attach_result = action(
      {
        result: "string",
        expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
      },
      async ({ result, expected_version }) =>
        verification.attachResult({
          task_id: id,
          result: result as string,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Attach Result",
        description:
          "Attach a pushed child-agent result to result.md and move a running task to verifying without completing it.",
        estimate: "instant",
      },
    );
  }

  if (isRunning) {
    actions.start_verification = action(
      { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
      async ({ expected_version }) =>
        verification.startVerification({
          task_id: id,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Start Verification",
        description:
          "Move the task from running to verifying. After this, record a passed or not_required verification before completing.",
        estimate: "instant",
      },
    );
  }

  if (isVerifying) {
    actions.complete = action(
      {
        result: "string",
        expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
      },
      async ({ result, expected_version }) =>
        lifecycle.completeTask({
          task_id: id,
          result: result as string,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
          hasCompletionVerification: (taskId) => verification.hasCompletionVerification(taskId),
          missingAcceptanceCriteria: (taskId) => verification.missingAcceptanceCriteria(taskId),
        }),
      {
        label: "Complete Task",
        description:
          "Write the task result and mark it completed. Requires the task to be verifying with a passed or not_required verification already recorded.",
        estimate: "instant",
      },
    );
  }

  if (isActive) {
    actions.fail = action(
      {
        error: "string",
        expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
      },
      async ({ error, expected_version }) =>
        lifecycle.failTask({
          task_id: id,
          error: error as string,
          expected_version: typeof expected_version === "number" ? expected_version : undefined,
        }),
      {
        label: "Fail Task",
        description: "Mark the task as failed with an error message.",
        estimate: "instant",
      },
    );
  }

  return actions;
}

export function buildTasksDescriptor(wiring: DescriptorWiring) {
  const { repo, lifecycle, verification } = wiring;
  const ids = repo.listTaskIdsForPlan();
  const items: ItemDescriptor[] = ids.map((id) => {
    const def = repo.loadTaskDefinition(id);
    const state = repo.loadTaskState(id);
    const version = repo.taskVersion(id);
    const progress = repo.loadProgressTail(id);
    const verifications = repo.loadVerifications(id);
    const latestVerification = verifications.at(-1);
    const acceptanceCriteria = def?.acceptance_criteria ?? [];
    const coveredCriteria = verification.coveredAcceptanceCriteria(id, verifications);
    const missingCriteria = verification.missingAcceptanceCriteria(id, verifications);

    return {
      id,
      props: {
        id,
        plan_id: def?.plan_id,
        name: def?.name,
        goal: def?.goal,
        kind: def?.kind,
        depends_on: def?.depends_on,
        spec_refs: def?.spec_refs,
        audit_of: def?.audit_of,
        finding_refs: def?.finding_refs,
        acceptance_criteria: acceptanceCriteria,
        aliases: def?.aliases,
        client_ref: def?.client_ref,
        retry_of: def?.retry_of,
        created_at: def?.created_at,
        status: state?.status ?? "unknown",
        iteration: state?.iteration,
        message: state?.message,
        error: state?.error,
        scheduled_at: state?.scheduled_at,
        verification_started_at: state?.verification_started_at,
        completed_at: state?.completed_at,
        superseded_by: state?.superseded_by,
        version,
        progress_preview: truncateText(progress, 400),
        result_preview: repo.loadResultPreview(id),
        unmet_dependencies: lifecycle.unmetDependencies(id),
        verified:
          acceptanceCriteria.length > 0
            ? missingCriteria.length === 0
            : verifications.some((v) => v.status === "passed" || v.status === "not_required"),
        verification_coverage: {
          total: acceptanceCriteria.length,
          covered: coveredCriteria,
          missing: missingCriteria,
          complete: missingCriteria.length === 0,
        },
        verification_counts: {
          total: verifications.length,
          passed: verifications.filter((v) => v.status === "passed").length,
          failed: verifications.filter((v) => v.status === "failed").length,
          skipped: verifications.filter((v) => v.status === "skipped").length,
          not_required: verifications.filter((v) => v.status === "not_required").length,
          unknown: verifications.filter((v) => v.status === "unknown").length,
        },
        latest_verification: latestVerification
          ? {
              id: latestVerification.id,
              kind: latestVerification.kind,
              status: latestVerification.status,
              summary: latestVerification.summary,
              criteria: latestVerification.criteria,
              command: latestVerification.command,
              evidence_refs: latestVerification.evidence_refs,
              created_at: latestVerification.created_at,
            }
          : undefined,
      },
      summary: def ? `${def.name}: ${def.goal}` : id,
      actions: buildTaskActions(wiring, id, state?.status),
      meta: {
        salience:
          state?.status === "running"
            ? 0.9
            : state?.status === "verifying"
              ? 0.9
              : state?.status === "scheduled"
                ? 0.85
                : state?.status === "failed" || state?.status === "cancelled"
                  ? 0.8
                  : state?.status === "pending"
                    ? 0.7
                    : state?.status === "superseded"
                      ? 0.2
                      : 0.4,
      },
    };
  });

  return {
    type: "collection",
    props: {
      count: items.length,
    },
    summary: `Tasks in plan (${items.length}).`,
    items,
  };
}

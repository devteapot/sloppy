import type { SlopNode } from "@slop-ai/consumer/browser";

import type { ConsumerHub } from "../../core/consumer";
import { debug } from "../../core/debug";
import type { TaskContext } from "../../core/role";

type TaskInfo = {
  id: string;
  name?: string;
  kind?: string;
  goal?: string;
  dependsOn: string[];
  specRefs: string[];
  auditOf?: string;
  findingRefs: string[];
  acceptanceCriteria: Array<{ id?: string; text?: string }>;
  resultPreview?: string;
};

type FindingInfo = {
  id: string;
  severity?: string;
  status?: string;
  summary?: string;
  targetTaskId?: string;
  auditTaskId?: string;
  specRefs: string[];
  evidenceRefs: string[];
  recommendation?: string;
};

type SpecRequirementInfo = {
  id: string;
  text?: string;
  priority?: string;
  status?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayProp(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function acceptanceCriteriaProp(
  record: Record<string, unknown>,
): Array<{ id?: string; text?: string }> {
  const value = record.acceptance_criteria;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => ({
      id: stringProp(item, "id"),
      text: stringProp(item, "text"),
    }))
    .filter((item) => item.id || item.text);
}

function parseTaskInfo(node: SlopNode | null): TaskInfo | null {
  if (!node) return null;
  const props = asRecord(node.properties);
  const id = stringProp(props, "id") ?? node.id;
  if (!id) return null;
  return {
    id,
    name: stringProp(props, "name"),
    kind: stringProp(props, "kind"),
    goal: stringProp(props, "goal"),
    dependsOn: stringArrayProp(props, "depends_on"),
    specRefs: stringArrayProp(props, "spec_refs"),
    auditOf: stringProp(props, "audit_of"),
    findingRefs: stringArrayProp(props, "finding_refs"),
    acceptanceCriteria: acceptanceCriteriaProp(props),
    resultPreview: stringProp(props, "result_preview"),
  };
}

function parseFindingInfo(node: SlopNode): FindingInfo | null {
  const props = asRecord(node.properties);
  const id = stringProp(props, "id") ?? node.id;
  if (!id) return null;
  return {
    id,
    severity: stringProp(props, "severity"),
    status: stringProp(props, "status"),
    summary: stringProp(props, "summary"),
    targetTaskId: stringProp(props, "target_task_id"),
    auditTaskId: stringProp(props, "audit_task_id"),
    specRefs: stringArrayProp(props, "spec_refs"),
    evidenceRefs: stringArrayProp(props, "evidence_refs"),
    recommendation: stringProp(props, "recommendation"),
  };
}

function parseSpecRequirements(
  specsTree: SlopNode | null,
  specRefs: string[],
): SpecRequirementInfo[] {
  if (!specsTree || specRefs.length === 0) return [];
  const wanted = new Set(specRefs);
  const requirements: SpecRequirementInfo[] = [];
  for (const spec of specsTree.children ?? []) {
    for (const child of spec.children ?? []) {
      if (child.id !== "requirements") continue;
      for (const requirement of child.children ?? []) {
        const props = asRecord(requirement.properties);
        const id = stringProp(props, "id") ?? requirement.id;
        if (!wanted.has(id)) continue;
        requirements.push({
          id,
          text: stringProp(props, "text"),
          priority: stringProp(props, "priority"),
          status: stringProp(props, "status"),
        });
      }
    }
  }
  return requirements;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatTaskLine(task: TaskInfo): string {
  const pieces = [
    `id=${task.id}`,
    task.name ? `name=${task.name}` : undefined,
    task.kind ? `kind=${task.kind}` : undefined,
    task.goal ? `goal=${task.goal}` : undefined,
  ].filter((piece): piece is string => Boolean(piece));
  return `- ${pieces.join("; ")}`;
}

function kindGuidance(kind: string | undefined): string {
  switch (kind) {
    case "audit":
      return "## Role Guidance\n- Compare the audit target result, relevant files, acceptance criteria, and spec refs.\n- Return structured findings in prose with severity, spec refs, evidence refs, and recommendation.\n- Do not repair directly unless the task explicitly asks for repair.";
    case "repair":
      return "## Role Guidance\n- Fix the linked findings only.\n- Explain how each finding was addressed and what evidence supports the fix.\n- Do not broaden scope beyond the finding and task contract.";
    case "docs":
      return "## Role Guidance\n- Document only behavior that is implemented or explicitly specified.\n- Check scripts, filenames, and feature claims against the workspace before writing docs.";
    case "verification":
      return "## Role Guidance\n- Run the narrowest relevant checks.\n- Report commands, pass/fail status, and evidence refs.\n- Do not make repairs; report failures clearly.";
    default:
      return "## Role Guidance\n- Implement only this task's slice.\n- Satisfy the listed spec refs and acceptance criteria.\n- Report evidence and any unresolved drift in your final result.";
  }
}

export interface OrchestrationTaskContextOptions {
  hub: ConsumerHub;
  providerId: string;
  taskId: string | undefined;
  spawnName: string;
  spawnGoal: string;
  spawnId: string;
}

export function createOrchestrationTaskContext(
  options: OrchestrationTaskContextOptions,
): TaskContext {
  const { hub, providerId, spawnName, spawnGoal, spawnId } = options;
  let taskId = options.taskId;

  async function queryParentState(pid: string, path: string, depth = 2): Promise<SlopNode | null> {
    try {
      return await hub.queryState({
        providerId: pid,
        path,
        depth,
        maxNodes: 120,
      });
    } catch (error) {
      debug("sub-agent", "work_packet_query_failed", {
        id: spawnId,
        providerId: pid,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function loadDependencyTasks(task: TaskInfo): Promise<TaskInfo[]> {
    if (task.dependsOn.length === 0) return [];
    const tasks = await Promise.all(
      task.dependsOn.map(async (id) =>
        parseTaskInfo(await queryParentState(providerId, `/tasks/${id}`, 2)),
      ),
    );
    return tasks.filter((item): item is TaskInfo => item !== null);
  }

  async function loadRelevantFindings(task: TaskInfo): Promise<FindingInfo[]> {
    const tree = await queryParentState(providerId, "/findings", 2);
    const findingRefs = new Set(task.findingRefs);
    return (tree?.children ?? [])
      .map((node) => parseFindingInfo(node))
      .filter((finding): finding is FindingInfo => {
        if (!finding) return false;
        if (findingRefs.has(finding.id)) return true;
        return task.kind === "repair" && finding.targetTaskId === task.id;
      });
  }

  async function loadSpecRequirements(
    task: TaskInfo,
    targetTask: TaskInfo | null,
    findings: FindingInfo[],
  ): Promise<SpecRequirementInfo[]> {
    const refs = [
      ...task.specRefs,
      ...(targetTask?.specRefs ?? []),
      ...findings.flatMap((finding) => finding.specRefs),
    ];
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length === 0) return [];
    const specsTree = await queryParentState("spec", "/specs", 5);
    return parseSpecRequirements(specsTree, uniqueRefs);
  }

  function formatWorkPacket(input: {
    task: TaskInfo;
    dependencyTasks: TaskInfo[];
    targetTask: TaskInfo | null;
    findings: FindingInfo[];
    specRequirements: SpecRequirementInfo[];
  }): string {
    const { task, dependencyTasks, targetTask, findings, specRequirements } = input;
    const sections = [
      "# Delegated Work Packet",
      "",
      "You are a scoped sub-agent. Do the leaf work for this task only. Do not create planning tasks, spawn agents, or modify specs/findings directly; report any needed plan/spec/finding changes in your final result.",
      "",
      "## Task",
      formatTaskLine(task),
      `- spec_refs: ${formatList(task.specRefs)}`,
      `- depends_on: ${formatList(task.dependsOn)}`,
      task.auditOf ? `- audit_of: ${task.auditOf}` : undefined,
      task.findingRefs.length > 0 ? `- finding_refs: ${formatList(task.findingRefs)}` : undefined,
      "",
      "## Acceptance Criteria",
      ...(task.acceptanceCriteria.length > 0
        ? task.acceptanceCriteria.map(
            (criterion) => `- ${criterion.id ? `${criterion.id}: ` : ""}${criterion.text ?? ""}`,
          )
        : ["- none provided; use the task goal and relevant spec refs as the contract."]),
      "",
      kindGuidance(task.kind),
    ];

    if (specRequirements.length > 0) {
      sections.push(
        "",
        "## Relevant Spec Requirements",
        ...specRequirements.map(
          (requirement) =>
            `- ${requirement.id}${requirement.priority ? ` (${requirement.priority})` : ""}: ${requirement.text ?? ""}`,
        ),
      );
    }

    if (targetTask) {
      sections.push(
        "",
        "## Audit Target",
        formatTaskLine(targetTask),
        `- result_preview: ${targetTask.resultPreview ?? "not available"}`,
      );
    }

    if (dependencyTasks.length > 0) {
      sections.push(
        "",
        "## Dependency Results",
        ...dependencyTasks.flatMap((dependency) => [
          formatTaskLine(dependency),
          `  result_preview: ${dependency.resultPreview ?? "not available"}`,
        ]),
      );
    }

    if (findings.length > 0) {
      sections.push(
        "",
        "## Linked Findings",
        ...findings.map(
          (finding) =>
            `- ${finding.id} (${finding.severity ?? "unknown"}/${finding.status ?? "unknown"}): ${finding.summary ?? ""}; recommendation=${finding.recommendation ?? "unknown"}; spec_refs=${formatList(finding.specRefs)}; evidence_refs=${formatList(finding.evidenceRefs)}`,
        ),
      );
    }

    sections.push(
      "",
      "## Final Result Contract",
      "- Summarize what you changed or verified.",
      "- List files changed or inspected when applicable.",
      "- Include commands run and important output lines for verification work.",
      "- If you find spec drift or unresolved risk, report it explicitly with evidence refs instead of editing planning state yourself.",
    );

    return sections.filter((section): section is string => section !== undefined).join("\n");
  }

  return {
    disableBuiltinProviders: ["orchestration", "spec"],

    async ensureTask() {
      if (taskId) {
        debug("sub-agent", "orchestration_task_attached", {
          id: spawnId,
          orchestrationTaskId: taskId,
        });
        return;
      }
      try {
        const createTask = () =>
          hub.invoke(providerId, "/orchestration", "create_task", {
            name: spawnName,
            goal: spawnGoal,
          });
        let result = await createTask();
        if (result.status === "error" && result.error?.code === "no_active_plan") {
          await hub.invoke(providerId, "/orchestration", "create_plan", {
            query: `Delegated task: ${spawnName}`,
            strategy: "single",
            max_agents: 1,
          });
          result = await createTask();
        }
        if (result.status === "ok") {
          const data = result.data as { id?: string };
          if (data?.id) {
            taskId = data.id;
            debug("sub-agent", "orchestration_task_created", {
              id: spawnId,
              orchestrationTaskId: data.id,
            });
          }
        } else {
          debug("sub-agent", "orchestration_task_create_failed", {
            id: spawnId,
            status: result.status,
          });
        }
      } catch (error) {
        debug("sub-agent", "orchestration_task_create_error", {
          id: spawnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async buildInitialPrompt(goal) {
      if (!taskId) {
        return goal;
      }

      const task = parseTaskInfo(await queryParentState(providerId, `/tasks/${taskId}`, 2));
      if (!task) {
        return `${goal}\n\nContext note: planning task state was unavailable; proceed from the explicit goal only.`;
      }

      const dependencyTasks = await loadDependencyTasks(task);
      const targetTask = task.auditOf
        ? parseTaskInfo(await queryParentState(providerId, `/tasks/${task.auditOf}`, 2))
        : null;
      const findings = await loadRelevantFindings(task);
      const specRequirements = await loadSpecRequirements(task, targetTask, findings);

      return formatWorkPacket({
        task,
        dependencyTasks,
        targetTask,
        findings,
        specRequirements,
      });
    },

    async recordTransition(action) {
      if (!taskId) return;
      try {
        await hub.invoke(providerId, `/tasks/${taskId}`, action, {});
      } catch (error) {
        debug("sub-agent", "record_task_transition_error", {
          id: spawnId,
          action,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async recordCompletion(result) {
      if (!taskId) return;
      if (!result) {
        await this.recordTransition("start_verification");
        return;
      }
      try {
        const invokeResult = await hub.invoke(providerId, `/tasks/${taskId}`, "attach_result", {
          result,
        });
        if (invokeResult.status === "error") {
          debug("sub-agent", "attach_result_failed", {
            id: spawnId,
            taskId,
            error: invokeResult.error?.message,
          });
          await this.recordTransition("start_verification");
        }
      } catch (error) {
        debug("sub-agent", "attach_result_error", {
          id: spawnId,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.recordTransition("start_verification");
      }
    },

    async recordFailure(error) {
      if (!taskId) return;
      try {
        await hub.invoke(providerId, `/tasks/${taskId}`, "fail", { error });
      } catch (err) {
        debug("sub-agent", "record_task_failure_error", {
          id: spawnId,
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

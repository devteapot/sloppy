import type { SlopNode } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../../config/schema";
import type { ConsumerHub } from "../../core/consumer";
import { debug } from "../../core/debug";
import type { LlmProfileManager } from "../../llm/profile-manager";
import { InProcessTransport } from "../../providers/builtin/in-process";
import type { RegisteredProvider } from "../../providers/registry";
import { AgentSessionProvider } from "../../session/provider";
import { type SessionAgentFactory, SessionRuntime } from "../../session/runtime";

export type SubAgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type SubAgentEvent = {
  id: string;
  status: SubAgentStatus;
  resultPreview?: string;
  error?: string;
  completedAt?: string;
};

type SubAgentListener = (event: SubAgentEvent) => void;

type TaskContext = {
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

type FindingContext = {
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

type SpecRequirementContext = {
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

function parseTaskContext(node: SlopNode | null): TaskContext | null {
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

function parseFindingContext(node: SlopNode): FindingContext | null {
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
): SpecRequirementContext[] {
  if (!specsTree || specRefs.length === 0) return [];
  const wanted = new Set(specRefs);
  const requirements: SpecRequirementContext[] = [];
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

function formatTaskLine(task: TaskContext): string {
  const pieces = [
    `id=${task.id}`,
    task.name ? `name=${task.name}` : undefined,
    task.kind ? `kind=${task.kind}` : undefined,
    task.goal ? `goal=${task.goal}` : undefined,
  ].filter((piece): piece is string => Boolean(piece));
  return `- ${pieces.join("; ")}`;
}

export interface SubAgentRunnerOptions {
  id: string;
  name: string;
  goal: string;
  model?: string;
  parentHub: ConsumerHub;
  parentConfig: SloppyConfig;
  agentFactory?: SessionAgentFactory;
  llmProfileManager?: LlmProfileManager;
  providerIdPrefix?: string;
  orchestrationProviderId?: string;
  orchestrationTaskId?: string;
}

export class SubAgentRunner {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly model?: string;
  readonly sessionProviderId: string;

  private parentHub: ConsumerHub;
  private runtime: SessionRuntime;
  private provider: AgentSessionProvider;
  private status: SubAgentStatus = "pending";
  private listeners = new Set<SubAgentListener>();
  private unsubscribeStore: (() => void) | null = null;
  private resultText?: string;
  private errorMessage?: string;
  private completedAt?: string;
  private registered = false;
  private orchestrationProviderId?: string;
  private orchestrationTaskId?: string;
  private sawTurnInFlight = false;

  constructor(options: SubAgentRunnerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.goal = options.goal;
    this.model = options.model;
    this.parentHub = options.parentHub;
    this.orchestrationProviderId = options.orchestrationProviderId;
    this.orchestrationTaskId = options.orchestrationTaskId;
    this.sessionProviderId = `${options.providerIdPrefix ?? "sub-agent"}-${options.id}`;

    // Sub-agents do leaf work. Strip the orchestration/delegation providers so
    // they can't re-enter planning mode and recurse. The child runtime is
    // constructed with the default role (no orchestrator role profile), so the
    // orchestrator system prompt and tool policy do not apply. The parent hub
    // still federates the child's session tree back to the orchestrator via
    // AgentSessionProvider.
    const childConfig = {
      ...options.parentConfig,
      providers: {
        ...options.parentConfig.providers,
        builtin: {
          ...options.parentConfig.providers.builtin,
          orchestration: false,
          delegation: false,
          spec: false,
        },
      },
    };

    this.runtime = new SessionRuntime({
      config: childConfig,
      sessionId: this.sessionProviderId,
      title: options.name,
      agentFactory: options.agentFactory,
      llmProfileManager: options.llmProfileManager,
      parentActorId: "orchestrator",
      taskId: options.orchestrationTaskId,
    });

    this.provider = new AgentSessionProvider(this.runtime, {
      providerId: this.sessionProviderId,
      providerName: `Sub-agent: ${options.name}`,
    });
  }

  onChange(listener: SubAgentListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): SubAgentEvent {
    return {
      id: this.id,
      status: this.status,
      resultPreview: this.resultText,
      error: this.errorMessage,
      completedAt: this.completedAt,
    };
  }

  async start(): Promise<void> {
    const registered: RegisteredProvider = {
      id: this.sessionProviderId,
      name: `Sub-agent: ${this.name}`,
      kind: "builtin",
      transport: new InProcessTransport(this.provider.server),
      transportLabel: "in-process",
      stop: () => this.provider.stop(),
    };

    this.unsubscribeStore = this.runtime.store.onChange(() => {
      this.syncFromStore();
    });

    try {
      await this.runtime.start();
      const added = await this.parentHub.addProvider(registered);
      this.registered = added;

      debug("sub-agent", "start", {
        id: this.id,
        name: this.name,
        sessionProviderId: this.sessionProviderId,
        registered: added,
      });

      await this.createOrchestrationTask();
      // Record the orchestration-level start BEFORE kicking off the turn so
      // that a fast-completing child doesn't race ahead of the task-level
      // `start` affordance (which gates `complete`).
      await this.recordTaskTransition("start");
      this.transition("running");
      await this.runtime.sendMessage(await this.buildInitialPrompt());
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.completedAt = new Date().toISOString();
      await this.recordTaskFailure(this.errorMessage);
      this.transition("failed");
    }
  }

  async cancel(): Promise<void> {
    if (this.status === "completed" || this.status === "failed" || this.status === "cancelled") {
      return;
    }

    try {
      await this.runtime.cancelTurn();
    } catch {
      // best-effort: runtime may not have an active turn
    }

    this.completedAt = new Date().toISOString();
    await this.recordTaskTransition("cancel");
    this.transition("cancelled");
    this.teardown();
  }

  getResult(): string | undefined {
    return this.resultText;
  }

  shutdown(): void {
    this.teardown();
  }

  private teardown(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;

    if (this.registered) {
      this.parentHub.removeProvider(this.sessionProviderId);
      this.registered = false;
    }

    try {
      this.runtime.shutdown();
    } catch {
      // ignore shutdown errors
    }
  }

  private syncFromStore(): void {
    if (this.status === "cancelled" || this.status === "failed" || this.status === "completed") {
      return;
    }

    const snapshot = this.runtime.store.getSnapshot();
    const turnState = snapshot.turn.state;

    if (turnState === "running" || turnState === "waiting_approval") {
      this.sawTurnInFlight = true;
      if (this.status === "pending") {
        this.transition("running");
      }
      return;
    }

    debug("sub-agent", "sync_from_store", {
      id: this.id,
      turnState,
      sawTurnInFlight: this.sawTurnInFlight,
      status: this.status,
    });

    if (turnState === "error") {
      this.errorMessage = snapshot.turn.lastError ?? "Sub-agent turn failed.";
      this.completedAt = new Date().toISOString();
      void this.recordTaskFailure(this.errorMessage);
      this.transition("failed");
      this.teardown();
      return;
    }

    if (
      turnState === "idle" &&
      this.sawTurnInFlight &&
      (this.status === "running" || this.status === "pending")
    ) {
      const transcript = snapshot.transcript;
      const lastAssistant = [...transcript]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant) {
        const text = lastAssistant.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
        this.resultText = text.length > 0 ? text : undefined;
      }

      this.completedAt = new Date().toISOString();
      void this.recordTaskReadyForVerification();
      this.transition("completed");
      this.teardown();
    }
  }

  private async queryParentState(
    providerId: string,
    path: string,
    depth = 2,
  ): Promise<SlopNode | null> {
    try {
      return await this.parentHub.queryState({
        providerId,
        path,
        depth,
        maxNodes: 120,
      });
    } catch (error) {
      debug("sub-agent", "work_packet_query_failed", {
        id: this.id,
        providerId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async buildInitialPrompt(): Promise<string> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) {
      return this.goal;
    }

    const task = parseTaskContext(
      await this.queryParentState(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        2,
      ),
    );
    if (!task) {
      return `${this.goal}\n\nContext note: orchestration task state was unavailable; proceed from the explicit goal only.`;
    }

    const dependencyTasks = await this.loadDependencyTasks(task);
    const targetTask = task.auditOf
      ? parseTaskContext(
          await this.queryParentState(this.orchestrationProviderId, `/tasks/${task.auditOf}`, 2),
        )
      : null;
    const findings = await this.loadRelevantFindings(task);
    const specRequirements = await this.loadSpecRequirements(task, targetTask, findings);

    return this.formatWorkPacket({
      task,
      dependencyTasks,
      targetTask,
      findings,
      specRequirements,
    });
  }

  private async loadDependencyTasks(task: TaskContext): Promise<TaskContext[]> {
    if (!this.orchestrationProviderId || task.dependsOn.length === 0) {
      return [];
    }
    const providerId = this.orchestrationProviderId;
    const tasks = await Promise.all(
      task.dependsOn.map(async (taskId) =>
        parseTaskContext(await this.queryParentState(providerId, `/tasks/${taskId}`, 2)),
      ),
    );
    return tasks.filter((item): item is TaskContext => item !== null);
  }

  private async loadRelevantFindings(task: TaskContext): Promise<FindingContext[]> {
    if (!this.orchestrationProviderId) return [];
    const tree = await this.queryParentState(this.orchestrationProviderId, "/findings", 2);
    const findingRefs = new Set(task.findingRefs);
    return (tree?.children ?? [])
      .map((node) => parseFindingContext(node))
      .filter((finding): finding is FindingContext => {
        if (!finding) return false;
        if (findingRefs.has(finding.id)) return true;
        return task.kind === "repair" && finding.targetTaskId === task.id;
      });
  }

  private async loadSpecRequirements(
    task: TaskContext,
    targetTask: TaskContext | null,
    findings: FindingContext[],
  ): Promise<SpecRequirementContext[]> {
    const refs = [
      ...task.specRefs,
      ...(targetTask?.specRefs ?? []),
      ...findings.flatMap((finding) => finding.specRefs),
    ];
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length === 0) return [];
    const specsTree = await this.queryParentState("spec", "/specs", 5);
    return parseSpecRequirements(specsTree, uniqueRefs);
  }

  private formatWorkPacket(input: {
    task: TaskContext;
    dependencyTasks: TaskContext[];
    targetTask: TaskContext | null;
    findings: FindingContext[];
    specRequirements: SpecRequirementContext[];
  }): string {
    const { task, dependencyTasks, targetTask, findings, specRequirements } = input;
    const sections = [
      "# Delegated Work Packet",
      "",
      "You are a scoped sub-agent. Do the leaf work for this task only. Do not create orchestration tasks, spawn agents, or modify specs/findings directly; report any needed plan/spec/finding changes in your final result.",
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
      this.kindGuidance(task.kind),
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
      "- If you find spec drift or unresolved risk, report it explicitly with evidence refs instead of editing orchestration state yourself.",
    );

    return sections.filter((section): section is string => section !== undefined).join("\n");
  }

  private kindGuidance(kind: string | undefined): string {
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

  private async createOrchestrationTask(): Promise<void> {
    if (!this.orchestrationProviderId) return;
    if (this.orchestrationTaskId) {
      // Orchestrator pre-created the task via /orchestration.create_task and
      // handed us the id; attach to it instead of duplicating.
      debug("sub-agent", "orchestration_task_attached", {
        id: this.id,
        orchestrationTaskId: this.orchestrationTaskId,
      });
      return;
    }
    try {
      const providerId = this.orchestrationProviderId;
      if (!providerId) return;
      const createTask = () =>
        this.parentHub.invoke(providerId, "/orchestration", "create_task", {
          name: this.name,
          goal: this.goal,
        });
      let result = await createTask();
      if (result.status === "error" && result.error?.code === "no_active_plan") {
        await this.parentHub.invoke(providerId, "/orchestration", "create_plan", {
          query: `Delegated task: ${this.name}`,
          strategy: "single",
          max_agents: 1,
        });
        result = await createTask();
      }
      if (result.status === "ok") {
        const data = result.data as { id?: string };
        if (data?.id) {
          this.orchestrationTaskId = data.id;
          debug("sub-agent", "orchestration_task_created", {
            id: this.id,
            orchestrationTaskId: data.id,
          });
        }
      } else {
        debug("sub-agent", "orchestration_task_create_failed", {
          id: this.id,
          status: result.status,
        });
      }
    } catch (error) {
      debug("sub-agent", "orchestration_task_create_error", {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordTaskTransition(
    action: "start" | "cancel" | "start_verification",
  ): Promise<void> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) return;
    try {
      await this.parentHub.invoke(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        action,
        {},
      );
    } catch (error) {
      debug("sub-agent", "record_task_transition_error", {
        id: this.id,
        action,
        taskId: this.orchestrationTaskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordTaskReadyForVerification(): Promise<void> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) return;
    if (!this.resultText) {
      await this.recordTaskTransition("start_verification");
      return;
    }
    try {
      const result = await this.parentHub.invoke(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        "attach_result",
        { result: this.resultText },
      );
      if (result.status === "error") {
        debug("sub-agent", "attach_result_failed", {
          id: this.id,
          taskId: this.orchestrationTaskId,
          error: result.error?.message,
        });
        await this.recordTaskTransition("start_verification");
      }
    } catch (error) {
      debug("sub-agent", "attach_result_error", {
        id: this.id,
        taskId: this.orchestrationTaskId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.recordTaskTransition("start_verification");
    }
  }

  private async recordTaskFailure(error: string): Promise<void> {
    if (!this.orchestrationProviderId || !this.orchestrationTaskId) return;
    try {
      await this.parentHub.invoke(
        this.orchestrationProviderId,
        `/tasks/${this.orchestrationTaskId}`,
        "fail",
        { error },
      );
    } catch (err) {
      debug("sub-agent", "record_task_failure_error", {
        id: this.id,
        taskId: this.orchestrationTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private transition(next: SubAgentStatus): void {
    if (this.status === next) {
      return;
    }
    const from = this.status;
    this.status = next;
    debug("sub-agent", "transition", { id: this.id, from, to: next });
    const event = this.snapshot();
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

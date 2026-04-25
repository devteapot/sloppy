import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { debug } from "../../../core/debug";
import {
  buildAcceptanceCriteria,
  globSegmentToRegExp,
  looksLikeFileEvidenceRef,
  terminalTaskStatus,
  uniqueStrings,
} from "./classifiers";
import { dependencyCycle } from "./dag";
import {
  normalizeFindingRecommendation,
  normalizeFindingSeverity,
  normalizeHandoffKind,
  normalizeHandoffPriority,
  normalizeReference,
  normalizeStringList,
  normalizeTaskKind,
  normalizeTaskList,
  normalizeVerificationStatus,
} from "./normalization";
import { appendText, codedError, readJson, truncateText, writeJson } from "./storage";
import {
  ORCHESTRATION_DIR,
  OPTIONAL_EXPECTED_VERSION_PARAM,
  type AcceptanceCriterion,
  type AuditFinding,
  type AuditFindingRecommendation,
  type AuditFindingSeverity,
  type AuditFindingStatus,
  type CreateTaskParams,
  type Handoff,
  type HandoffKind,
  type HandoffPriority,
  type HandoffStatus,
  type Plan,
  type TaskDefinition,
  type TaskDraft,
  type TaskKind,
  type TaskState,
  type TaskStatus,
  type VerificationRecord,
  type VerificationStatus,
} from "./types";

export interface OrchestrationProviderOptions {
  workspaceRoot: string;
  sessionId?: string;
  progressTailMaxChars?: number;
}

export class OrchestrationProvider {
  readonly server: SlopServer;
  private workspaceRoot: string;
  private root: string;
  private sessionId: string;
  private progressTailMaxChars: number;
  private planVersions = new Map<string, number>();
  private taskVersions = new Map<string, number>();
  private handoffVersions = new Map<string, number>();
  private findingVersions = new Map<string, number>();

  constructor(options: OrchestrationProviderOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.root = resolve(this.workspaceRoot, ORCHESTRATION_DIR);
    this.sessionId = options.sessionId ?? "default";
    this.progressTailMaxChars = options.progressTailMaxChars ?? 2048;

    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "tasks"), { recursive: true });
    mkdirSync(join(this.root, "handoffs"), { recursive: true });
    mkdirSync(join(this.root, "findings"), { recursive: true });

    this.hydrateVersionsFromDisk();
    debug("orchestration", "hydrate", {
      plans: this.planVersions.size,
      tasks: this.taskVersions.size,
      handoffs: this.handoffVersions.size,
      findings: this.findingVersions.size,
    });

    this.server = createSlopServer({
      id: "orchestration",
      name: "Orchestration",
    });

    this.server.register("orchestration", () => this.buildRootDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
    this.server.register("handoffs", () => this.buildHandoffsDescriptor());
    this.server.register("findings", () => this.buildFindingsDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private planPath(): string {
    return join(this.root, "plan.json");
  }

  private taskDir(taskId: string): string {
    return join(this.root, "tasks", taskId);
  }

  private resultPath(taskId: string): string {
    return join(this.taskDir(taskId), "result.md");
  }

  private loadPlan(): Plan | null {
    return readJson<Plan>(this.planPath());
  }

  private loadTaskDefinition(taskId: string): TaskDefinition | null {
    return readJson<TaskDefinition>(join(this.taskDir(taskId), "definition.json"));
  }

  private loadTaskState(taskId: string): TaskState | null {
    return readJson<TaskState>(join(this.taskDir(taskId), "state.json"));
  }

  private loadProgressTail(taskId: string): string {
    const path = join(this.taskDir(taskId), "progress.md");
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf8");
    if (content.length <= this.progressTailMaxChars) return content;
    return `...[truncated head]\n${content.slice(-this.progressTailMaxChars)}`;
  }

  private loadResultPreview(taskId: string): string | undefined {
    const path = this.resultPath(taskId);
    if (!existsSync(path)) return undefined;
    return truncateText(readFileSync(path, "utf8"), 400);
  }

  private verificationsPath(taskId: string): string {
    return join(this.taskDir(taskId), "verifications.json");
  }

  private loadVerifications(taskId: string): VerificationRecord[] {
    return readJson<VerificationRecord[]>(this.verificationsPath(taskId)) ?? [];
  }

  private loadAcceptanceCriteria(taskId: string): AcceptanceCriterion[] {
    return this.loadTaskDefinition(taskId)?.acceptance_criteria ?? [];
  }

  private listTaskIds(): string[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private taskBelongsToPlan(definition: TaskDefinition | null, plan: Plan | null): boolean {
    if (!definition || !plan) {
      return false;
    }
    if (!plan.id) {
      return true;
    }
    return definition.plan_id === plan.id;
  }

  private listTaskIdsForPlan(plan = this.loadPlan()): string[] {
    if (!plan) {
      return [];
    }
    if (!plan.id) {
      return this.listTaskIds();
    }
    return this.listTaskIds().filter((id) =>
      this.taskBelongsToPlan(this.loadTaskDefinition(id), plan),
    );
  }

  private handoffPath(handoffId: string): string {
    return join(this.root, "handoffs", `${handoffId}.json`);
  }

  private findingsDir(): string {
    return join(this.root, "findings");
  }

  private findingPath(findingId: string): string {
    return join(this.findingsDir(), `${findingId}.json`);
  }

  private loadHandoff(handoffId: string): Handoff | null {
    return readJson<Handoff>(this.handoffPath(handoffId));
  }

  private loadFinding(findingId: string): AuditFinding | null {
    return readJson<AuditFinding>(this.findingPath(findingId));
  }

  private listHandoffs(): Handoff[] {
    const dir = join(this.root, "handoffs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<Handoff>(join(dir, entry.name)))
      .filter((handoff): handoff is Handoff => handoff !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private listFindings(): AuditFinding[] {
    const dir = this.findingsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<AuditFinding>(join(dir, entry.name)))
      .filter((finding): finding is AuditFinding => finding !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private listHandoffsForPlan(plan = this.loadPlan()): Handoff[] {
    if (!plan) {
      return [];
    }
    const handoffs = this.listHandoffs();
    if (!plan.id) {
      return handoffs;
    }
    return handoffs.filter((handoff) => handoff.plan_id === plan.id);
  }

  private listFindingsForPlan(plan = this.loadPlan()): AuditFinding[] {
    if (!plan) {
      return [];
    }
    const findings = this.listFindings();
    if (!plan.id) {
      return findings;
    }
    return findings.filter((finding) => {
      const auditTask = this.loadTaskDefinition(finding.audit_task_id);
      const targetTask = this.loadTaskDefinition(finding.target_task_id);
      return this.taskBelongsToPlan(auditTask, plan) || this.taskBelongsToPlan(targetTask, plan);
    });
  }

  private bumpVersion(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  private hydrateVersionsFromDisk(): void {
    const plan = readJson<Plan>(this.planPath());
    if (plan?.version !== undefined) {
      this.planVersions.set("plan", plan.version);
    }
    for (const id of this.listTaskIdsUnchecked()) {
      const state = readJson<TaskState>(join(this.taskDir(id), "state.json"));
      if (state?.version !== undefined) {
        this.taskVersions.set(id, state.version);
      }
    }
    const handoffDir = join(this.root, "handoffs");
    if (existsSync(handoffDir)) {
      for (const entry of readdirSync(handoffDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const handoff = readJson<Handoff>(join(handoffDir, entry.name));
        if (handoff?.version !== undefined) {
          this.handoffVersions.set(handoff.id, handoff.version);
        }
      }
    }
    const findingDir = this.findingsDir();
    if (existsSync(findingDir)) {
      for (const entry of readdirSync(findingDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const finding = readJson<AuditFinding>(join(findingDir, entry.name));
        if (finding?.version !== undefined) {
          this.findingVersions.set(finding.id, finding.version);
        }
      }
    }
  }

  private listTaskIdsUnchecked(): string[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  private planVersion(): number {
    return this.planVersions.get("plan") ?? 0;
  }

  private taskVersion(taskId: string): number {
    return this.taskVersions.get(taskId) ?? 0;
  }

  private findingVersion(findingId: string): number {
    return this.findingVersions.get(findingId) ?? 0;
  }

  private requireActivePlan(): Plan {
    const plan = this.loadPlan();
    if (!plan || plan.status !== "active") {
      throw codedError("no_active_plan", "No active orchestration plan exists.");
    }
    return plan;
  }

  private describeAvailableTasks(): string {
    const plan = this.loadPlan();
    const descriptions = this.listTaskIds()
      .filter((id) => this.taskBelongsToPlan(this.loadTaskDefinition(id), plan))
      .map((id) => {
        const definition = this.loadTaskDefinition(id);
        const aliases = definition?.aliases?.length
          ? ` aliases=${definition.aliases.join("/")}`
          : "";
        return definition ? `${definition.name}=${id}${aliases}` : id;
      })
      .join(", ");
    return descriptions || "none";
  }

  private taskReferenceMap(extraReferences?: Map<string, string>): Map<string, string> {
    const refs = new Map<string, string>();
    const plan = this.loadPlan();
    for (const id of this.listTaskIdsForPlan(plan)) {
      const definition = this.loadTaskDefinition(id);
      if (!definition) continue;
      const candidates = [
        id,
        definition.name,
        definition.client_ref,
        ...(definition.aliases ?? []),
      ].filter((candidate): candidate is string => typeof candidate === "string");
      for (const candidate of candidates) {
        refs.set(normalizeReference(candidate), id);
      }
    }
    for (const [key, value] of extraReferences ?? []) {
      refs.set(normalizeReference(key), value);
    }
    return refs;
  }

  private dependencyLabelsForPlan(plan: Plan): Map<string, string> {
    const labels = new Map<string, string>();
    for (const id of this.listTaskIdsForPlan(plan)) {
      const definition = this.loadTaskDefinition(id);
      labels.set(id, definition?.name ?? id);
    }
    return labels;
  }

  private dependencyGraphForPlan(
    plan: Plan,
    overrides?: Map<string, string[]>,
  ): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const id of this.listTaskIdsForPlan(plan)) {
      const definition = this.loadTaskDefinition(id);
      if (!definition) continue;
      graph.set(id, definition.depends_on);
    }
    for (const [taskId, dependsOn] of overrides ?? []) {
      graph.set(taskId, dependsOn);
    }
    return graph;
  }

  private assertAcyclicDependencies(
    graph: Map<string, string[]>,
    labels: Map<string, string>,
  ): void {
    const cycle = dependencyCycle(graph);
    if (!cycle) {
      return;
    }
    const formatted = cycle.map((taskId) => labels.get(taskId) ?? taskId).join(" -> ");
    throw codedError(
      "invalid_dependencies",
      `Dependency cycle detected: ${formatted}. Correct depends_on and retry; no new tasks were written.`,
    );
  }

  private resolveTaskDependencyReferences(
    dependsOn: string[],
    extraReferences?: Map<string, string>,
  ): string[] {
    const refs = this.taskReferenceMap(extraReferences);
    const resolved: string[] = [];
    const unknown: string[] = [];

    for (const dependency of dependsOn) {
      const id = refs.get(normalizeReference(dependency));
      if (!id) {
        unknown.push(dependency);
        continue;
      }
      resolved.push(id);
    }

    if (unknown.length > 0) {
      throw codedError(
        "invalid_dependencies",
        `depends_on must reference existing task ids, task names, client_ref values, or created aliases such as task-1. Unknown dependencies: ${unknown.join(", ")}. Available tasks: ${this.describeAvailableTasks()}.`,
      );
    }

    return uniqueStrings(resolved);
  }

  private resolveOptionalTaskReference(
    reference: string | undefined,
    field: string,
    extraReferences?: Map<string, string>,
  ): string | undefined {
    if (!reference) return undefined;
    const id = this.taskReferenceMap(extraReferences).get(normalizeReference(reference));
    if (!id) {
      throw codedError(
        `invalid_${field}`,
        `${field} must reference an existing task id, task name, client_ref value, or created alias. Unknown reference: ${reference}. Available tasks: ${this.describeAvailableTasks()}.`,
      );
    }
    return id;
  }

  private validateRetryOf(
    taskId: string,
    plan: Plan,
  ): { definition: TaskDefinition; state: TaskState } {
    const definition = this.loadTaskDefinition(taskId);
    const state = this.loadTaskState(taskId);
    if (!definition || !state || !this.taskBelongsToPlan(definition, plan)) {
      throw codedError("invalid_retry", `retry_of must reference an existing task id: ${taskId}.`);
    }
    if (
      state.status !== "failed" &&
      state.status !== "cancelled" &&
      state.status !== "superseded"
    ) {
      throw codedError(
        "invalid_retry",
        `retry_of must reference a failed, cancelled, or superseded task; ${taskId} is ${state.status}.`,
      );
    }
    return { definition, state };
  }

  private createPlan(params: {
    query: string;
    strategy?: string;
    max_agents?: number;
  }): Plan & { version: number } {
    const existing = this.loadPlan();
    if (existing && existing.status === "active") {
      throw new Error(`An active plan already exists for session ${existing.session_id}.`);
    }

    const plan: Plan = {
      id: `plan-${crypto.randomUUID().slice(0, 8)}`,
      session_id: this.sessionId,
      query: params.query,
      strategy: params.strategy ?? "sequential",
      max_agents: params.max_agents ?? 5,
      created_at: new Date().toISOString(),
      status: "active",
    };
    const version = this.bumpVersion(this.planVersions, "plan");
    writeJson(this.planPath(), { ...plan, version });
    debug("orchestration", "create_plan", { session: this.sessionId, version });
    this.server.refresh();
    return { ...plan, version };
  }

  private incompleteTasksForPlanCompletion(): string[] {
    const plan = this.loadPlan();
    return this.listTaskIdsForPlan(plan).filter((taskId) => {
      const state = this.loadTaskState(taskId);
      if (!state) return true;
      return (
        state.status !== "completed" &&
        state.status !== "cancelled" &&
        state.status !== "superseded"
      );
    });
  }

  private openBlockingFindingsForPlan(plan = this.loadPlan()): string[] {
    return this.listFindingsForPlan(plan)
      .filter((finding) => finding.status === "open" && finding.severity === "blocking")
      .map((finding) => finding.id);
  }

  private cancelUnfinishedTasksForPlan(plan: Plan): number {
    let cancelled = 0;
    for (const taskId of this.listTaskIdsForPlan(plan)) {
      const state = this.loadTaskState(taskId);
      if (!state || terminalTaskStatus(state.status)) continue;
      const result = this.updateTaskState(
        taskId,
        {
          status: "cancelled",
          message: "Cancelled because the orchestration plan was cancelled.",
          completed_at: new Date().toISOString(),
        },
        undefined,
      );
      if (!("error" in result)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private cancelPendingHandoffsForPlan(plan: Plan): number {
    let cancelled = 0;
    for (const handoff of this.listHandoffsForPlan(plan)) {
      if (handoff.status !== "pending") continue;
      const version = this.bumpVersion(this.handoffVersions, handoff.id);
      writeJson(this.handoffPath(handoff.id), {
        ...handoff,
        status: "cancelled",
        responded_at: new Date().toISOString(),
        version,
      });
      cancelled += 1;
    }
    return cancelled;
  }

  private completePlan(params: { status: "completed" | "cancelled"; expected_version?: number }): {
    status: Plan["status"];
    version: number;
  } {
    const plan = this.loadPlan();
    if (!plan) throw new Error("No plan exists.");
    const current = this.planVersion();
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "complete_plan_conflict", {
        expected: params.expected_version,
        current,
      });
      return { status: plan.status, version: current };
    }
    if (params.status === "completed") {
      const incomplete = this.incompleteTasksForPlanCompletion();
      if (incomplete.length > 0) {
        throw codedError(
          "plan_incomplete",
          `Cannot complete plan while non-superseded tasks are unfinished: ${incomplete.join(", ")}.`,
        );
      }
      const openBlockingFindings = this.openBlockingFindingsForPlan(plan);
      if (openBlockingFindings.length > 0) {
        throw codedError(
          "blocking_findings_open",
          `Cannot complete plan while blocking audit findings are open: ${openBlockingFindings.join(", ")}.`,
        );
      }
    }
    const cancelledTasks =
      params.status === "cancelled" ? this.cancelUnfinishedTasksForPlan(plan) : 0;
    const cancelledHandoffs =
      params.status === "cancelled" ? this.cancelPendingHandoffsForPlan(plan) : 0;
    const version = this.bumpVersion(this.planVersions, "plan");
    const next: Plan = { ...plan, status: params.status, version };
    writeJson(this.planPath(), next);
    debug("orchestration", "complete_plan", {
      status: params.status,
      version,
      cancelledTasks,
      cancelledHandoffs,
    });
    this.server.refresh();
    return { status: next.status, version };
  }

  private aliasesForNewTask(params: CreateTaskParams, ordinal: number): string[] {
    return uniqueStrings(
      [`task-${ordinal}`, `task ${ordinal}`, params.client_ref ?? ""]
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  private createTask(params: CreateTaskParams): {
    id: string;
    version: number;
    kind?: TaskKind;
    spec_refs?: string[];
    audit_of?: string;
    finding_refs?: string[];
    acceptance_criteria: AcceptanceCriterion[];
    depends_on: string[];
    retry_of?: string;
  } {
    const plan = this.requireActivePlan();
    const retrySource = params.retry_of ? this.validateRetryOf(params.retry_of, plan) : undefined;
    const auditOf = this.resolveOptionalTaskReference(params.audit_of, "audit_of");
    for (const findingId of params.finding_refs ?? []) {
      if (!this.loadFinding(findingId)) {
        throw codedError(
          "invalid_finding_ref",
          `finding_refs contains unknown finding: ${findingId}.`,
        );
      }
    }
    const dependsOn = this.resolveTaskDependencyReferences(
      params.depends_on ?? retrySource?.definition.depends_on ?? [],
    );
    const id = `task-${crypto.randomUUID().slice(0, 8)}`;
    const labels = this.dependencyLabelsForPlan(plan);
    labels.set(id, params.name);
    this.assertAcyclicDependencies(
      this.dependencyGraphForPlan(plan, new Map([[id, dependsOn]])),
      labels,
    );
    const ordinal = this.listTaskIdsForPlan(plan).length + 1;
    const acceptanceCriteria = buildAcceptanceCriteria(params.goal, params.acceptance_criteria);
    const definition: TaskDefinition = {
      id,
      ...(plan.id ? { plan_id: plan.id } : {}),
      name: params.name,
      goal: params.goal,
      kind: params.kind,
      depends_on: dependsOn,
      spec_refs: params.spec_refs,
      audit_of: auditOf,
      finding_refs: params.finding_refs,
      acceptance_criteria: acceptanceCriteria,
      aliases: this.aliasesForNewTask(params, ordinal),
      client_ref: params.client_ref,
      retry_of: params.retry_of,
      created_at: new Date().toISOString(),
    };
    const state: TaskState = {
      status: "pending",
      updated_at: definition.created_at,
      iteration: 0,
    };
    const version = this.bumpVersion(this.taskVersions, id);
    writeJson(join(this.taskDir(id), "definition.json"), definition);
    writeJson(join(this.taskDir(id), "state.json"), { ...state, version });
    debug("orchestration", "create_task", {
      id,
      name: params.name,
      depends_on: definition.depends_on,
      aliases: definition.aliases,
      client_ref: definition.client_ref,
      acceptance_criteria: definition.acceptance_criteria?.length ?? 0,
      retry_of: definition.retry_of,
      kind: definition.kind,
      spec_refs: definition.spec_refs,
      audit_of: definition.audit_of,
      finding_refs: definition.finding_refs,
      version,
    });
    if (params.retry_of) {
      this.updateTaskState(
        params.retry_of,
        { status: "superseded", superseded_by: id, completed_at: new Date().toISOString() },
        undefined,
      );
    }
    this.server.refresh();
    return {
      id,
      version,
      kind: params.kind,
      spec_refs: params.spec_refs,
      audit_of: auditOf,
      finding_refs: params.finding_refs,
      acceptance_criteria: acceptanceCriteria,
      depends_on: dependsOn,
      retry_of: params.retry_of,
    };
  }

  private createTasks(params: { tasks: CreateTaskParams[] }): {
    created: Array<{
      id: string;
      name: string;
      kind?: TaskKind;
      client_ref?: string;
      spec_refs?: string[];
      audit_of?: string;
      finding_refs?: string[];
      depends_on: string[];
      acceptance_criteria: AcceptanceCriterion[];
      version: number;
    }>;
  } {
    if (params.tasks.length === 0) {
      throw codedError("invalid_tasks", "create_tasks requires at least one valid task.");
    }

    const plan = this.requireActivePlan();
    const now = new Date().toISOString();
    const existingCount = this.listTaskIdsForPlan(plan).length;
    const drafts: TaskDraft[] = params.tasks.map((task, index) => {
      const id = `task-${crypto.randomUUID().slice(0, 8)}`;
      return {
        ...task,
        id,
        aliases: this.aliasesForNewTask(task, existingCount + index + 1),
      };
    });

    const batchReferences = new Map<string, string>();
    for (const draft of drafts) {
      for (const candidate of [
        draft.id,
        draft.name,
        draft.client_ref,
        ...(draft.aliases ?? []),
      ].filter((candidate): candidate is string => typeof candidate === "string")) {
        batchReferences.set(normalizeReference(candidate), draft.id);
      }
    }

    const resolvedDependencies = new Map<string, string[]>();
    for (const draft of drafts) {
      const dependsOn = this.resolveTaskDependencyReferences(
        draft.depends_on ?? [],
        batchReferences,
      );
      if (dependsOn.includes(draft.id)) {
        throw codedError("invalid_dependencies", `Task ${draft.name} cannot depend on itself.`);
      }
      resolvedDependencies.set(draft.id, dependsOn);
    }

    const labels = this.dependencyLabelsForPlan(plan);
    for (const draft of drafts) {
      labels.set(draft.id, draft.name);
    }
    this.assertAcyclicDependencies(this.dependencyGraphForPlan(plan, resolvedDependencies), labels);

    const created: Array<{
      id: string;
      name: string;
      kind?: TaskKind;
      client_ref?: string;
      spec_refs?: string[];
      audit_of?: string;
      finding_refs?: string[];
      depends_on: string[];
      acceptance_criteria: AcceptanceCriterion[];
      version: number;
    }> = [];

    for (const draft of drafts) {
      const dependsOn = resolvedDependencies.get(draft.id) ?? [];
      const auditOf = this.resolveOptionalTaskReference(
        draft.audit_of,
        "audit_of",
        batchReferences,
      );
      for (const findingId of draft.finding_refs ?? []) {
        if (!this.loadFinding(findingId)) {
          throw codedError(
            "invalid_finding_ref",
            `finding_refs contains unknown finding: ${findingId}.`,
          );
        }
      }
      const acceptanceCriteria = buildAcceptanceCriteria(draft.goal, draft.acceptance_criteria);
      const definition: TaskDefinition = {
        id: draft.id,
        ...(plan.id ? { plan_id: plan.id } : {}),
        name: draft.name,
        goal: draft.goal,
        kind: draft.kind,
        depends_on: dependsOn,
        spec_refs: draft.spec_refs,
        audit_of: auditOf,
        finding_refs: draft.finding_refs,
        acceptance_criteria: acceptanceCriteria,
        aliases: draft.aliases,
        client_ref: draft.client_ref,
        created_at: now,
      };
      const state: TaskState = {
        status: "pending",
        updated_at: now,
        iteration: 0,
      };
      const version = this.bumpVersion(this.taskVersions, draft.id);
      writeJson(join(this.taskDir(draft.id), "definition.json"), definition);
      writeJson(join(this.taskDir(draft.id), "state.json"), { ...state, version });
      created.push({
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        client_ref: draft.client_ref,
        spec_refs: draft.spec_refs,
        audit_of: auditOf,
        finding_refs: draft.finding_refs,
        depends_on: dependsOn,
        acceptance_criteria: acceptanceCriteria,
        version,
      });
    }

    debug("orchestration", "create_tasks", {
      count: created.length,
      ids: created.map((task) => task.id),
    });
    this.server.refresh();
    return { created };
  }

  private updateTaskState(
    taskId: string,
    update: Partial<TaskState>,
    expectedVersion: number | undefined,
  ): { version: number; state: TaskState } | { error: "version_conflict"; currentVersion: number } {
    const state = this.loadTaskState(taskId);
    if (!state) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const current = this.taskVersion(taskId);
    if (expectedVersion !== undefined && expectedVersion !== current) {
      debug("orchestration", "task_version_conflict", {
        taskId,
        expected: expectedVersion,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }

    const version = this.bumpVersion(this.taskVersions, taskId);
    const next: TaskState = {
      ...state,
      ...update,
      updated_at: new Date().toISOString(),
      iteration: state.iteration + 1,
      version,
    };
    writeJson(join(this.taskDir(taskId), "state.json"), next);
    debug("orchestration", "update_task", {
      taskId,
      prev_status: state.status,
      next_status: next.status,
      version,
    });
    this.server.refresh();
    return { version, state: next };
  }

  private isDependencySatisfied(taskId: string): boolean {
    const state = this.loadTaskState(taskId);
    if (!state) return false;
    if (state.status === "completed") return true;
    if (state.status !== "superseded" || !state.superseded_by) return false;
    return this.loadTaskState(state.superseded_by)?.status === "completed";
  }

  private unmetDependencies(taskId: string): string[] {
    const def = this.loadTaskDefinition(taskId);
    if (!def?.depends_on?.length) return [];
    const unmet: string[] = [];
    for (const depId of def.depends_on) {
      if (!this.isDependencySatisfied(depId)) {
        unmet.push(depId);
      }
    }
    return unmet;
  }

  private startTask(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const state = this.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "pending" && state.status !== "scheduled") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} can only start from pending or scheduled (current status: ${state.status}).`,
      );
    }
    const unmet = this.unmetDependencies(params.task_id);
    if (unmet.length > 0) {
      throw new Error(
        `Cannot start task ${params.task_id}: unmet dependencies [${unmet.join(", ")}].`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "running" },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private scheduleTask(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const state = this.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "pending") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} can only be scheduled from pending (current status: ${state.status}).`,
      );
    }
    const unmet = this.unmetDependencies(params.task_id);
    if (unmet.length > 0) {
      throw new Error(
        `Cannot schedule task ${params.task_id}: unmet dependencies [${unmet.join(", ")}].`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      {
        status: "scheduled",
        message: "Scheduled for delegation.",
        scheduled_at: new Date().toISOString(),
      },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private startVerification(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const state = this.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "running" && state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} cannot enter verification from status ${state.status}.`,
      );
    }
    if (state.status === "verifying") {
      return { version: this.taskVersion(params.task_id), status: state.status };
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "verifying", verification_started_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private appendProgress(params: { task_id: string; message: string }): {
    version: number;
    bytes: number;
  } {
    if (!this.loadTaskState(params.task_id)) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    const timestamp = new Date().toISOString();
    appendText(
      join(this.taskDir(params.task_id), "progress.md"),
      `- [${timestamp}] ${params.message}`,
    );
    // progress.md is append-only; state.json is untouched so CAS versions
    // stay consistent across restarts. Return the current version unchanged.
    const version = this.taskVersion(params.task_id);
    this.server.refresh();
    return { version, bytes: params.message.length };
  }

  private attachResult(params: {
    task_id: string;
    result: string;
    expected_version?: number;
  }):
    | { version: number; status: TaskStatus; bytes: number }
    | { error: string; currentVersion: number } {
    const state = this.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "running" && state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} can only attach a pushed result while running or verifying (current status: ${state.status}).`,
      );
    }
    mkdirSync(this.taskDir(params.task_id), { recursive: true });
    writeFileSync(this.resultPath(params.task_id), params.result, "utf8");

    const update =
      state.status === "running"
        ? { status: "verifying" as const, verification_started_at: new Date().toISOString() }
        : {};
    const result = this.updateTaskState(params.task_id, update, params.expected_version);
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status, bytes: params.result.length };
  }

  private recordVerification(params: {
    task_id: string;
    kind?: string;
    status: VerificationStatus;
    summary: string;
    criteria?: string[];
    command?: string;
    evidence?: string;
    evidence_refs?: string[];
  }): {
    task_id: string;
    verification_id: string;
    status: VerificationStatus;
    count: number;
    covered_criteria: string[];
    missing_criteria: string[];
  } {
    const state = this.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status === "pending") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} must be running before verification can be recorded.`,
      );
    }
    if (
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "superseded"
    ) {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} is ${state.status}; verification cannot be recorded.`,
      );
    }
    if (state.status === "running") {
      this.updateTaskState(
        params.task_id,
        {
          status: "verifying",
          verification_started_at: new Date().toISOString(),
        },
        undefined,
      );
    }

    const verifications = this.loadVerifications(params.task_id);
    const criteria = this.normalizeVerificationCriteria(params.task_id, params.criteria);
    const evidenceRefs = params.evidence_refs ?? [];
    if (params.status === "passed" && criteria.length > 0 && evidenceRefs.length === 0) {
      throw codedError(
        "evidence_required",
        "Passed verification covering acceptance criteria must include evidence_refs with supporting files, commands, URLs, screenshots, or state paths.",
      );
    }
    const invalidEvidenceRefs = this.invalidEvidenceRefs(evidenceRefs);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }
    const record: VerificationRecord = {
      id: `verification-${crypto.randomUUID().slice(0, 8)}`,
      kind: params.kind?.trim() || "check",
      status: params.status,
      summary: params.summary,
      criteria,
      command: params.command,
      evidence: params.evidence,
      evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
      created_at: new Date().toISOString(),
    };
    const next = [...verifications, record];
    writeJson(this.verificationsPath(params.task_id), next);
    debug("orchestration", "record_verification", {
      taskId: params.task_id,
      verificationId: record.id,
      kind: record.kind,
      status: record.status,
    });
    this.server.refresh();
    return {
      task_id: params.task_id,
      verification_id: record.id,
      status: record.status,
      count: next.length,
      covered_criteria: this.coveredAcceptanceCriteria(params.task_id, next),
      missing_criteria: this.missingAcceptanceCriteria(params.task_id, next),
    };
  }

  private invalidEvidenceRefs(refs: string[]): string[] {
    const invalid: string[] = [];
    for (const ref of refs) {
      if (!looksLikeFileEvidenceRef(ref)) {
        continue;
      }
      if (!this.evidencePathExists(ref)) {
        invalid.push(ref);
      }
    }
    return invalid;
  }

  private evidencePathExists(ref: string): boolean {
    const trimmed = ref.trim();
    const fullPath = resolve(this.workspaceRoot, trimmed);
    const relativePath = relative(this.workspaceRoot, fullPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return false;
    }

    if (!/[?*]/.test(trimmed)) {
      return existsSync(fullPath);
    }

    const slash = trimmed.lastIndexOf("/");
    const parentRef = slash >= 0 ? trimmed.slice(0, slash) : ".";
    const pattern = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    if (/[?*]/.test(parentRef)) {
      return true;
    }
    const parentPath = resolve(this.workspaceRoot, parentRef);
    const parentRelative = relative(this.workspaceRoot, parentPath);
    if (parentRelative.startsWith("..") || isAbsolute(parentRelative) || !existsSync(parentPath)) {
      return false;
    }
    const regex = globSegmentToRegExp(pattern);
    return readdirSync(parentPath).some((entry) => regex.test(entry));
  }

  private normalizeVerificationCriteria(taskId: string, rawCriteria?: string[]): string[] {
    const criteria = this.loadAcceptanceCriteria(taskId);
    if (criteria.length === 0) {
      return [];
    }
    if (!rawCriteria || rawCriteria.length === 0) {
      return [];
    }

    const byReference = new Map<string, string>();
    for (const criterion of criteria) {
      byReference.set(normalizeReference(criterion.id), criterion.id);
      byReference.set(normalizeReference(criterion.text), criterion.id);
      const numeric = criterion.id.replace(/^ac-/, "");
      byReference.set(normalizeReference(numeric), criterion.id);
    }

    const ids: string[] = [];
    for (const item of rawCriteria) {
      const normalized = normalizeReference(item);
      if (normalized === "all" || normalized === "*") {
        ids.push(...criteria.map((criterion) => criterion.id));
        continue;
      }
      const id = byReference.get(normalized);
      if (id) {
        ids.push(id);
      }
    }

    return uniqueStrings(ids);
  }

  private coveredAcceptanceCriteria(
    taskId: string,
    verifications = this.loadVerifications(taskId),
  ): string[] {
    const covered = new Set<string>();
    for (const verification of verifications) {
      if (verification.status !== "passed" && verification.status !== "not_required") {
        continue;
      }
      for (const criterionId of verification.criteria ?? []) {
        covered.add(criterionId);
      }
    }
    return [...covered].sort();
  }

  private missingAcceptanceCriteria(
    taskId: string,
    verifications = this.loadVerifications(taskId),
  ): string[] {
    const covered = new Set(this.coveredAcceptanceCriteria(taskId, verifications));
    return this.loadAcceptanceCriteria(taskId)
      .map((criterion) => criterion.id)
      .filter((criterionId) => !covered.has(criterionId));
  }

  private hasCompletionVerification(taskId: string): boolean {
    const criteria = this.loadAcceptanceCriteria(taskId);
    if (criteria.length > 0) {
      return this.missingAcceptanceCriteria(taskId).length === 0;
    }

    return this.loadVerifications(taskId).some(
      (verification) => verification.status === "passed" || verification.status === "not_required",
    );
  }

  private completeTask(params: {
    task_id: string;
    result: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const state = this.loadTaskState(params.task_id);
    if (!state) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    if (state.status !== "verifying") {
      throw codedError(
        "invalid_state",
        `Task ${params.task_id} must be verifying before completion (current status: ${state.status}).`,
      );
    }
    if (!this.hasCompletionVerification(params.task_id)) {
      const missingCriteria = this.missingAcceptanceCriteria(params.task_id);
      const detail =
        missingCriteria.length > 0
          ? ` Missing acceptance criteria: ${missingCriteria.join(", ")}.`
          : "";
      throw codedError(
        "verification_required",
        `Task ${params.task_id} needs passed or not_required verification coverage before completion.${detail}`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "completed", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    if (params.result.length > 0) {
      const resultPath = this.resultPath(params.task_id);
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, params.result, "utf8");
    }
    return { version: result.version, status: result.state.status };
  }

  private failTask(params: {
    task_id: string;
    error: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const result = this.updateTaskState(
      params.task_id,
      { status: "failed", error: params.error, completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private cancelTask(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const result = this.updateTaskState(
      params.task_id,
      { status: "cancelled", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private getResult(taskId: string): { task_id: string; result: string | null } {
    const resultPath = this.resultPath(taskId);
    if (!existsSync(resultPath)) {
      return { task_id: taskId, result: null };
    }
    return { task_id: taskId, result: readFileSync(resultPath, "utf8") };
  }

  private getVerifications(taskId: string): {
    task_id: string;
    verifications: VerificationRecord[];
  } {
    return {
      task_id: taskId,
      verifications: this.loadVerifications(taskId),
    };
  }

  private recordFinding(params: {
    audit_task_id: string;
    target_task_id: string;
    severity: AuditFindingSeverity;
    spec_refs?: string[];
    summary: string;
    evidence_refs?: string[];
    recommendation: AuditFindingRecommendation;
  }): AuditFinding {
    const plan = this.requireActivePlan();
    if (!this.taskBelongsToPlan(this.loadTaskDefinition(params.audit_task_id), plan)) {
      throw codedError(
        "invalid_audit_task",
        `audit_task_id must reference a task in the active plan.`,
      );
    }
    if (!this.taskBelongsToPlan(this.loadTaskDefinition(params.target_task_id), plan)) {
      throw codedError(
        "invalid_target_task",
        `target_task_id must reference a task in the active plan.`,
      );
    }

    const evidenceRefs = params.evidence_refs ?? [];
    const invalidEvidenceRefs = this.invalidEvidenceRefs(evidenceRefs);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }

    const id = `finding-${crypto.randomUUID().slice(0, 8)}`;
    const finding: AuditFinding = {
      id,
      audit_task_id: params.audit_task_id,
      target_task_id: params.target_task_id,
      severity: params.severity,
      status: "open",
      spec_refs: params.spec_refs ?? [],
      summary: params.summary,
      evidence_refs: evidenceRefs,
      recommendation: params.recommendation,
      created_at: new Date().toISOString(),
      version: this.bumpVersion(this.findingVersions, id),
    };
    writeJson(this.findingPath(id), finding);
    debug("orchestration", "record_finding", {
      id,
      audit_task_id: finding.audit_task_id,
      target_task_id: finding.target_task_id,
      severity: finding.severity,
      recommendation: finding.recommendation,
    });
    this.server.refresh();
    return finding;
  }

  private resolveFinding(params: {
    finding_id: string;
    status: Exclude<AuditFindingStatus, "open">;
    reason?: string;
  }): { id: string; status: AuditFindingStatus; version: number } {
    const finding = this.loadFinding(params.finding_id);
    if (!finding) {
      throw new Error(`Unknown finding: ${params.finding_id}`);
    }
    if (finding.status !== "open") {
      throw new Error(`Finding ${params.finding_id} is already ${finding.status}.`);
    }
    const version = this.bumpVersion(this.findingVersions, params.finding_id);
    const next: AuditFinding = {
      ...finding,
      status: params.status,
      resolved_at: new Date().toISOString(),
      resolution_reason: params.reason,
      version,
    };
    writeJson(this.findingPath(params.finding_id), next);
    this.server.refresh();
    return { id: next.id, status: next.status, version };
  }

  private createRepairTask(params: {
    finding_id: string;
    name?: string;
    goal?: string;
    acceptance_criteria?: string[];
  }): {
    finding_id: string;
    repair_task_id: string;
    version: number;
  } {
    const finding = this.loadFinding(params.finding_id);
    if (!finding) {
      throw new Error(`Unknown finding: ${params.finding_id}`);
    }
    if (finding.status !== "open") {
      throw new Error(`Finding ${params.finding_id} is ${finding.status}; repair is not needed.`);
    }

    const task = this.createTask({
      name: params.name ?? `repair-${params.finding_id}`,
      goal:
        params.goal ??
        `Repair audit finding ${params.finding_id} for ${finding.target_task_id}: ${finding.summary}`,
      kind: "repair",
      spec_refs: finding.spec_refs,
      finding_refs: [finding.id],
      depends_on: [finding.target_task_id],
      acceptance_criteria: params.acceptance_criteria ?? [
        `Finding ${finding.id} is resolved or no longer applies after re-audit`,
      ],
    });

    const version = this.bumpVersion(this.findingVersions, params.finding_id);
    writeJson(this.findingPath(params.finding_id), {
      ...finding,
      repair_task_id: task.id,
      version,
    });
    this.server.refresh();
    return { finding_id: finding.id, repair_task_id: task.id, version };
  }

  private createHandoff(params: {
    from_task: string;
    to_task: string;
    request: string;
    kind?: HandoffKind;
    priority?: HandoffPriority;
    spec_refs?: string[];
    evidence_refs?: string[];
    blocks_task?: boolean;
  }): Handoff & { version: number } {
    const fromDefinition = this.loadTaskDefinition(params.from_task);
    const toDefinition = this.loadTaskDefinition(params.to_task);
    if (!fromDefinition) {
      throw new Error(`Unknown from_task: ${params.from_task}`);
    }
    if (!toDefinition) {
      throw new Error(`Unknown to_task: ${params.to_task}`);
    }
    const plan = this.requireActivePlan();
    if (!this.taskBelongsToPlan(fromDefinition, plan)) {
      throw new Error(`Unknown from_task: ${params.from_task}`);
    }
    if (!this.taskBelongsToPlan(toDefinition, plan)) {
      throw new Error(`Unknown to_task: ${params.to_task}`);
    }
    const invalidEvidenceRefs = this.invalidEvidenceRefs(params.evidence_refs ?? []);
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
    const version = this.bumpVersion(this.handoffVersions, id);
    writeJson(this.handoffPath(id), { ...handoff, version });
    debug("orchestration", "create_handoff", {
      id,
      from: params.from_task,
      to: params.to_task,
      version,
    });
    this.server.refresh();
    return { ...handoff, version };
  }

  private respondHandoff(params: {
    handoff_id: string;
    response: string;
    decision_refs?: string[];
    evidence_refs?: string[];
    unblock?: boolean;
    expected_version?: number;
  }): { version: number; status: HandoffStatus } | { error: string; currentVersion: number } {
    const handoff = this.loadHandoff(params.handoff_id);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${params.handoff_id}`);
    }
    const current = this.handoffVersions.get(params.handoff_id) ?? 0;
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
    const invalidEvidenceRefs = this.invalidEvidenceRefs(params.evidence_refs ?? []);
    if (invalidEvidenceRefs.length > 0) {
      throw codedError(
        "invalid_evidence_refs",
        `Evidence refs do not exist in the workspace: ${invalidEvidenceRefs.join(", ")}.`,
      );
    }
    const version = this.bumpVersion(this.handoffVersions, params.handoff_id);
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
    writeJson(this.handoffPath(params.handoff_id), updated);
    this.server.refresh();
    return { version, status: updated.status };
  }

  private cancelHandoff(params: {
    handoff_id: string;
    expected_version?: number;
  }): { version: number; status: HandoffStatus } | { error: string; currentVersion: number } {
    const handoff = this.loadHandoff(params.handoff_id);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${params.handoff_id}`);
    }
    const current = this.handoffVersions.get(params.handoff_id) ?? 0;
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
    const version = this.bumpVersion(this.handoffVersions, params.handoff_id);
    const updated: Handoff = {
      ...handoff,
      status: "cancelled",
      responded_at: new Date().toISOString(),
      version,
    };
    writeJson(this.handoffPath(params.handoff_id), updated);
    this.server.refresh();
    return { version, status: updated.status };
  }

  private buildRootDescriptor() {
    const plan = this.loadPlan();
    const taskIds = this.listTaskIdsForPlan(plan);
    const states = taskIds
      .map((id) => this.loadTaskState(id))
      .filter((state): state is TaskState => state !== null);
    const handoffs = this.listHandoffsForPlan(plan);
    const findings = this.listFindingsForPlan(plan);
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
        session_id: this.sessionId,
        plan_id: plan?.id,
        plan_status: plan?.status ?? "none",
        plan_query: plan?.query,
        plan_strategy: plan?.strategy,
        plan_max_agents: plan?.max_agents,
        plan_created_at: plan?.created_at,
        plan_version: plan ? this.planVersion() : undefined,
        task_counts: counts,
        handoff_counts: {
          total: handoffs.length,
          pending: handoffs.filter((h) => h.status === "pending").length,
        },
        finding_counts: {
          total: findings.length,
          open: findings.filter((finding) => finding.status === "open").length,
          blocking_open: findings.filter(
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
            this.createPlan({
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
            this.completePlan({
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
            },
            client_ref: {
              type: "string",
              description:
                "Optional local reference for this task, e.g. 'scaffold' or 'task-1'. Later dependencies may use this value.",
            },
            spec_refs: {
              type: "array",
              description:
                "Optional spec requirement or decision refs this task is responsible for satisfying.",
              items: { type: "string" },
            },
            audit_of: {
              type: "string",
              description: "Optional task id this audit task evaluates.",
            },
            finding_refs: {
              type: "array",
              description: "Optional audit finding ids this repair task addresses.",
              items: { type: "string" },
            },
            depends_on: {
              type: "array",
              description:
                "Optional list of dependency references. Prefer real task ids; existing task names, client_ref values, and aliases like task-1 are also accepted and normalized to ids.",
              items: { type: "string" },
            },
            acceptance_criteria: {
              type: "array",
              description:
                "Optional concrete criteria that verification must cover before completion. Use short, checkable statements tied to this task's goal.",
              items: { type: "string" },
            },
            retry_of: {
              type: "string",
              description:
                "Optional failed/cancelled/superseded task id this task replaces. When set, the old task is marked superseded_by the new one.",
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
            this.createTask({
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
                  },
                  client_ref: {
                    type: "string",
                    description:
                      "Optional local reference, e.g. 'scaffold' or 'ui'. Dependencies in this batch may refer to it.",
                  },
                  spec_refs: {
                    type: "array",
                    description:
                      "Optional spec requirement or decision refs this task is responsible for satisfying.",
                    items: { type: "string" },
                  },
                  audit_of: {
                    type: "string",
                    description: "Optional task id this audit task evaluates.",
                  },
                  finding_refs: {
                    type: "array",
                    description: "Optional audit finding ids this repair task addresses.",
                    items: { type: "string" },
                  },
                  depends_on: {
                    type: "array",
                    description:
                      "Optional dependency refs: ids, names, client_ref values, or aliases in this batch. Include only real blockers; implementation siblings that can agree on a stated interface should usually be parallel.",
                    items: { type: "string" },
                  },
                  acceptance_criteria: {
                    type: "array",
                    description:
                      "Optional concrete criteria that must be verified before this task can complete.",
                    items: { type: "string" },
                  },
                },
                required: ["name", "goal"],
                additionalProperties: false,
              },
            },
          },
          async ({ tasks }) => this.createTasks({ tasks: normalizeTaskList(tasks) }),
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
            },
            priority: {
              type: "string",
              description: "Optional handoff priority: low, normal, or high.",
              enum: ["low", "normal", "high"],
            },
            request: "string",
            spec_refs: {
              type: "array",
              description: "Optional spec refs this handoff is about.",
              items: { type: "string" },
            },
            evidence_refs: {
              type: "array",
              description:
                "Optional files, commands, URLs, screenshots, or state paths that explain the request.",
              items: { type: "string" },
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
            this.createHandoff({
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

  private buildHandoffsDescriptor() {
    const handoffs = this.listHandoffsForPlan();
    const items: ItemDescriptor[] = handoffs.map((handoff) => {
      const version = this.handoffVersions.get(handoff.id) ?? 0;
      return {
        id: handoff.id,
        props: {
          id: handoff.id,
          plan_id: handoff.plan_id,
          from_task: handoff.from_task,
          to_task: handoff.to_task,
          kind: handoff.kind,
          priority: handoff.priority,
          request: handoff.request,
          spec_refs: handoff.spec_refs,
          evidence_refs: handoff.evidence_refs,
          blocks_task: handoff.blocks_task,
          status: handoff.status,
          created_at: handoff.created_at,
          responded_at: handoff.responded_at,
          response_preview: handoff.response ? truncateText(handoff.response, 400) : undefined,
          decision_refs: handoff.decision_refs,
          response_evidence_refs: handoff.response_evidence_refs,
          unblock: handoff.unblock,
          version,
        },
        summary: `${handoff.from_task} → ${handoff.to_task}: ${handoff.request.slice(0, 80)}`,
        actions: {
          ...(handoff.status === "pending"
            ? {
                respond: action(
                  {
                    response: "string",
                    decision_refs: {
                      type: "array",
                      description:
                        "Optional spec decision refs this response establishes or cites.",
                      items: { type: "string" },
                    },
                    evidence_refs: {
                      type: "array",
                      description:
                        "Optional files, commands, URLs, screenshots, or state paths that support the response.",
                      items: { type: "string" },
                    },
                    unblock: {
                      type: "boolean",
                      description:
                        "True when this response is intended to unblock the receiving task.",
                    },
                    expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
                  },
                  async ({ response, decision_refs, evidence_refs, unblock, expected_version }) =>
                    this.respondHandoff({
                      handoff_id: handoff.id,
                      response: response as string,
                      decision_refs: normalizeStringList(decision_refs),
                      evidence_refs: normalizeStringList(evidence_refs),
                      unblock: typeof unblock === "boolean" ? unblock : undefined,
                      expected_version:
                        typeof expected_version === "number" ? expected_version : undefined,
                    }),
                  {
                    label: "Respond",
                    description: "Fulfil the handoff request with a response.",
                    estimate: "instant",
                  },
                ),
                cancel: action(
                  { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
                  async ({ expected_version }) =>
                    this.cancelHandoff({
                      handoff_id: handoff.id,
                      expected_version:
                        typeof expected_version === "number" ? expected_version : undefined,
                    }),
                  {
                    label: "Cancel Handoff",
                    description: "Cancel this pending handoff request.",
                    dangerous: true,
                    estimate: "instant",
                  },
                ),
              }
            : {}),
        },
        meta: {
          salience: handoff.status === "pending" ? 0.9 : 0.5,
          urgency: handoff.status === "pending" ? "high" : "low",
        },
      };
    });

    const pending = handoffs.filter((h) => h.status === "pending").length;
    return {
      type: "collection",
      props: {
        count: items.length,
        pending,
      },
      summary: `Handoffs between tasks (${pending} pending).`,
      items,
    };
  }

  private buildFindingsDescriptor() {
    const findings = this.listFindingsForPlan();
    const items: ItemDescriptor[] = findings.map((finding) => ({
      id: finding.id,
      props: {
        ...finding,
        version: this.findingVersion(finding.id),
      },
      summary: `${finding.severity}/${finding.status}: ${finding.summary}`,
      actions: {
        ...(finding.status === "open"
          ? {
              accept_finding: action(
                {
                  reason: {
                    type: "string",
                    description: "Optional explanation for accepting this deviation from the spec.",
                  },
                },
                async ({ reason }) =>
                  this.resolveFinding({
                    finding_id: finding.id,
                    status: "accepted",
                    reason: typeof reason === "string" ? reason : undefined,
                  }),
                {
                  label: "Accept Finding",
                  description:
                    "Accept this finding as an intentional deviation or follow-up decision.",
                  estimate: "instant",
                },
              ),
              dismiss_finding: action(
                {
                  reason: {
                    type: "string",
                    description: "Optional explanation for dismissing this finding.",
                  },
                },
                async ({ reason }) =>
                  this.resolveFinding({
                    finding_id: finding.id,
                    status: "dismissed",
                    reason: typeof reason === "string" ? reason : undefined,
                  }),
                {
                  label: "Dismiss Finding",
                  description: "Dismiss this finding as not actionable.",
                  estimate: "instant",
                },
              ),
              mark_fixed: action(
                {
                  reason: {
                    type: "string",
                    description: "Optional evidence summary for the fix.",
                  },
                },
                async ({ reason }) =>
                  this.resolveFinding({
                    finding_id: finding.id,
                    status: "fixed",
                    reason: typeof reason === "string" ? reason : undefined,
                  }),
                {
                  label: "Mark Fixed",
                  description: "Mark this finding fixed after repair and re-audit.",
                  estimate: "instant",
                },
              ),
              create_repair_task: action(
                {
                  name: {
                    type: "string",
                    description: "Optional repair task name.",
                  },
                  goal: {
                    type: "string",
                    description: "Optional repair task goal.",
                  },
                  acceptance_criteria: {
                    type: "array",
                    description: "Optional acceptance criteria for the repair task.",
                    items: { type: "string" },
                  },
                },
                async ({ name, goal, acceptance_criteria }) =>
                  this.createRepairTask({
                    finding_id: finding.id,
                    name: typeof name === "string" ? name : undefined,
                    goal: typeof goal === "string" ? goal : undefined,
                    acceptance_criteria: normalizeStringList(acceptance_criteria),
                  }),
                {
                  label: "Create Repair Task",
                  description:
                    "Create a repair task linked to this finding. The finding remains open until fixed or accepted.",
                  estimate: "instant",
                },
              ),
            }
          : {}),
      },
      meta: {
        salience:
          finding.status === "open" && finding.severity === "blocking"
            ? 1
            : finding.status === "open"
              ? 0.85
              : 0.45,
        urgency:
          finding.status === "open" && finding.severity === "blocking"
            ? "high"
            : finding.status === "open"
              ? "medium"
              : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
        open: findings.filter((finding) => finding.status === "open").length,
        blocking_open: findings.filter(
          (finding) => finding.status === "open" && finding.severity === "blocking",
        ).length,
      },
      summary: "Audit findings recorded against orchestration tasks and spec refs.",
      actions: {
        record_finding: action(
          {
            audit_task_id: "string",
            target_task_id: "string",
            severity: {
              type: "string",
              description: "Finding severity: blocking, warning, or note.",
              enum: ["blocking", "warning", "note"],
            },
            spec_refs: {
              type: "array",
              description: "Optional spec refs this finding relates to.",
              items: { type: "string" },
            },
            summary: "string",
            evidence_refs: {
              type: "array",
              description:
                "Files, commands, URLs, screenshots, or state paths supporting this finding.",
              items: { type: "string" },
            },
            recommendation: {
              type: "string",
              description: "Recommended resolution: repair, spec_change, or accept_deviation.",
              enum: ["repair", "spec_change", "accept_deviation"],
            },
          },
          async ({
            audit_task_id,
            target_task_id,
            severity,
            spec_refs,
            summary,
            evidence_refs,
            recommendation,
          }) =>
            this.recordFinding({
              audit_task_id: audit_task_id as string,
              target_task_id: target_task_id as string,
              severity: normalizeFindingSeverity(severity),
              spec_refs: normalizeStringList(spec_refs),
              summary: summary as string,
              evidence_refs: normalizeStringList(evidence_refs),
              recommendation: normalizeFindingRecommendation(recommendation),
            }),
          {
            label: "Record Finding",
            description:
              "Record a structured audit finding against an implementation task and optional spec refs.",
            estimate: "instant",
          },
        ),
      },
      items,
    };
  }

  private buildTaskActions(
    id: string,
    status: TaskStatus | "unknown" | undefined,
  ): ItemDescriptor["actions"] {
    const hasResult = existsSync(this.resultPath(id));
    const canReadResult =
      hasResult &&
      (status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "superseded");
    const actions: ItemDescriptor["actions"] = {
      ...(canReadResult
        ? {
            get_result: action(async () => this.getResult(id), {
              label: "Get Result",
              description:
                "Read the full result.md for this terminal task. During running/verifying, use result_preview from task state instead of polling.",
              idempotent: true,
              estimate: "fast",
            }),
          }
        : {}),
      get_verifications: action(async () => this.getVerifications(id), {
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

    const depsMet = this.unmetDependencies(id).length === 0;

    if (canRecordVerification) {
      actions.record_verification = action(
        {
          kind: {
            type: "string",
            description:
              "Optional verification kind, e.g. build, test, lint, format, compile, smoke, review, benchmark, or check.",
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
          },
          command: {
            type: "string",
            description:
              "Optional command or procedure used, e.g. 'npm run build' or 'manual browser smoke test'.",
          },
          evidence: {
            type: "string",
            description:
              "Optional concise evidence: important output lines, observed result, or link/path to the artifact.",
          },
          evidence_refs: {
            type: "array",
            description:
              "Optional artifact references that support the verification, e.g. file paths, command names, URLs, screenshot ids, or state paths.",
            items: { type: "string" },
          },
        },
        async ({ kind, status, summary, criteria, command, evidence, evidence_refs }) =>
          this.recordVerification({
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
          this.scheduleTask({
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
          this.startTask({
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
          this.startTask({
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
        async ({ message }) => this.appendProgress({ task_id: id, message: message as string }),
        {
          label: "Append Progress",
          description: "Append a timestamped line to the task progress log.",
          estimate: "instant",
        },
      );
      actions.cancel = action(
        { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
        async ({ expected_version }) =>
          this.cancelTask({
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
          this.attachResult({
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
          this.startVerification({
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
          this.completeTask({
            task_id: id,
            result: result as string,
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
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
          this.failTask({
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

  private buildTasksDescriptor() {
    const ids = this.listTaskIdsForPlan();
    const items: ItemDescriptor[] = ids.map((id) => {
      const def = this.loadTaskDefinition(id);
      const state = this.loadTaskState(id);
      const version = this.taskVersion(id);
      const progress = this.loadProgressTail(id);
      const verifications = this.loadVerifications(id);
      const latestVerification = verifications.at(-1);
      const acceptanceCriteria = def?.acceptance_criteria ?? [];
      const coveredCriteria = this.coveredAcceptanceCriteria(id, verifications);
      const missingCriteria = this.missingAcceptanceCriteria(id, verifications);

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
          result_preview: this.loadResultPreview(id),
          unmet_dependencies: this.unmetDependencies(id),
          verified:
            acceptanceCriteria.length > 0
              ? missingCriteria.length === 0
              : verifications.some(
                  (verification) =>
                    verification.status === "passed" || verification.status === "not_required",
                ),
          verification_coverage: {
            total: acceptanceCriteria.length,
            covered: coveredCriteria,
            missing: missingCriteria,
            complete: missingCriteria.length === 0,
          },
          verification_counts: {
            total: verifications.length,
            passed: verifications.filter((verification) => verification.status === "passed").length,
            failed: verifications.filter((verification) => verification.status === "failed").length,
            skipped: verifications.filter((verification) => verification.status === "skipped")
              .length,
            not_required: verifications.filter(
              (verification) => verification.status === "not_required",
            ).length,
            unknown: verifications.filter((verification) => verification.status === "unknown")
              .length,
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
        actions: this.buildTaskActions(id, state?.status),
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
}

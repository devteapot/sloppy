import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { globSegmentToRegExp, looksLikeFileEvidenceRef, uniqueStrings } from "./classifiers";
import { dependencyCycle } from "./dag";
import { normalizeReference } from "./normalization";
import { codedError, readJson, truncateText, writeJson } from "./storage";
import {
  type AuditFinding,
  type Handoff,
  ORCHESTRATION_DIR,
  type Plan,
  type TaskDefinition,
  type TaskState,
  type VerificationRecord,
} from "./types";

export interface OrchestrationRepositoryOptions {
  workspaceRoot: string;
  progressTailMaxChars?: number;
}

export class OrchestrationRepository {
  readonly workspaceRoot: string;
  readonly root: string;
  readonly progressTailMaxChars: number;
  private planVersions = new Map<string, number>();
  private taskVersions = new Map<string, number>();
  private handoffVersions = new Map<string, number>();
  private findingVersions = new Map<string, number>();

  constructor(options: OrchestrationRepositoryOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.root = resolve(this.workspaceRoot, ORCHESTRATION_DIR);
    this.progressTailMaxChars = options.progressTailMaxChars ?? 2048;

    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "tasks"), { recursive: true });
    mkdirSync(join(this.root, "handoffs"), { recursive: true });
    mkdirSync(join(this.root, "findings"), { recursive: true });

    this.hydrateVersionsFromDisk();
  }

  // --- path resolution ---------------------------------------------------

  planPath(): string {
    return join(this.root, "plan.json");
  }

  taskDir(taskId: string): string {
    return join(this.root, "tasks", taskId);
  }

  resultPath(taskId: string): string {
    return join(this.taskDir(taskId), "result.md");
  }

  verificationsPath(taskId: string): string {
    return join(this.taskDir(taskId), "verifications.json");
  }

  handoffPath(handoffId: string): string {
    return join(this.root, "handoffs", `${handoffId}.json`);
  }

  findingsDir(): string {
    return join(this.root, "findings");
  }

  findingPath(findingId: string): string {
    return join(this.findingsDir(), `${findingId}.json`);
  }

  // --- version map hydration / accessors --------------------------------

  versionStats(): { plans: number; tasks: number; handoffs: number; findings: number } {
    return {
      plans: this.planVersions.size,
      tasks: this.taskVersions.size,
      handoffs: this.handoffVersions.size,
      findings: this.findingVersions.size,
    };
  }

  bumpPlanVersion(): number {
    return this.bumpVersion(this.planVersions, "plan");
  }

  bumpTaskVersion(taskId: string): number {
    return this.bumpVersion(this.taskVersions, taskId);
  }

  bumpHandoffVersion(handoffId: string): number {
    return this.bumpVersion(this.handoffVersions, handoffId);
  }

  bumpFindingVersion(findingId: string): number {
    return this.bumpVersion(this.findingVersions, findingId);
  }

  planVersion(): number {
    return this.planVersions.get("plan") ?? 0;
  }

  taskVersion(taskId: string): number {
    return this.taskVersions.get(taskId) ?? 0;
  }

  handoffVersion(handoffId: string): number {
    return this.handoffVersions.get(handoffId) ?? 0;
  }

  findingVersion(findingId: string): number {
    return this.findingVersions.get(findingId) ?? 0;
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

  // --- loaders / writers -------------------------------------------------

  loadPlan(): Plan | null {
    return readJson<Plan>(this.planPath());
  }

  writePlan(plan: Plan & { version: number }): void {
    writeJson(this.planPath(), plan);
  }

  loadTaskDefinition(taskId: string): TaskDefinition | null {
    return readJson<TaskDefinition>(join(this.taskDir(taskId), "definition.json"));
  }

  writeTaskDefinition(taskId: string, definition: TaskDefinition): void {
    writeJson(join(this.taskDir(taskId), "definition.json"), definition);
  }

  loadTaskState(taskId: string): TaskState | null {
    return readJson<TaskState>(join(this.taskDir(taskId), "state.json"));
  }

  writeTaskState(taskId: string, state: TaskState & { version: number }): void {
    writeJson(join(this.taskDir(taskId), "state.json"), state);
  }

  loadVerifications(taskId: string): VerificationRecord[] {
    return readJson<VerificationRecord[]>(this.verificationsPath(taskId)) ?? [];
  }

  writeVerifications(taskId: string, records: VerificationRecord[]): void {
    writeJson(this.verificationsPath(taskId), records);
  }

  loadHandoff(handoffId: string): Handoff | null {
    return readJson<Handoff>(this.handoffPath(handoffId));
  }

  writeHandoff(handoff: Handoff & { version: number }): void {
    writeJson(this.handoffPath(handoff.id), handoff);
  }

  loadFinding(findingId: string): AuditFinding | null {
    return readJson<AuditFinding>(this.findingPath(findingId));
  }

  writeFinding(finding: AuditFinding): void {
    writeJson(this.findingPath(finding.id), finding);
  }

  loadProgressTail(taskId: string): string {
    const path = join(this.taskDir(taskId), "progress.md");
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf8");
    if (content.length <= this.progressTailMaxChars) return content;
    return `...[truncated head]\n${content.slice(-this.progressTailMaxChars)}`;
  }

  loadResultPreview(taskId: string): string | undefined {
    const path = this.resultPath(taskId);
    if (!existsSync(path)) return undefined;
    return truncateText(readFileSync(path, "utf8"), 400);
  }

  loadAcceptanceCriteria(taskId: string) {
    return this.loadTaskDefinition(taskId)?.acceptance_criteria ?? [];
  }

  // --- listing -----------------------------------------------------------

  listTaskIds(): string[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  taskBelongsToPlan(definition: TaskDefinition | null, plan: Plan | null): boolean {
    if (!definition || !plan) {
      return false;
    }
    if (!plan.id) {
      return true;
    }
    return definition.plan_id === plan.id;
  }

  listTaskIdsForPlan(plan: Plan | null = this.loadPlan()): string[] {
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

  listHandoffs(): Handoff[] {
    const dir = join(this.root, "handoffs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<Handoff>(join(dir, entry.name)))
      .filter((handoff): handoff is Handoff => handoff !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listFindings(): AuditFinding[] {
    const dir = this.findingsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<AuditFinding>(join(dir, entry.name)))
      .filter((finding): finding is AuditFinding => finding !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listHandoffsForPlan(plan: Plan | null = this.loadPlan()): Handoff[] {
    if (!plan) {
      return [];
    }
    const handoffs = this.listHandoffs();
    if (!plan.id) {
      return handoffs;
    }
    return handoffs.filter((handoff) => handoff.plan_id === plan.id);
  }

  listFindingsForPlan(plan: Plan | null = this.loadPlan()): AuditFinding[] {
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

  // --- requirements / queries -------------------------------------------

  requireActivePlan(): Plan {
    const plan = this.loadPlan();
    if (!plan || plan.status !== "active") {
      throw codedError("no_active_plan", "No active orchestration plan exists.");
    }
    return plan;
  }

  describeAvailableTasks(): string {
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

  taskReferenceMap(extraReferences?: Map<string, string>): Map<string, string> {
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

  dependencyLabelsForPlan(plan: Plan): Map<string, string> {
    const labels = new Map<string, string>();
    for (const id of this.listTaskIdsForPlan(plan)) {
      const definition = this.loadTaskDefinition(id);
      labels.set(id, definition?.name ?? id);
    }
    return labels;
  }

  dependencyGraphForPlan(plan: Plan, overrides?: Map<string, string[]>): Map<string, string[]> {
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

  assertAcyclicDependencies(graph: Map<string, string[]>, labels: Map<string, string>): void {
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

  resolveTaskDependencyReferences(
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

  resolveOptionalTaskReference(
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

  // --- evidence-ref validation ------------------------------------------

  invalidEvidenceRefs(refs: string[]): string[] {
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
}

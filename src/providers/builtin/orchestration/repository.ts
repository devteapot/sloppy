import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { globSegmentToRegExp, looksLikeFileEvidenceRef, uniqueStrings } from "./classifiers";
import { dependencyCycle } from "./dag";
import { normalizeReference } from "./normalization";
import { codedError, readJson, truncateText, writeJson } from "./storage";
import {
  type AuditFinding,
  type BudgetUsageRecord,
  type CaseRecord,
  type DigestDelivery,
  type DigestRecord,
  type DriftEvent,
  type EvidenceClaim,
  type FinalAuditRecord,
  type Gate,
  type Goal,
  type GoalRevision,
  type Handoff,
  ORCHESTRATION_DIR,
  type Plan,
  type PlanRevision,
  type Precedent,
  type ProtocolMessage,
  type TaskDefinition,
  type TaskState,
  type VerificationRecord,
} from "./types";

export interface OrchestrationRepositoryOptions {
  workspaceRoot: string;
  progressTailMaxChars?: number;
  finalAuditCommandTimeoutMs?: number;
}

export class OrchestrationRepository {
  readonly workspaceRoot: string;
  readonly root: string;
  readonly progressTailMaxChars: number;
  readonly finalAuditCommandTimeoutMs: number;
  private planVersions = new Map<string, number>();
  private taskVersions = new Map<string, number>();
  private handoffVersions = new Map<string, number>();
  private findingVersions = new Map<string, number>();
  private gateVersions = new Map<string, number>();
  private messageVersions = new Map<string, number>();
  private planRevisionVersions = new Map<string, number>();
  private precedentVersions = new Map<string, number>();
  private caseRecordVersions = new Map<string, number>();
  private digestDeliveryVersions = new Map<string, number>();
  private driftEventVersions = new Map<string, number>();

  constructor(options: OrchestrationRepositoryOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.root = resolve(this.workspaceRoot, ORCHESTRATION_DIR);
    this.progressTailMaxChars = options.progressTailMaxChars ?? 2048;
    this.finalAuditCommandTimeoutMs = options.finalAuditCommandTimeoutMs ?? 30000;

    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "tasks"), { recursive: true });
    mkdirSync(join(this.root, "handoffs"), { recursive: true });
    mkdirSync(join(this.root, "findings"), { recursive: true });
    mkdirSync(this.goalsDir(), { recursive: true });
    mkdirSync(this.gatesDir(), { recursive: true });
    mkdirSync(this.messagesDir(), { recursive: true });
    mkdirSync(this.planRevisionsDir(), { recursive: true });
    mkdirSync(this.auditDir(), { recursive: true });
    mkdirSync(this.blobsDir(), { recursive: true });
    mkdirSync(this.budgetUsageDir(), { recursive: true });
    mkdirSync(this.digestsDir(), { recursive: true });
    mkdirSync(this.digestDeliveriesDir(), { recursive: true });
    mkdirSync(this.driftEventsDir(), { recursive: true });
    mkdirSync(this.precedentsDir(), { recursive: true });
    mkdirSync(this.caseRecordsDir(), { recursive: true });

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

  goalsDir(): string {
    return join(this.root, "goals");
  }

  goalDir(goalId: string): string {
    return join(this.goalsDir(), goalId);
  }

  goalPath(goalId: string): string {
    return join(this.goalDir(goalId), "goal.json");
  }

  goalRevisionPath(goalId: string, version: number): string {
    return join(this.goalDir(goalId), "revisions", `${version}.json`);
  }

  gatesDir(): string {
    return join(this.root, "gates");
  }

  gatePath(gateId: string): string {
    return join(this.gatesDir(), `${gateId}.json`);
  }

  messagesDir(): string {
    return join(this.root, "messages");
  }

  messagePath(messageId: string): string {
    return join(this.messagesDir(), `${messageId}.json`);
  }

  planRevisionsDir(): string {
    return join(this.root, "plan-revisions");
  }

  planRevisionPath(revisionId: string): string {
    return join(this.planRevisionsDir(), `${revisionId}.json`);
  }

  evidenceClaimsDir(taskId: string): string {
    return join(this.taskDir(taskId), "evidence-claims");
  }

  evidenceClaimPath(taskId: string, claimId: string): string {
    return join(this.evidenceClaimsDir(taskId), `${claimId}.json`);
  }

  blobsDir(): string {
    return join(this.root, "blobs");
  }

  blobPath(blobId: string): string {
    return join(this.blobsDir(), `${blobId}.txt`);
  }

  budgetUsageDir(): string {
    return join(this.root, "budget-usage");
  }

  budgetUsagePath(usageId: string): string {
    return join(this.budgetUsageDir(), `${usageId}.json`);
  }

  auditDir(): string {
    return join(this.root, "audit");
  }

  auditPath(auditId: string): string {
    return join(this.auditDir(), `${auditId}.json`);
  }

  digestsDir(): string {
    return join(this.root, "digests");
  }

  digestPath(digestId: string): string {
    return join(this.digestsDir(), `${digestId}.json`);
  }

  digestDeliveriesDir(): string {
    return join(this.root, "digest-deliveries");
  }

  digestDeliveryPath(deliveryId: string): string {
    return join(this.digestDeliveriesDir(), `${deliveryId}.json`);
  }

  driftEventsDir(): string {
    return join(this.root, "drift");
  }

  driftEventPath(eventId: string): string {
    return join(this.driftEventsDir(), `${eventId}.json`);
  }

  precedentsDir(): string {
    return resolve(this.workspaceRoot, ".sloppy", "precedents");
  }

  precedentPath(precedentId: string): string {
    return join(this.precedentsDir(), `${precedentId}.json`);
  }

  caseRecordsDir(): string {
    return join(this.precedentsDir(), "cases");
  }

  caseRecordPath(caseRecordId: string): string {
    return join(this.caseRecordsDir(), `${caseRecordId}.json`);
  }

  // --- version map hydration / accessors --------------------------------

  versionStats(): {
    plans: number;
    tasks: number;
    handoffs: number;
    findings: number;
    gates: number;
    messages: number;
    planRevisions: number;
    precedents: number;
    caseRecords: number;
    digestDeliveries: number;
    driftEvents: number;
  } {
    return {
      plans: this.planVersions.size,
      tasks: this.taskVersions.size,
      handoffs: this.handoffVersions.size,
      findings: this.findingVersions.size,
      gates: this.gateVersions.size,
      messages: this.messageVersions.size,
      planRevisions: this.planRevisionVersions.size,
      precedents: this.precedentVersions.size,
      caseRecords: this.caseRecordVersions.size,
      digestDeliveries: this.digestDeliveryVersions.size,
      driftEvents: this.driftEventVersions.size,
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

  bumpGateVersion(gateId: string): number {
    return this.bumpVersion(this.gateVersions, gateId);
  }

  bumpMessageVersion(messageId: string): number {
    return this.bumpVersion(this.messageVersions, messageId);
  }

  bumpPlanRevisionVersion(revisionId: string): number {
    return this.bumpVersion(this.planRevisionVersions, revisionId);
  }

  bumpPrecedentVersion(precedentId: string): number {
    return this.bumpVersion(this.precedentVersions, precedentId);
  }

  bumpCaseRecordVersion(caseRecordId: string): number {
    return this.bumpVersion(this.caseRecordVersions, caseRecordId);
  }

  bumpDigestDeliveryVersion(deliveryId: string): number {
    return this.bumpVersion(this.digestDeliveryVersions, deliveryId);
  }

  bumpDriftEventVersion(eventId: string): number {
    return this.bumpVersion(this.driftEventVersions, eventId);
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

  gateVersion(gateId: string): number {
    return this.gateVersions.get(gateId) ?? 0;
  }

  messageVersion(messageId: string): number {
    return this.messageVersions.get(messageId) ?? 0;
  }

  planRevisionVersion(revisionId: string): number {
    return this.planRevisionVersions.get(revisionId) ?? 0;
  }

  precedentVersion(precedentId: string): number {
    return this.precedentVersions.get(precedentId) ?? 0;
  }

  caseRecordVersion(caseRecordId: string): number {
    return this.caseRecordVersions.get(caseRecordId) ?? 0;
  }

  digestDeliveryVersion(deliveryId: string): number {
    return this.digestDeliveryVersions.get(deliveryId) ?? 0;
  }

  driftEventVersion(eventId: string): number {
    return this.driftEventVersions.get(eventId) ?? 0;
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
    for (const gate of this.listGates()) {
      if (gate.version !== undefined) {
        this.gateVersions.set(gate.id, gate.version);
      }
    }
    for (const message of this.listMessages()) {
      this.messageVersions.set(message.id, message.version);
    }
    for (const revision of this.listPlanRevisions()) {
      if (revision.version !== undefined) {
        this.planRevisionVersions.set(revision.id, revision.version);
      }
    }
    for (const precedent of this.listPrecedents()) {
      if (precedent.version !== undefined) {
        this.precedentVersions.set(precedent.id, precedent.version);
      }
    }
    for (const record of this.listCaseRecords()) {
      if (record.version !== undefined) {
        this.caseRecordVersions.set(record.id, record.version);
      }
    }
    for (const delivery of this.listDigestDeliveries()) {
      if (delivery.version !== undefined) {
        this.digestDeliveryVersions.set(delivery.id, delivery.version);
      }
    }
    for (const event of this.listDriftEvents()) {
      if (event.version !== undefined) {
        this.driftEventVersions.set(event.id, event.version);
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

  loadGoal(goalId: string): Goal | null {
    return readJson<Goal>(this.goalPath(goalId));
  }

  writeGoal(goal: Goal): void {
    writeJson(this.goalPath(goal.id), goal);
  }

  writeGoalRevision(revision: GoalRevision): void {
    writeJson(this.goalRevisionPath(revision.goal_id, revision.version), revision);
  }

  loadGoalRevisions(goalId: string): GoalRevision[] {
    const dir = join(this.goalDir(goalId), "revisions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<GoalRevision>(join(dir, entry.name)))
      .filter((revision): revision is GoalRevision => revision !== null)
      .sort((a, b) => a.version - b.version);
  }

  loadGate(gateId: string): Gate | null {
    return readJson<Gate>(this.gatePath(gateId));
  }

  writeGate(gate: Gate & { version: number }): void {
    writeJson(this.gatePath(gate.id), gate);
  }

  loadMessage(messageId: string): ProtocolMessage | null {
    return readJson<ProtocolMessage>(this.messagePath(messageId));
  }

  writeMessage(message: ProtocolMessage): void {
    writeJson(this.messagePath(message.id), message);
  }

  loadPlanRevision(revisionId: string): PlanRevision | null {
    return readJson<PlanRevision>(this.planRevisionPath(revisionId));
  }

  writePlanRevision(revision: PlanRevision & { version: number }): void {
    writeJson(this.planRevisionPath(revision.id), revision);
  }

  loadEvidenceClaim(taskId: string, claimId: string): EvidenceClaim | null {
    return readJson<EvidenceClaim>(this.evidenceClaimPath(taskId, claimId));
  }

  writeEvidenceClaim(claim: EvidenceClaim): void {
    writeJson(this.evidenceClaimPath(claim.slice_id, claim.id), claim);
  }

  writeBlob(blobId: string, content: string): string {
    const path = this.blobPath(blobId);
    mkdirSync(this.blobsDir(), { recursive: true });
    writeFileSync(path, content, "utf8");
    return `blob:${blobId}`;
  }

  writeBudgetUsage(record: BudgetUsageRecord): void {
    writeJson(this.budgetUsagePath(record.id), record);
  }

  loadAudit(auditId: string): FinalAuditRecord | null {
    return readJson<FinalAuditRecord>(this.auditPath(auditId));
  }

  writeAudit(audit: FinalAuditRecord): void {
    writeJson(this.auditPath(audit.id), audit);
  }

  loadDigest(digestId: string): DigestRecord | null {
    return readJson<DigestRecord>(this.digestPath(digestId));
  }

  writeDigest(digest: DigestRecord): void {
    writeJson(this.digestPath(digest.id), digest);
  }

  loadDigestDelivery(deliveryId: string): DigestDelivery | null {
    return readJson<DigestDelivery>(this.digestDeliveryPath(deliveryId));
  }

  writeDigestDelivery(delivery: DigestDelivery & { version: number }): void {
    writeJson(this.digestDeliveryPath(delivery.id), delivery);
  }

  loadDriftEvent(eventId: string): DriftEvent | null {
    return readJson<DriftEvent>(this.driftEventPath(eventId));
  }

  writeDriftEvent(event: DriftEvent & { version: number }): void {
    writeJson(this.driftEventPath(event.id), event);
  }

  loadPrecedent(precedentId: string): Precedent | null {
    return readJson<Precedent>(this.precedentPath(precedentId));
  }

  writePrecedent(precedent: Precedent & { version: number }): void {
    writeJson(this.precedentPath(precedent.id), precedent);
  }

  loadCaseRecord(caseRecordId: string): CaseRecord | null {
    return readJson<CaseRecord>(this.caseRecordPath(caseRecordId));
  }

  writeCaseRecord(caseRecord: CaseRecord & { version: number }): void {
    writeJson(this.caseRecordPath(caseRecord.id), caseRecord);
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

  listGoals(): Goal[] {
    if (!existsSync(this.goalsDir())) return [];
    return readdirSync(this.goalsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson<Goal>(this.goalPath(entry.name)))
      .filter((goal): goal is Goal => goal !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listGates(): Gate[] {
    const dir = this.gatesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<Gate>(join(dir, entry.name)))
      .filter((gate): gate is Gate => gate !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listMessages(): ProtocolMessage[] {
    const dir = this.messagesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<ProtocolMessage>(join(dir, entry.name)))
      .filter((message): message is ProtocolMessage => message !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listPlanRevisions(): PlanRevision[] {
    const dir = this.planRevisionsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<PlanRevision>(join(dir, entry.name)))
      .filter((revision): revision is PlanRevision => revision !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listEvidenceClaims(taskId: string): EvidenceClaim[] {
    const dir = this.evidenceClaimsDir(taskId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<EvidenceClaim>(join(dir, entry.name)))
      .filter((claim): claim is EvidenceClaim => claim !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  listEvidenceClaimsForPlan(plan: Plan | null = this.loadPlan()): EvidenceClaim[] {
    if (!plan) return [];
    return this.repoTaskIdsForEvidence(plan).flatMap((taskId) => this.listEvidenceClaims(taskId));
  }

  listActiveRevisionTaskIds(plan: Plan | null = this.loadPlan()): string[] {
    if (!plan) return [];
    const baseIds = plan.active_revision_id
      ? this.listTaskIdsForPlan(plan).filter(
          (id) => this.loadTaskDefinition(id)?.plan_revision_id === plan.active_revision_id,
        )
      : this.listTaskIdsForPlan(plan);
    return baseIds.filter((id) => this.loadTaskState(id)?.status !== "superseded");
  }

  private repoTaskIdsForEvidence(plan: Plan): string[] {
    return this.listActiveRevisionTaskIds(plan);
  }

  listBudgetUsage(): BudgetUsageRecord[] {
    const dir = this.budgetUsageDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<BudgetUsageRecord>(join(dir, entry.name)))
      .filter((record): record is BudgetUsageRecord => record !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listBudgetUsageForPlan(plan: Plan | null = this.loadPlan()): BudgetUsageRecord[] {
    if (!plan?.id) return [];
    return this.listBudgetUsage().filter((record) => record.plan_id === plan.id);
  }

  listAudits(): FinalAuditRecord[] {
    const dir = this.auditDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<FinalAuditRecord>(join(dir, entry.name)))
      .filter((audit): audit is FinalAuditRecord => audit !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listDigests(): DigestRecord[] {
    const dir = this.digestsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<DigestRecord>(join(dir, entry.name)))
      .filter((digest): digest is DigestRecord => digest !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listDigestDeliveries(): DigestDelivery[] {
    const dir = this.digestDeliveriesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<DigestDelivery>(join(dir, entry.name)))
      .filter((delivery): delivery is DigestDelivery => delivery !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listDriftEvents(): DriftEvent[] {
    const dir = this.driftEventsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<DriftEvent>(join(dir, entry.name)))
      .filter((event): event is DriftEvent => event !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listDriftEventsForPlan(plan: Plan | null = this.loadPlan()): DriftEvent[] {
    if (!plan?.id) return [];
    return this.listDriftEvents().filter((event) => event.plan_id === plan.id);
  }

  findOpenDriftEvent(kind: DriftEvent["kind"], subjectRef: string): DriftEvent | null {
    return (
      this.listDriftEvents().find(
        (event) =>
          event.kind === kind && event.subject_ref === subjectRef && event.status === "open",
      ) ?? null
    );
  }

  listPrecedents(): Precedent[] {
    const dir = this.precedentsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<Precedent>(join(dir, entry.name)))
      .filter((precedent): precedent is Precedent => precedent !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listCaseRecords(): CaseRecord[] {
    const dir = this.caseRecordsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<CaseRecord>(join(dir, entry.name)))
      .filter((record): record is CaseRecord => record !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  latestDigestForPlan(plan: Plan): DigestRecord | null {
    return (
      this.listDigests()
        .filter((digest) => digest.plan_id === plan.id)
        .at(-1) ?? null
    );
  }

  retryAttemptCount(taskId: string): number {
    const stored = this.loadTaskDefinition(taskId)?.attempt_count;
    const chainCount = this.retryChainLength(taskId);
    return Math.max(typeof stored === "number" && Number.isFinite(stored) ? stored : 0, chainCount);
  }

  retryRootTaskId(taskId: string): string {
    let currentId = taskId;
    const seen = new Set<string>();
    while (!seen.has(currentId)) {
      seen.add(currentId);
      const definition = this.loadTaskDefinition(currentId);
      if (!definition?.retry_of) {
        return currentId;
      }
      currentId = definition.retry_of;
    }
    return taskId;
  }

  retryBudgetUsageForPlan(plan: Plan | null = this.loadPlan()): {
    retryAttemptsUsed?: number;
    retryOverBudgetSliceCount?: number;
    retryGateId?: string;
  } {
    if (!plan?.budget || plan.budget.retries_per_slice === undefined) {
      return {};
    }

    const taskIds = this.listActiveRevisionTaskIds(plan);
    const attempts = taskIds.map((taskId) => this.retryAttemptCount(taskId));
    const overBudgetTaskCount = attempts.filter(
      (attemptCount) => attemptCount > (plan.budget?.retries_per_slice ?? Number.POSITIVE_INFINITY),
    ).length;
    const retryGate =
      this.listGates()
        .filter(
          (gate) =>
            gate.gate_type === "budget_exceeded" &&
            gate.status === "open" &&
            gate.subject_ref.startsWith(`plan:${plan.id}:`) &&
            gate.subject_ref.endsWith(":budget:retries_per_slice"),
        )
        .at(-1) ?? null;

    return {
      retryAttemptsUsed: attempts.length > 0 ? Math.max(...attempts) : 0,
      retryOverBudgetSliceCount: Math.max(overBudgetTaskCount, retryGate ? 1 : 0),
      retryGateId: retryGate?.id,
    };
  }

  tokenCostBudgetUsageForPlan(plan: Plan | null = this.loadPlan()): {
    inputTokensUsed?: number;
    outputTokensUsed?: number;
    tokensUsed?: number;
    costUsdUsed?: number;
    tokenGateId?: string;
    costGateId?: string;
  } {
    if (!plan?.id) {
      return {};
    }

    const records = this.listBudgetUsageForPlan(plan);
    const inputTokensUsed = records.reduce((sum, record) => sum + record.input_tokens, 0);
    const outputTokensUsed = records.reduce((sum, record) => sum + record.output_tokens, 0);
    const tokensUsed = records.reduce((sum, record) => sum + record.total_tokens, 0);
    const costUsdUsed = records.reduce((sum, record) => sum + (record.cost_usd ?? 0), 0);
    const tokenGate =
      this.listGates()
        .filter(
          (gate) =>
            gate.gate_type === "budget_exceeded" &&
            gate.status === "open" &&
            gate.subject_ref === `plan:${plan.id}:budget:token_limit`,
        )
        .at(-1) ?? null;
    const costGate =
      this.listGates()
        .filter(
          (gate) =>
            gate.gate_type === "budget_exceeded" &&
            gate.status === "open" &&
            gate.subject_ref === `plan:${plan.id}:budget:cost_usd`,
        )
        .at(-1) ?? null;

    return {
      inputTokensUsed,
      outputTokensUsed,
      tokensUsed,
      costUsdUsed,
      tokenGateId: tokenGate?.id,
      costGateId: costGate?.id,
    };
  }

  listBlobIds(): string[] {
    const dir = this.blobsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
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

  loadSpecMetadata(specId: string): { version: number; status: string } | null {
    const metadata = readJson<{ version?: number; status?: string }>(
      resolve(this.workspaceRoot, ".sloppy", "specs", "specs", specId, "metadata.json"),
    );
    if (typeof metadata?.version !== "number") return null;
    return {
      version: metadata.version,
      status: typeof metadata.status === "string" ? metadata.status : "draft",
    };
  }

  currentSpecVersion(specId: string): number | null {
    return this.loadSpecMetadata(specId)?.version ?? null;
  }

  assertPlanSpecFresh(plan: Plan): void {
    if (!plan.spec_id || plan.spec_version === undefined) {
      return;
    }
    const metadata = this.loadSpecMetadata(plan.spec_id);
    if (metadata === null) {
      throw codedError(
        "stale_spec_version",
        `Plan references unknown spec ${plan.spec_id} version ${plan.spec_version}.`,
      );
    }
    if (metadata.version !== plan.spec_version) {
      throw codedError(
        "stale_spec_version",
        `Plan references spec ${plan.spec_id} version ${plan.spec_version}, but current version is ${metadata.version}.`,
      );
    }
    if (metadata.status !== "accepted") {
      throw codedError(
        "spec_not_accepted",
        `Plan references spec ${plan.spec_id} version ${plan.spec_version}, but its status is ${metadata.status}, not accepted.`,
      );
    }
  }

  latestAcceptedGate(gateType: Gate["gate_type"], subjectRef: string): Gate | null {
    return (
      this.listGates()
        .filter(
          (gate) =>
            gate.gate_type === gateType &&
            gate.subject_ref === subjectRef &&
            gate.status === "accepted",
        )
        .at(-1) ?? null
    );
  }

  findOpenGate(gateType: Gate["gate_type"], subjectRef: string): Gate | null {
    return (
      this.listGates().find(
        (gate) =>
          gate.gate_type === gateType && gate.subject_ref === subjectRef && gate.status === "open",
      ) ?? null
    );
  }

  latestFinalAuditForPlan(plan: Plan): FinalAuditRecord | null {
    return (
      this.listAudits()
        .filter((audit) => audit.plan_id === plan.id)
        .at(-1) ?? null
    );
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

  private retryChainLength(taskId: string): number {
    let count = 0;
    let currentId = taskId;
    const seen = new Set<string>();
    while (!seen.has(currentId)) {
      seen.add(currentId);
      const definition = this.loadTaskDefinition(currentId);
      if (!definition?.retry_of) {
        return count;
      }
      count += 1;
      currentId = definition.retry_of;
    }
    return count;
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

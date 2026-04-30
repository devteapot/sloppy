import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

type SpecStatus = "draft" | "active" | "accepted" | "archived";
type RequirementStatus = "active" | "changed" | "removed";
type RequirementPriority = "must" | "should" | "could";
type CriterionKind = "code" | "text";
type SpecChangeStatus = "proposed" | "approved" | "rejected";

type ActiveSpec = {
  active_spec_id?: string;
  updated_at: string;
  version?: number;
};

type SpecMetadata = {
  id: string;
  title: string;
  status: SpecStatus;
  goal_id?: string;
  goal_version?: number;
  created_at: string;
  updated_at: string;
  accepted_at?: string;
  version?: number;
};

type SpecRequirement = {
  id: string;
  text: string;
  status: RequirementStatus;
  priority: RequirementPriority;
  tags: string[];
  criterion_kind?: CriterionKind;
  verification_hint?: string;
  created_at: string;
  updated_at: string;
};

type SpecDecision = {
  id: string;
  summary: string;
  rationale?: string;
  requirement_refs: string[];
  created_at: string;
};

type SpecChange = {
  id: string;
  status: SpecChangeStatus;
  summary: string;
  details: string;
  requirement_refs: string[];
  created_at: string;
  resolved_at?: string;
  resolution_reason?: string;
  version?: number;
};

type SpecVersionSnapshot = {
  spec_id: string;
  version: number;
  metadata: SpecMetadata;
  body: string;
  requirements: SpecRequirement[];
  decisions: SpecDecision[];
  changes: SpecChange[];
  created_at: string;
};

type GateRecord = {
  gate_type?: string;
  status?: string;
  subject_ref?: string;
};

export interface SpecProviderOptions {
  workspaceRoot: string;
}

const SPECS_DIR = ".sloppy/specs";

function now(): string {
  return new Date().toISOString();
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePriority(value: unknown): RequirementPriority {
  return value === "should" || value === "could" ? value : "must";
}

function normalizeCriterionKind(value: unknown): CriterionKind | undefined {
  if (value === "code" || value === "text") return value;
  return undefined;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "spec";
}

export class SpecProvider {
  readonly server: SlopServer;
  private workspaceRoot: string;
  private root: string;
  private specVersions = new Map<string, number>();
  private activeVersion = 0;

  constructor(options: SpecProviderOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.root = resolve(this.workspaceRoot, SPECS_DIR);

    mkdirSync(this.specsRoot(), { recursive: true });
    this.hydrateVersionsFromDisk();

    this.server = createSlopServer({
      id: "spec",
      name: "Spec",
    });

    this.server.register("specs", () => this.buildSpecsDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private specsRoot(): string {
    return join(this.root, "specs");
  }

  private activePath(): string {
    return join(this.root, "active.json");
  }

  private specDir(specId: string): string {
    return join(this.specsRoot(), specId);
  }

  private metadataPath(specId: string): string {
    return join(this.specDir(specId), "metadata.json");
  }

  private specBodyPath(specId: string): string {
    return join(this.specDir(specId), "spec.md");
  }

  private requirementsPath(specId: string): string {
    return join(this.specDir(specId), "requirements.json");
  }

  private decisionsPath(specId: string): string {
    return join(this.specDir(specId), "decisions.json");
  }

  private changesDir(specId: string): string {
    return join(this.specDir(specId), "changes");
  }

  private changePath(specId: string, changeId: string): string {
    return join(this.changesDir(specId), `${changeId}.json`);
  }

  private versionsDir(specId: string): string {
    return join(this.specDir(specId), "versions");
  }

  private versionPath(specId: string, version: number): string {
    return join(this.versionsDir(specId), `${version}.json`);
  }

  private gatePath(gateId: string): string {
    return resolve(this.workspaceRoot, ".sloppy", "orchestration", "gates", `${gateId}.json`);
  }

  private bumpSpecVersion(specId: string): number {
    const next = (this.specVersions.get(specId) ?? 0) + 1;
    this.specVersions.set(specId, next);
    return next;
  }

  private bumpActiveVersion(): number {
    this.activeVersion += 1;
    return this.activeVersion;
  }

  private hydrateVersionsFromDisk(): void {
    const active = readJson<ActiveSpec>(this.activePath());
    if (active?.version !== undefined) {
      this.activeVersion = active.version;
    }

    if (!existsSync(this.specsRoot())) return;
    for (const entry of readdirSync(this.specsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadata = readJson<SpecMetadata>(this.metadataPath(entry.name));
      if (metadata?.version !== undefined) {
        this.specVersions.set(entry.name, metadata.version);
      }
    }
  }

  private loadActiveSpec(): ActiveSpec {
    return readJson<ActiveSpec>(this.activePath()) ?? { updated_at: now(), version: 0 };
  }

  private saveActiveSpec(activeSpecId: string | undefined): ActiveSpec {
    const active: ActiveSpec = {
      active_spec_id: activeSpecId,
      updated_at: now(),
      version: this.bumpActiveVersion(),
    };
    writeJson(this.activePath(), active);
    return active;
  }

  private listSpecIds(): string[] {
    if (!existsSync(this.specsRoot())) return [];
    return readdirSync(this.specsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private loadMetadata(specId: string): SpecMetadata | null {
    return readJson<SpecMetadata>(this.metadataPath(specId));
  }

  private loadRequirements(specId: string): SpecRequirement[] {
    return readJson<SpecRequirement[]>(this.requirementsPath(specId)) ?? [];
  }

  private saveRequirements(specId: string, requirements: SpecRequirement[]): void {
    writeJson(this.requirementsPath(specId), requirements);
  }

  private loadDecisions(specId: string): SpecDecision[] {
    return readJson<SpecDecision[]>(this.decisionsPath(specId)) ?? [];
  }

  private saveDecisions(specId: string, decisions: SpecDecision[]): void {
    writeJson(this.decisionsPath(specId), decisions);
  }

  private loadChanges(specId: string): SpecChange[] {
    const dir = this.changesDir(specId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<SpecChange>(join(dir, entry.name)))
      .filter((change): change is SpecChange => change !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private saveMetadata(specId: string, update: Partial<SpecMetadata>): SpecMetadata {
    const existing = this.loadMetadata(specId);
    if (!existing) {
      throw new Error(`Unknown spec: ${specId}`);
    }
    const version = this.bumpSpecVersion(specId);
    const metadata: SpecMetadata = {
      ...existing,
      ...update,
      updated_at: now(),
      version,
    };
    writeJson(this.metadataPath(specId), metadata);
    this.writeVersionSnapshot(specId, metadata);
    return metadata;
  }

  private assertSpec(specId: string): SpecMetadata {
    const metadata = this.loadMetadata(specId);
    if (!metadata) {
      throw new Error(`Unknown spec: ${specId}`);
    }
    return metadata;
  }

  private createSpec(params: {
    title: string;
    body?: string;
    make_active?: boolean;
    goal_id?: string;
    goal_version?: number;
  }): SpecMetadata & { active: boolean } {
    const id = `spec-${slugify(params.title)}-${crypto.randomUUID().slice(0, 6)}`;
    const timestamp = now();
    const version = this.bumpSpecVersion(id);
    const metadata: SpecMetadata = {
      id,
      title: params.title,
      status: params.make_active === false ? "draft" : "active",
      goal_id: params.goal_id,
      goal_version: params.goal_version,
      created_at: timestamp,
      updated_at: timestamp,
      version,
    };

    mkdirSync(this.changesDir(id), { recursive: true });
    mkdirSync(this.versionsDir(id), { recursive: true });
    writeJson(this.metadataPath(id), metadata);
    writeJson(this.requirementsPath(id), []);
    writeJson(this.decisionsPath(id), []);
    writeFileSync(this.specBodyPath(id), `${params.body?.trim() ?? `# ${params.title}`}\n`, "utf8");
    this.writeVersionSnapshot(id, metadata);

    const makeActive = params.make_active !== false;
    if (makeActive) {
      this.setActiveSpec(id);
    } else {
      this.server.refresh();
    }

    return { ...metadata, active: makeActive };
  }

  private setActiveSpec(specId: string): { active_spec_id: string; version: number } {
    this.assertSpec(specId);
    for (const id of this.listSpecIds()) {
      const metadata = this.loadMetadata(id);
      if (!metadata) continue;
      const nextStatus: SpecStatus = id === specId ? "active" : "draft";
      if (
        metadata.status !== "archived" &&
        metadata.status !== "accepted" &&
        metadata.status !== nextStatus
      ) {
        this.saveMetadata(id, { status: nextStatus });
      }
    }
    const active = this.saveActiveSpec(specId);
    this.server.refresh();
    return { active_spec_id: specId, version: active.version ?? this.activeVersion };
  }

  private archiveSpec(specId: string): { id: string; status: SpecStatus } {
    this.saveMetadata(specId, { status: "archived" });
    const active = this.loadActiveSpec();
    if (active.active_spec_id === specId) {
      this.saveActiveSpec(undefined);
    }
    this.server.refresh();
    return { id: specId, status: "archived" };
  }

  private readSpec(specId: string): { id: string; body: string } {
    this.assertSpec(specId);
    return { id: specId, body: readFileSync(this.specBodyPath(specId), "utf8") };
  }

  private addRequirement(params: {
    spec_id: string;
    text: string;
    priority?: RequirementPriority;
    tags?: string[];
    criterion_kind?: CriterionKind;
    verification_hint?: string;
  }): SpecRequirement {
    this.assertSpec(params.spec_id);
    const requirements = this.loadRequirements(params.spec_id);
    const timestamp = now();
    const requirement: SpecRequirement = {
      id: `req-${crypto.randomUUID().slice(0, 8)}`,
      text: params.text,
      status: "active",
      priority: params.priority ?? "must",
      tags: params.tags ?? [],
      criterion_kind: params.criterion_kind,
      verification_hint: params.verification_hint,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.saveRequirements(params.spec_id, [...requirements, requirement]);
    this.saveMetadata(params.spec_id, {});
    this.server.refresh();
    return requirement;
  }

  private acceptSpec(params: { spec_id: string; gate_id: string }): SpecMetadata {
    const metadata = this.assertSpec(params.spec_id);
    const gate = readJson<GateRecord>(this.gatePath(params.gate_id));
    const subjectRef = `spec:${metadata.id}:v${metadata.version ?? 0}`;
    if (
      gate?.gate_type !== "spec_accept" ||
      gate.status !== "accepted" ||
      gate.subject_ref !== subjectRef
    ) {
      throw new Error(
        `Spec ${metadata.id} requires an accepted spec_accept gate for ${subjectRef}.`,
      );
    }
    return this.saveMetadata(metadata.id, {
      status: "accepted",
      accepted_at: now(),
    });
  }

  private recordDecision(params: {
    spec_id: string;
    summary: string;
    rationale?: string;
    requirement_refs?: string[];
  }): SpecDecision {
    this.assertSpec(params.spec_id);
    const decisions = this.loadDecisions(params.spec_id);
    const decision: SpecDecision = {
      id: `decision-${crypto.randomUUID().slice(0, 8)}`,
      summary: params.summary,
      rationale: params.rationale,
      requirement_refs: params.requirement_refs ?? [],
      created_at: now(),
    };
    this.saveDecisions(params.spec_id, [...decisions, decision]);
    this.saveMetadata(params.spec_id, {});
    this.server.refresh();
    return decision;
  }

  private proposeChange(params: {
    spec_id: string;
    summary: string;
    details: string;
    requirement_refs?: string[];
  }): SpecChange {
    this.assertSpec(params.spec_id);
    const change: SpecChange = {
      id: `change-${crypto.randomUUID().slice(0, 8)}`,
      status: "proposed",
      summary: params.summary,
      details: params.details,
      requirement_refs: params.requirement_refs ?? [],
      created_at: now(),
      version: 1,
    };
    writeJson(this.changePath(params.spec_id, change.id), change);
    this.saveMetadata(params.spec_id, {});
    this.server.refresh();
    return change;
  }

  private resolveChange(params: {
    spec_id: string;
    change_id: string;
    status: "approved" | "rejected";
    reason?: string;
  }): { id: string; status: SpecChangeStatus; version: number } {
    this.assertSpec(params.spec_id);
    const change = readJson<SpecChange>(this.changePath(params.spec_id, params.change_id));
    if (!change) {
      throw new Error(`Unknown spec change: ${params.change_id}`);
    }
    if (change.status !== "proposed") {
      throw new Error(`Spec change ${params.change_id} is already ${change.status}.`);
    }
    const next: SpecChange = {
      ...change,
      status: params.status,
      resolved_at: now(),
      resolution_reason: params.reason,
      version: (change.version ?? 0) + 1,
    };
    writeJson(this.changePath(params.spec_id, params.change_id), next);
    this.saveMetadata(params.spec_id, {});
    this.server.refresh();
    return { id: next.id, status: next.status, version: next.version ?? 1 };
  }

  private buildRequirementItems(specId: string): ItemDescriptor[] {
    return this.loadRequirements(specId).map((requirement) => ({
      id: requirement.id,
      props: requirement,
      summary: `${requirement.priority}: ${requirement.text}`,
      meta: {
        salience: requirement.priority === "must" ? 0.9 : 0.65,
      },
    }));
  }

  private loadVersionSnapshots(specId: string): SpecVersionSnapshot[] {
    const dir = this.versionsDir(specId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<SpecVersionSnapshot>(join(dir, entry.name)))
      .filter((snapshot): snapshot is SpecVersionSnapshot => snapshot !== null)
      .sort((a, b) => a.version - b.version);
  }

  private writeVersionSnapshot(specId: string, metadata = this.assertSpec(specId)): void {
    const version = metadata.version ?? this.specVersions.get(specId) ?? 0;
    if (version <= 0) return;
    const snapshot: SpecVersionSnapshot = {
      spec_id: specId,
      version,
      metadata,
      body: existsSync(this.specBodyPath(specId))
        ? readFileSync(this.specBodyPath(specId), "utf8")
        : "",
      requirements: this.loadRequirements(specId),
      decisions: this.loadDecisions(specId),
      changes: this.loadChanges(specId),
      created_at: now(),
    };
    writeJson(this.versionPath(specId, version), snapshot);
  }

  private buildVersionItems(specId: string): ItemDescriptor[] {
    return this.loadVersionSnapshots(specId).map((snapshot) => ({
      id: String(snapshot.version),
      props: {
        spec_id: snapshot.spec_id,
        version: snapshot.version,
        title: snapshot.metadata.title,
        status: snapshot.metadata.status,
        goal_id: snapshot.metadata.goal_id,
        goal_version: snapshot.metadata.goal_version,
        requirement_count: snapshot.requirements.length,
        decision_count: snapshot.decisions.length,
        created_at: snapshot.created_at,
      },
      summary: `v${snapshot.version}: ${snapshot.metadata.title}`,
      actions: {
        read_version: action(async () => snapshot, {
          label: "Read Version",
          description: "Return this immutable spec version snapshot.",
          idempotent: true,
          estimate: "fast",
        }),
      },
      meta: {
        salience: snapshot.version === this.loadMetadata(specId)?.version ? 0.7 : 0.3,
      },
    }));
  }

  private buildDecisionItems(specId: string): ItemDescriptor[] {
    return this.loadDecisions(specId).map((decision) => ({
      id: decision.id,
      props: decision,
      summary: decision.summary,
      meta: {
        salience: 0.55,
      },
    }));
  }

  private buildChangeItems(specId: string): ItemDescriptor[] {
    return this.loadChanges(specId).map((change) => ({
      id: change.id,
      props: change,
      summary: `${change.status}: ${change.summary}`,
      actions: {
        ...(change.status === "proposed"
          ? {
              approve_change: action(
                {
                  reason: {
                    type: "string",
                    description: "Optional explanation for approving this spec change.",
                    optional: true,
                  },
                },
                async ({ reason }) =>
                  this.resolveChange({
                    spec_id: specId,
                    change_id: change.id,
                    status: "approved",
                    reason: typeof reason === "string" ? reason : undefined,
                  }),
                {
                  label: "Approve Change",
                  description: "Approve this proposed spec change.",
                  estimate: "instant",
                },
              ),
              reject_change: action(
                {
                  reason: {
                    type: "string",
                    description: "Optional explanation for rejecting this spec change.",
                    optional: true,
                  },
                },
                async ({ reason }) =>
                  this.resolveChange({
                    spec_id: specId,
                    change_id: change.id,
                    status: "rejected",
                    reason: typeof reason === "string" ? reason : undefined,
                  }),
                {
                  label: "Reject Change",
                  description: "Reject this proposed spec change.",
                  estimate: "instant",
                },
              ),
            }
          : {}),
      },
      meta: {
        salience: change.status === "proposed" ? 0.9 : 0.45,
        urgency: change.status === "proposed" ? "medium" : "low",
      },
    }));
  }

  private buildSpecItem(metadata: SpecMetadata, activeSpecId: string | undefined): ItemDescriptor {
    const requirements = this.loadRequirements(metadata.id);
    const decisions = this.loadDecisions(metadata.id);
    const changes = this.loadChanges(metadata.id);
    const versions = this.loadVersionSnapshots(metadata.id);
    const body = existsSync(this.specBodyPath(metadata.id))
      ? readFileSync(this.specBodyPath(metadata.id), "utf8")
      : "";

    return {
      id: metadata.id,
      props: {
        ...metadata,
        active: activeSpecId === metadata.id,
        requirement_count: requirements.length,
        decision_count: decisions.length,
        proposed_change_count: changes.filter((change) => change.status === "proposed").length,
        version_count: versions.length,
        body_preview: truncateText(body, 400),
        spec_path: this.specBodyPath(metadata.id),
      },
      summary: metadata.title,
      actions: {
        read_spec: action(async () => this.readSpec(metadata.id), {
          label: "Read Spec",
          description: "Return the full spec.md body.",
          idempotent: true,
          estimate: "fast",
        }),
        set_active: action(async () => this.setActiveSpec(metadata.id), {
          label: "Set Active",
          description: "Make this spec the active source of truth.",
          estimate: "instant",
        }),
        archive: action(async () => this.archiveSpec(metadata.id), {
          label: "Archive Spec",
          description: "Archive this spec and clear it as active if needed.",
          dangerous: true,
          estimate: "instant",
        }),
        accept_spec: action(
          {
            gate_id: {
              type: "string",
              description:
                "Accepted orchestration spec_accept gate whose subject_ref is spec:<id>:v<version>.",
            },
          },
          async ({ gate_id }) =>
            this.acceptSpec({
              spec_id: metadata.id,
              gate_id: gate_id as string,
            }),
          {
            label: "Accept Spec",
            description:
              "Freeze this spec version after an accepted spec_accept gate from the orchestration provider.",
            estimate: "instant",
          },
        ),
        add_requirement: action(
          {
            text: "string",
            priority: {
              type: "string",
              description: "Priority for this requirement: must, should, or could.",
              enum: ["must", "should", "could"],
              optional: true,
            },
            tags: {
              type: "array",
              description: "Optional tags for filtering requirements.",
              items: { type: "string" },
              optional: true,
            },
            criterion_kind: {
              type: "string",
              description: "Optional criterion kind: code or text.",
              enum: ["code", "text"],
              optional: true,
            },
            verification_hint: {
              type: "string",
              description: "Optional hint for how to verify this requirement.",
              optional: true,
            },
          },
          async ({ text, priority, tags, criterion_kind, verification_hint }) =>
            this.addRequirement({
              spec_id: metadata.id,
              text: text as string,
              priority: normalizePriority(priority),
              tags: normalizeStringList(tags),
              criterion_kind: normalizeCriterionKind(criterion_kind),
              verification_hint:
                typeof verification_hint === "string" ? verification_hint : undefined,
            }),
          {
            label: "Add Requirement",
            description: "Add a checkable requirement to this spec.",
            estimate: "instant",
          },
        ),
        record_decision: action(
          {
            summary: "string",
            rationale: {
              type: "string",
              description: "Optional rationale or tradeoff behind the decision.",
              optional: true,
            },
            requirement_refs: {
              type: "array",
              description: "Optional requirement ids this decision clarifies.",
              items: { type: "string" },
              optional: true,
            },
          },
          async ({ summary, rationale, requirement_refs }) =>
            this.recordDecision({
              spec_id: metadata.id,
              summary: summary as string,
              rationale: typeof rationale === "string" ? rationale : undefined,
              requirement_refs: normalizeStringList(requirement_refs),
            }),
          {
            label: "Record Decision",
            description: "Record a durable design/product decision tied to this spec.",
            estimate: "instant",
          },
        ),
        propose_change: action(
          {
            summary: "string",
            details: "string",
            requirement_refs: {
              type: "array",
              description: "Optional requirement ids this proposal changes or clarifies.",
              items: { type: "string" },
              optional: true,
            },
          },
          async ({ summary, details, requirement_refs }) =>
            this.proposeChange({
              spec_id: metadata.id,
              summary: summary as string,
              details: details as string,
              requirement_refs: normalizeStringList(requirement_refs),
            }),
          {
            label: "Propose Change",
            description: "Record a proposed change that must be approved before the spec shifts.",
            estimate: "instant",
          },
        ),
      },
      children: {
        requirements: {
          type: "collection",
          props: { count: requirements.length },
          summary: "Checkable requirements for this spec.",
          items: this.buildRequirementItems(metadata.id),
        },
        decisions: {
          type: "collection",
          props: { count: decisions.length },
          summary: "Recorded decisions for this spec.",
          items: this.buildDecisionItems(metadata.id),
        },
        changes: {
          type: "collection",
          props: {
            count: changes.length,
            proposed: changes.filter((change) => change.status === "proposed").length,
          },
          summary: "Proposed and resolved spec changes.",
          items: this.buildChangeItems(metadata.id),
        },
        versions: {
          type: "collection",
          props: { count: versions.length },
          summary: "Immutable spec version snapshots.",
          items: this.buildVersionItems(metadata.id),
        },
      },
      meta: {
        salience: activeSpecId === metadata.id ? 1 : 0.55,
        focus: activeSpecId === metadata.id,
      },
    };
  }

  private buildSpecsDescriptor() {
    const active = this.loadActiveSpec();
    const items: ItemDescriptor[] = this.listSpecIds()
      .map((id) => this.loadMetadata(id))
      .filter((metadata): metadata is SpecMetadata => metadata !== null)
      .map((metadata) => this.buildSpecItem(metadata, active.active_spec_id));

    return {
      type: "collection",
      props: {
        count: items.length,
        active_spec_id: active.active_spec_id,
        updated_at: active.updated_at,
        version: active.version ?? this.activeVersion,
      },
      summary: active.active_spec_id ? `Active spec: ${active.active_spec_id}` : "No active spec.",
      actions: {
        create_spec: action(
          {
            title: "string",
            body: {
              type: "string",
              description: "Optional initial spec.md body.",
              optional: true,
            },
            make_active: {
              type: "boolean",
              description: "Whether to make this spec active immediately. Defaults to true.",
              optional: true,
            },
            goal_id: {
              type: "string",
              description: "Optional upstream goal id this spec captures.",
              optional: true,
            },
            goal_version: {
              type: "number",
              description: "Optional upstream goal version this spec captures.",
              optional: true,
            },
          },
          async ({ title, body, make_active, goal_id, goal_version }) =>
            this.createSpec({
              title: title as string,
              body: typeof body === "string" ? body : undefined,
              make_active: typeof make_active === "boolean" ? make_active : undefined,
              goal_id: typeof goal_id === "string" ? goal_id : undefined,
              goal_version: typeof goal_version === "number" ? goal_version : undefined,
            }),
          {
            label: "Create Spec",
            description: "Create a durable spec and optionally make it active.",
            estimate: "instant",
          },
        ),
        set_active_spec: action(
          { spec_id: "string" },
          async ({ spec_id }) => this.setActiveSpec(spec_id as string),
          {
            label: "Set Active Spec",
            description: "Make an existing spec the active source of truth.",
            estimate: "instant",
          },
        ),
      },
      items,
      meta: {
        focus: true,
        salience: active.active_spec_id ? 1 : 0.75,
      },
    };
  }
}

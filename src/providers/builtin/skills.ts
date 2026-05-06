import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";
import { parse as parseYaml } from "yaml";

import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";
import { isWithinRoot, safeRealpath } from "./path-containment";

type SkillScope = "session" | "workspace" | "global" | "builtin" | "imported";
type WritableSkillScope = Exclude<SkillScope, "builtin" | "imported">;

type SkillInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  related_skills: string[];
  dangerous: boolean;
  platforms: string[];
  category?: string;
  metadata: Record<string, unknown>;
  skill_path: string;
  file_path: string;
  directory?: string;
  supporting_files: string[];
  scope: SkillScope;
  content?: string;
};

type SkillRoot = {
  scope: Exclude<SkillScope, "session">;
  dir: string;
  idPrefix: string;
};

type SkillProposal = {
  id: string;
  scope: WritableSkillScope;
  name: string;
  version: string;
  body: string;
  status: "proposed" | "active" | "rejected";
  created_at: string;
  activated_at?: string;
  requires_approval: boolean;
};

type SkillManageOperation = "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file";

const SKILL_SCOPE_PRECEDENCE: Record<SkillScope, number> = {
  session: 0,
  workspace: 1,
  global: 2,
  builtin: 3,
  imported: 4,
};

const DEFAULT_VIEW_MAX_BYTES = 65536;
const SLOPPY_SKILL_DIR_TOKEN = "$" + "{SLOPPY_SKILL_DIR}";

function compareSkills(a: SkillInfo, b: SkillInfo): number {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  const byScope = SKILL_SCOPE_PRECEDENCE[a.scope] - SKILL_SCOPE_PRECEDENCE[b.scope];
  if (byScope !== 0) return byScope;
  return a.id.localeCompare(b.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const parsed = parseYaml(match[1]);
  return isRecord(parsed) ? parsed : {};
}

function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function stableSkillId(prefix: string, skillPath: string): string {
  return `skill-${prefix}${skillPath.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function writableScope(value: unknown): WritableSkillScope | undefined {
  return value === "session" || value === "workspace" || value === "global" ? value : undefined;
}

function isWritableScope(scope: SkillScope): scope is WritableSkillScope {
  return scope === "session" || scope === "workspace" || scope === "global";
}

async function readTextFile(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`File does not exist: ${path}`);
  }
  if (file.size > maxBytes) {
    throw new Error(`File is too large to read through skills provider: ${path}`);
  }
  return file.text();
}

async function discoverSupportingFiles(skillDir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const files: string[] = [];

  try {
    for await (const relativePath of glob.scan({ cwd: skillDir })) {
      if (relativePath === "SKILL.md") continue;
      const absolutePath = join(skillDir, relativePath);
      try {
        if (statSync(absolutePath).isFile()) {
          files.push(relativePath);
        }
      } catch {
        // Skip files that disappear or cannot be statted during discovery.
      }
    }
  } catch {
    // Missing or unreadable skill directories are handled as empty support sets.
  }

  return files.sort();
}

export class SkillsProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private roots: SkillRoot[];
  private skills: SkillInfo[] = [];
  private proposals = new Map<string, SkillProposal>();
  private templateVars: boolean;
  private viewMaxBytes: number;
  private discoveryReady: Promise<void>;
  private discoveryLoading = false;

  constructor(options: {
    skillsDir?: string;
    builtinSkillsDir?: string;
    globalSkillsDir?: string;
    workspaceSkillsDir?: string;
    externalDirs?: string[];
    templateVars?: boolean;
    viewMaxBytes?: number;
  }) {
    this.roots = [
      ...(options.builtinSkillsDir
        ? [{ scope: "builtin" as const, dir: options.builtinSkillsDir, idPrefix: "builtin-" }]
        : []),
      {
        scope: "imported",
        dir: options.skillsDir ?? join(homedir(), ".sloppy", "skills"),
        idPrefix: "",
      },
      ...((options.externalDirs ?? []).map((dir, index) => ({
        scope: "imported" as const,
        dir,
        idPrefix: `external-${index}-`,
      })) satisfies SkillRoot[]),
      ...(options.globalSkillsDir
        ? [{ scope: "global" as const, dir: options.globalSkillsDir, idPrefix: "global-" }]
        : []),
      ...(options.workspaceSkillsDir
        ? [{ scope: "workspace" as const, dir: options.workspaceSkillsDir, idPrefix: "workspace-" }]
        : []),
    ];
    this.templateVars = options.templateVars ?? true;
    this.viewMaxBytes = options.viewMaxBytes ?? DEFAULT_VIEW_MAX_BYTES;

    this.server = createSlopServer({
      id: "skills",
      name: "Skills",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("skills", () => this.buildSkillsDescriptor());
    this.server.register("proposals", () => this.buildProposalsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());

    this.discoveryReady = this.reloadSkills();
  }

  stop(): void {
    this.server.stop();
  }

  private async discoverSkills(): Promise<SkillInfo[]> {
    const glob = new Bun.Glob("**/SKILL.md");
    const skills: SkillInfo[] = [];

    for (const root of this.roots) {
      try {
        for await (const relativePath of glob.scan({ cwd: root.dir })) {
          const filePath = join(root.dir, relativePath);
          try {
            const content = await readTextFile(filePath, this.viewMaxBytes);
            const fm = extractFrontmatter(content);
            const metadata = nestedRecord(fm, "metadata");
            const sloppyMetadata = nestedRecord(metadata, "sloppy");
            const skillPath = portablePath(relativePath.replace(/\/SKILL\.md$/, ""));
            const pathParts = skillPath.split("/").filter(Boolean);
            const category =
              typeof sloppyMetadata.category === "string"
                ? sloppyMetadata.category
                : typeof fm.category === "string"
                  ? fm.category
                  : pathParts.length > 1
                    ? pathParts[0]
                    : undefined;
            const tags = asStringArray(fm.tags);
            const sloppyTags = asStringArray(sloppyMetadata.tags);
            const skillDir = dirname(filePath);

            skills.push({
              id: stableSkillId(root.idPrefix, skillPath || "root"),
              name: typeof fm.name === "string" ? fm.name : pathParts.at(-1) || skillPath,
              description: typeof fm.description === "string" ? fm.description : "",
              version: typeof fm.version === "string" ? fm.version : "0.0.0",
              tags: tags.length > 0 ? tags : sloppyTags,
              related_skills: asStringArray(fm.related_skills),
              dangerous: fm.dangerous === true,
              platforms: asStringArray(fm.platforms),
              category,
              metadata,
              skill_path: skillPath,
              file_path: filePath,
              directory: skillDir,
              supporting_files: await discoverSupportingFiles(skillDir),
              scope: root.scope,
            });
          } catch {
            // Skip unreadable skill files.
          }
        }
      } catch {
        // Skills directory does not exist or is unreadable.
      }
    }

    return skills.sort(compareSkills);
  }

  private async reloadSkills(): Promise<void> {
    this.discoveryLoading = true;
    this.server.refresh();
    try {
      this.skills = await this.discoverSkills();
    } finally {
      this.discoveryLoading = false;
      this.server.refresh();
    }
  }

  private async ensureDiscovered(): Promise<void> {
    await this.discoveryReady;
  }

  private findSkill(skillName: string, scope?: SkillScope): SkillInfo | undefined {
    const normalized = skillName.trim();
    return this.skills.find(
      (skill) =>
        (!scope || skill.scope === scope) &&
        (skill.name === normalized ||
          skill.skill_path === normalized ||
          (skill.category ? `${skill.category}/${skill.name}` === normalized : false)),
    );
  }

  private renderSkillContent(skill: SkillInfo, content: string): string {
    if (!this.templateVars || !skill.directory) return content;
    return content.replaceAll(SLOPPY_SKILL_DIR_TOKEN, skill.directory);
  }

  private resolveSkillFile(skill: SkillInfo, filePath: string): string {
    if (!skill.directory) {
      throw new Error(`Skill ${skill.name} does not have a filesystem directory.`);
    }
    if (isAbsolute(filePath)) {
      throw new Error("file_path must be relative to the skill directory.");
    }
    const root = safeRealpath(skill.directory);
    if (!root) {
      throw new Error(`Could not resolve skill directory: ${skill.directory}`);
    }
    const absolutePath = resolve(skill.directory, filePath);
    if (!isWithinRoot(root, absolutePath)) {
      throw new Error("file_path escapes the skill directory.");
    }
    return absolutePath;
  }

  private async viewSkill(
    skillName: string,
    filePath?: string,
  ): Promise<{
    name: string;
    file_path: string;
    skill_dir?: string;
    supporting_files: string[];
    content: string;
  }> {
    await this.ensureDiscovered();
    const skill = this.findSkill(skillName);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    if (!filePath || filePath === "SKILL.md") {
      const content =
        skill.content ??
        (await readTextFile(skill.file_path, this.viewMaxBytes).catch(() => {
          throw new Error(`Could not read skill file: ${skill.file_path}`);
        }));
      return {
        name: skill.name,
        file_path: "SKILL.md",
        skill_dir: skill.directory,
        supporting_files: skill.supporting_files,
        content: this.renderSkillContent(skill, content),
      };
    }

    const absolutePath = this.resolveSkillFile(skill, filePath);
    const content = await readTextFile(absolutePath, this.viewMaxBytes);

    return {
      name: skill.name,
      file_path: portablePath(relative(skill.directory ?? dirname(absolutePath), absolutePath)),
      skill_dir: skill.directory,
      supporting_files: skill.supporting_files,
      content: this.renderSkillContent(skill, content),
    };
  }

  private sessionSkillFromProposal(proposal: SkillProposal): SkillInfo {
    const fm = extractFrontmatter(proposal.body);
    const metadata = nestedRecord(fm, "metadata");
    const sloppyMetadata = nestedRecord(metadata, "sloppy");
    return {
      id: `skill-session-${proposal.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      name: proposal.name,
      description: typeof fm.description === "string" ? fm.description : "",
      version: proposal.version,
      tags:
        asStringArray(fm.tags).length > 0
          ? asStringArray(fm.tags)
          : asStringArray(sloppyMetadata.tags),
      related_skills: asStringArray(fm.related_skills),
      dangerous: fm.dangerous === true,
      platforms: asStringArray(fm.platforms),
      category:
        typeof sloppyMetadata.category === "string"
          ? sloppyMetadata.category
          : typeof fm.category === "string"
            ? fm.category
            : undefined,
      metadata,
      skill_path: proposal.name,
      file_path: "",
      supporting_files: [],
      scope: "session",
      content: proposal.body,
    };
  }

  private proposeSkill(params: Record<string, unknown>): SkillProposal {
    const scope = writableScope(params.scope) ?? "session";
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const body = typeof params.body === "string" ? params.body : "";
    if (!name) throw new Error("name must be a non-empty string.");
    if (!body.trim()) throw new Error("body must be non-empty.");
    const proposal: SkillProposal = {
      id: `skill-proposal-${crypto.randomUUID()}`,
      scope,
      name,
      version: typeof params.version === "string" ? params.version : "0.0.0",
      body,
      status: "proposed",
      created_at: new Date().toISOString(),
      requires_approval: scope !== "session",
    };
    this.proposals.set(proposal.id, proposal);
    this.server.refresh();
    return proposal;
  }

  private async activateSkillProposal(
    proposalId: string,
    approved = false,
  ): Promise<SkillProposal> {
    await this.ensureDiscovered();
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Unknown skill proposal: ${proposalId}`);
    if (proposal.status !== "proposed") {
      throw new Error(`Skill proposal ${proposalId} is already ${proposal.status}.`);
    }
    if (proposal.requires_approval && !approved) {
      const approvalId = this.approvals.request({
        path: `/proposals/${proposalId}`,
        action: "activate_skill_proposal",
        reason: `Activating ${proposal.scope} skill "${proposal.name}" writes persistent skill state.`,
        paramsPreview: JSON.stringify({ scope: proposal.scope, name: proposal.name }),
        dangerous: true,
        execute: () => this.activateSkillProposal(proposalId, true),
      });
      throw createApprovalRequiredError(
        `Activating skill proposal ${proposalId} requires approval via /approvals/${approvalId}.`,
      );
    }

    if (proposal.scope === "session") {
      this.skills.push(this.sessionSkillFromProposal(proposal));
      this.skills.sort(compareSkills);
    } else {
      const root = this.roots.find((candidate) => candidate.scope === proposal.scope);
      if (!root) {
        throw new Error(`No ${proposal.scope} skill root is configured.`);
      }
      const slug = slugify(proposal.name);
      const dir = join(root.dir, slug || "skill");
      const skillPath = join(dir, "SKILL.md");
      if (existsSync(skillPath)) {
        throw new Error(
          `Refusing to overwrite existing ${proposal.scope} skill "${proposal.name}" at ${skillPath}.`,
        );
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        skillPath,
        proposal.body.endsWith("\n") ? proposal.body : `${proposal.body}\n`,
        "utf8",
      );
      this.discoveryReady = this.reloadSkills();
      await this.discoveryReady;
    }
    proposal.status = "active";
    proposal.activated_at = new Date().toISOString();
    this.server.refresh();
    return proposal;
  }

  private parseManageOperation(value: unknown): SkillManageOperation {
    const operation = typeof value === "string" ? value : "";
    if (
      operation === "create" ||
      operation === "patch" ||
      operation === "edit" ||
      operation === "delete" ||
      operation === "write_file" ||
      operation === "remove_file"
    ) {
      return operation;
    }
    throw new Error("operation must be create, patch, edit, delete, write_file, or remove_file.");
  }

  private defaultCreateScope(params: Record<string, unknown>): WritableSkillScope {
    const explicit = writableScope(params.scope);
    if (explicit) return explicit;
    if (this.roots.some((root) => root.scope === "workspace")) return "workspace";
    if (this.roots.some((root) => root.scope === "global")) return "global";
    return "session";
  }

  private rootForScope(scope: Exclude<WritableSkillScope, "session">): SkillRoot {
    const root = this.roots.find((candidate) => candidate.scope === scope);
    if (!root) throw new Error(`No ${scope} skill root is configured.`);
    return root;
  }

  private persistentSkillPath(
    root: SkillRoot,
    params: Record<string, unknown>,
    name: string,
  ): { dir: string; skillPath: string } {
    const category = typeof params.category === "string" ? slugify(params.category) : "";
    const slug = slugify(name) || "skill";
    const dir = resolve(root.dir, category ? join(category, slug) : slug);
    mkdirSync(root.dir, { recursive: true });
    const rootReal = safeRealpath(root.dir);
    if (!rootReal || !isWithinRoot(rootReal, dir)) {
      throw new Error("Resolved skill path escapes the configured skill root.");
    }
    return { dir, skillPath: join(dir, "SKILL.md") };
  }

  private resolveWritableFile(skill: SkillInfo, filePath: string): string {
    if (!skill.directory)
      throw new Error(`Skill ${skill.name} does not have a filesystem directory.`);
    if (!filePath || filePath === "SKILL.md") {
      throw new Error("Use patch or edit to modify SKILL.md.");
    }
    return this.resolveSkillFile(skill, filePath);
  }

  private async manageSkill(
    params: Record<string, unknown>,
    approved = false,
  ): Promise<Record<string, unknown>> {
    await this.ensureDiscovered();
    const operation = this.parseManageOperation(params.operation ?? params.action);
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) throw new Error("name must be a non-empty string.");

    const explicitScope = writableScope(params.scope);
    const existing =
      operation === "create" ? undefined : this.findSkill(name, explicitScope ?? undefined);
    if (operation !== "create" && !existing) {
      throw new Error(`Unknown skill: ${name}`);
    }
    if (existing && !isWritableScope(existing.scope)) {
      throw new Error(
        `Cannot modify ${existing.scope} skill "${existing.name}". Create a workspace or global shadow instead.`,
      );
    }
    let scope: WritableSkillScope;
    if (operation === "create") {
      scope = this.defaultCreateScope(params);
    } else {
      if (!existing) throw new Error(`Unknown skill: ${name}`);
      if (!isWritableScope(existing.scope)) {
        throw new Error(
          `Cannot modify ${existing.scope} skill "${existing.name}". Create a workspace or global shadow instead.`,
        );
      }
      scope = existing.scope;
    }

    if (scope !== "session" && !approved) {
      const approvalId = this.approvals.request({
        path: "/session",
        action: "skill_manage",
        reason: `Skill manage ${operation} writes persistent ${scope} skill state for "${name}".`,
        paramsPreview: JSON.stringify({
          operation,
          scope,
          name,
          file_path: typeof params.file_path === "string" ? params.file_path : undefined,
        }),
        dangerous: true,
        execute: () => this.manageSkill({ ...params, operation }, true),
      });
      throw createApprovalRequiredError(
        `Skill manage ${operation} for ${name} requires approval via /approvals/${approvalId}.`,
      );
    }

    switch (operation) {
      case "create":
        return this.manageCreate(params, scope, name);
      case "patch":
        if (!existing) throw new Error(`Unknown skill: ${name}`);
        return this.managePatch(params, existing);
      case "edit":
        if (!existing) throw new Error(`Unknown skill: ${name}`);
        return this.manageEdit(params, existing);
      case "delete":
        if (!existing) throw new Error(`Unknown skill: ${name}`);
        return this.manageDelete(existing);
      case "write_file":
        if (!existing) throw new Error(`Unknown skill: ${name}`);
        return this.manageWriteFile(params, existing);
      case "remove_file":
        if (!existing) throw new Error(`Unknown skill: ${name}`);
        return this.manageRemoveFile(params, existing);
    }
  }

  private async manageCreate(
    params: Record<string, unknown>,
    scope: WritableSkillScope,
    name: string,
  ): Promise<Record<string, unknown>> {
    const content =
      typeof params.content === "string"
        ? params.content
        : typeof params.body === "string"
          ? params.body
          : "";
    if (!content.trim()) throw new Error("content must be non-empty for create.");

    if (scope === "session") {
      const proposal: SkillProposal = {
        id: `skill-managed-${crypto.randomUUID()}`,
        scope,
        name,
        version: typeof params.version === "string" ? params.version : "0.0.0",
        body: content,
        status: "active",
        created_at: new Date().toISOString(),
        activated_at: new Date().toISOString(),
        requires_approval: false,
      };
      this.skills.push(this.sessionSkillFromProposal(proposal));
      this.skills.sort(compareSkills);
      this.server.refresh();
      return { operation: "create", status: "active", scope, name };
    }

    const root = this.rootForScope(scope);
    const { dir, skillPath } = this.persistentSkillPath(root, params, name);
    if (existsSync(skillPath)) {
      throw new Error(`Refusing to overwrite existing ${scope} skill "${name}" at ${skillPath}.`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(skillPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    this.skills = await this.discoverSkills();
    this.server.refresh();
    return { operation: "create", status: "active", scope, name, file_path: skillPath };
  }

  private async managePatch(
    params: Record<string, unknown>,
    skill: SkillInfo,
  ): Promise<Record<string, unknown>> {
    const oldString = typeof params.old_string === "string" ? params.old_string : "";
    const newString = typeof params.new_string === "string" ? params.new_string : "";
    if (!oldString) throw new Error("old_string must be non-empty for patch.");

    const current = skill.content ?? (await readTextFile(skill.file_path, this.viewMaxBytes));
    const occurrences = current.split(oldString).length - 1;
    if (occurrences !== 1) {
      throw new Error(`old_string must appear exactly once; found ${occurrences}.`);
    }
    const updated = current.replace(oldString, newString);

    if (skill.scope === "session") {
      skill.content = updated;
    } else {
      writeFileSync(skill.file_path, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
      this.skills = await this.discoverSkills();
    }
    this.server.refresh();
    return { operation: "patch", status: "active", scope: skill.scope, name: skill.name };
  }

  private async manageEdit(
    params: Record<string, unknown>,
    skill: SkillInfo,
  ): Promise<Record<string, unknown>> {
    const content =
      typeof params.content === "string"
        ? params.content
        : typeof params.body === "string"
          ? params.body
          : "";
    if (!content.trim()) throw new Error("content must be non-empty for edit.");

    if (skill.scope === "session") {
      skill.content = content;
    } else {
      writeFileSync(skill.file_path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      this.skills = await this.discoverSkills();
    }
    this.server.refresh();
    return { operation: "edit", status: "active", scope: skill.scope, name: skill.name };
  }

  private async manageDelete(skill: SkillInfo): Promise<Record<string, unknown>> {
    if (skill.scope === "session") {
      this.skills = this.skills.filter((candidate) => candidate.id !== skill.id);
      this.server.refresh();
      return { operation: "delete", status: "deleted", scope: skill.scope, name: skill.name };
    }
    if (skill.scope !== "workspace" && skill.scope !== "global") {
      throw new Error(`Cannot delete ${skill.scope} skill "${skill.name}".`);
    }
    if (!skill.directory)
      throw new Error(`Skill ${skill.name} does not have a filesystem directory.`);
    const root = this.rootForScope(skill.scope);
    const rootReal = safeRealpath(root.dir);
    const dirReal = safeRealpath(skill.directory);
    if (!rootReal || !dirReal || rootReal === dirReal || !isWithinRoot(rootReal, skill.directory)) {
      throw new Error(`Refusing to delete unsafe skill directory: ${skill.directory}`);
    }
    rmSync(skill.directory, { recursive: true, force: true });
    this.skills = await this.discoverSkills();
    this.server.refresh();
    return { operation: "delete", status: "deleted", scope: skill.scope, name: skill.name };
  }

  private async manageWriteFile(
    params: Record<string, unknown>,
    skill: SkillInfo,
  ): Promise<Record<string, unknown>> {
    const filePath = typeof params.file_path === "string" ? params.file_path : "";
    const content =
      typeof params.file_content === "string"
        ? params.file_content
        : typeof params.content === "string"
          ? params.content
          : "";
    if (!filePath) throw new Error("file_path must be non-empty for write_file.");
    const absolutePath = this.resolveWritableFile(skill, filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
    this.skills = await this.discoverSkills();
    this.server.refresh();
    return {
      operation: "write_file",
      status: "active",
      scope: skill.scope,
      name: skill.name,
      file_path: filePath,
    };
  }

  private async manageRemoveFile(
    params: Record<string, unknown>,
    skill: SkillInfo,
  ): Promise<Record<string, unknown>> {
    const filePath = typeof params.file_path === "string" ? params.file_path : "";
    if (!filePath) throw new Error("file_path must be non-empty for remove_file.");
    const absolutePath = this.resolveWritableFile(skill, filePath);
    rmSync(absolutePath, { force: true });
    this.skills = await this.discoverSkills();
    this.server.refresh();
    return {
      operation: "remove_file",
      status: "active",
      scope: skill.scope,
      name: skill.name,
      file_path: filePath,
    };
  }

  private buildSessionDescriptor() {
    const tagSet = new Set(this.skills.flatMap((s) => s.tags));
    const categories = [...new Set(this.skills.map((skill) => skill.category).filter(Boolean))];

    return {
      type: "context",
      props: {
        skills_count: this.skills.length,
        tags_count: tagSet.size,
        categories,
        installed: this.skills.map((s) => s.name),
        proposals_count: this.proposals.size,
        loading: this.discoveryLoading,
      },
      summary:
        "Discoverable agent skills. Use skill_view for progressive disclosure and skill_manage for agent-managed procedural memory.",
      actions: {
        refresh_skills: action(
          async () => {
            this.discoveryReady = this.reloadSkills();
            await this.discoveryReady;
            return { skills_count: this.skills.length };
          },
          {
            label: "Refresh Skills",
            description: "Re-scan the skills directories and update the skills list.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        view_skill: action(
          {
            name: {
              type: "string",
              description: "Skill name to open (for example: demo-skill).",
            },
            file_path: {
              type: "string",
              optional: true,
              description: "Optional supporting file path relative to the skill directory.",
            },
          },
          async ({ name, file_path }) =>
            this.viewSkill(String(name), typeof file_path === "string" ? file_path : undefined),
          {
            label: "View Skill By Name",
            description: "Read the full content of a skill or one of its supporting files.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        skill_view: action(
          {
            name: "string",
            file_path: {
              type: "string",
              optional: true,
            },
          },
          async ({ name, file_path }) =>
            this.viewSkill(String(name), typeof file_path === "string" ? file_path : undefined),
          {
            label: "Skill View",
            description: "Progressive skill disclosure: load SKILL.md or a supporting file.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        propose_skill: action(
          {
            name: "string",
            body: "string",
            version: {
              type: "string",
              optional: true,
            },
            scope: {
              type: "string",
              enum: ["session", "workspace", "global"],
              optional: true,
            },
          },
          (params) => this.proposeSkill(params),
          {
            label: "Propose Skill",
            description: "Create a proposed skill version for session, workspace, or global scope.",
            estimate: "fast",
          },
        ),
        skill_manage: action(
          {
            operation: {
              type: "string",
              enum: ["create", "patch", "edit", "delete", "write_file", "remove_file"],
            },
            name: "string",
            scope: {
              type: "string",
              enum: ["session", "workspace", "global"],
              optional: true,
            },
            category: {
              type: "string",
              optional: true,
            },
            content: {
              type: "string",
              optional: true,
            },
            old_string: {
              type: "string",
              optional: true,
            },
            new_string: {
              type: "string",
              optional: true,
            },
            file_path: {
              type: "string",
              optional: true,
            },
            file_content: {
              type: "string",
              optional: true,
            },
          },
          (params) => this.manageSkill(params),
          {
            label: "Skill Manage",
            description:
              "Create, patch, edit, delete, or manage supporting files for agent skills.",
            estimate: "fast",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 0.7,
      },
    };
  }

  private buildSkillsDescriptor() {
    const items: ItemDescriptor[] = this.skills.map((skill) => ({
      id: skill.id,
      props: {
        name: skill.dangerous ? `[DANGEROUS] ${skill.name}` : skill.name,
        description: skill.description,
        version: skill.version,
        tags: skill.tags,
        scope: skill.scope,
        category: skill.category,
        platforms: skill.platforms,
        skill_path: skill.skill_path,
        file_path: skill.file_path,
        supporting_files: skill.supporting_files,
        ...(skill.related_skills.length > 0 ? { related_skills: skill.related_skills } : {}),
      },
      summary: skill.description || skill.name,
      actions: {
        view_skill: action(async () => this.viewSkill(skill.name), {
          label: "View Skill",
          description: "Read this skill's SKILL.md file.",
          idempotent: true,
          estimate: "fast",
        }),
        skill_view: action(
          {
            file_path: {
              type: "string",
              optional: true,
            },
          },
          async ({ file_path }) =>
            this.viewSkill(skill.name, typeof file_path === "string" ? file_path : undefined),
          {
            label: "Skill View",
            description: "Read this skill's SKILL.md file or a supporting file.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
      ...(skill.dangerous ? { meta: { salience: 0.9, urgency: "high" as const } } : {}),
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Skills discoverable from configured skill directories.",
      items,
    };
  }

  private buildProposalsDescriptor() {
    const items: ItemDescriptor[] = [...this.proposals.values()].map((proposal) => ({
      id: proposal.id,
      props: proposal,
      summary: proposal.name,
      actions:
        proposal.status === "proposed"
          ? {
              activate_skill_proposal: action(async () => this.activateSkillProposal(proposal.id), {
                label: "Activate Skill Proposal",
                description:
                  "Activate this skill proposal. Persistent scopes require approval before writing.",
                dangerous: proposal.requires_approval,
                estimate: "fast",
              }),
              reject_skill_proposal: action(
                async () => {
                  proposal.status = "rejected";
                  this.server.refresh();
                  return proposal;
                },
                {
                  label: "Reject Skill Proposal",
                  description: "Reject this proposed skill version.",
                  estimate: "instant",
                },
              ),
            }
          : undefined,
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Proposed skill versions awaiting activation.",
      items,
    };
  }
}

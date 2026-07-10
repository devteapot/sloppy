import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isWithinRoot, safeRealpath } from "../../../providers/path-containment";
import {
  asStringArray,
  compareSkills,
  DEFAULT_VIEW_MAX_BYTES,
  discoverSupportingFiles,
  extractFrontmatter,
  nestedRecord,
  portablePath,
  readTextFile,
  type SkillInfo,
  type SkillRoot,
  type SkillScope,
  SLOPPY_SKILL_DIR_TOKEN,
  stableSkillId,
} from "./model";

export type SkillRepositoryOptions = {
  skillsDir?: string;
  builtinSkillsDir?: string;
  globalSkillsDir?: string;
  workspaceSkillsDir?: string;
  externalDirs?: string[];
  templateVars?: boolean;
  viewMaxBytes?: number;
};

export class SkillRepository {
  readonly roots: SkillRoot[];
  readonly viewMaxBytes: number;
  private readonly templateVars: boolean;

  constructor(options: SkillRepositoryOptions) {
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
  }

  async discover(): Promise<SkillInfo[]> {
    const glob = new Bun.Glob("**/SKILL.md");
    const skills: SkillInfo[] = [];
    for (const root of this.roots) {
      try {
        for await (const relativePath of glob.scan({ cwd: root.dir })) {
          const skill = await this.readDiscoveredSkill(root, relativePath).catch(() => undefined);
          if (skill) skills.push(skill);
        }
      } catch {
        // Missing or unreadable roots contribute no skills.
      }
    }
    return skills.sort(compareSkills);
  }

  find(skills: SkillInfo[], skillName: string, scope?: SkillScope): SkillInfo | undefined {
    const normalized = skillName.trim();
    return skills.find(
      (skill) =>
        (!scope || skill.scope === scope) &&
        (skill.name === normalized ||
          skill.skill_path === normalized ||
          (skill.category ? `${skill.category}/${skill.name}` === normalized : false)),
    );
  }

  resolveFile(skill: SkillInfo, filePath: string): string {
    if (!skill.directory) {
      throw new Error(`Skill ${skill.name} does not have a filesystem directory.`);
    }
    if (isAbsolute(filePath)) {
      throw new Error("file_path must be relative to the skill directory.");
    }
    const root = safeRealpath(skill.directory);
    if (!root) throw new Error(`Could not resolve skill directory: ${skill.directory}`);
    const absolutePath = resolve(skill.directory, filePath);
    if (!isWithinRoot(root, absolutePath)) {
      throw new Error("file_path escapes the skill directory.");
    }
    return absolutePath;
  }

  render(skill: SkillInfo, content: string): string {
    if (!this.templateVars || !skill.directory) return content;
    return content.replaceAll(SLOPPY_SKILL_DIR_TOKEN, skill.directory);
  }

  private async readDiscoveredSkill(root: SkillRoot, relativePath: string): Promise<SkillInfo> {
    const filePath = join(root.dir, relativePath);
    const content = await readTextFile(filePath, this.viewMaxBytes);
    const frontmatter = extractFrontmatter(content);
    const metadata = nestedRecord(frontmatter, "metadata");
    const sloppyMetadata = nestedRecord(metadata, "sloppy");
    const skillPath = portablePath(relativePath.replace(/\/SKILL\.md$/, ""));
    const pathParts = skillPath.split("/").filter(Boolean);
    const category =
      typeof sloppyMetadata.category === "string"
        ? sloppyMetadata.category
        : typeof frontmatter.category === "string"
          ? frontmatter.category
          : pathParts.length > 1
            ? pathParts[0]
            : undefined;
    const tags = asStringArray(frontmatter.tags);
    const skillDir = dirname(filePath);
    return {
      id: stableSkillId(root.idPrefix, skillPath || "root"),
      name: typeof frontmatter.name === "string" ? frontmatter.name : pathParts.at(-1) || skillPath,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
      version: typeof frontmatter.version === "string" ? frontmatter.version : "0.0.0",
      tags: tags.length > 0 ? tags : asStringArray(sloppyMetadata.tags),
      related_skills: asStringArray(frontmatter.related_skills),
      dangerous: frontmatter.dangerous === true,
      platforms: asStringArray(frontmatter.platforms),
      category,
      metadata,
      skill_path: skillPath,
      file_path: filePath,
      directory: skillDir,
      supporting_files: await discoverSupportingFiles(skillDir),
      scope: root.scope,
    };
  }
}

import { homedir } from "node:os";
import { join } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";

type SkillInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  related_skills: string[];
  dangerous: boolean;
  file_path: string;
};

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, unknown> = {};

  for (const line of match[1].split(/\r?\n/)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (!key) continue;

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      result[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else if (rawValue === "true") {
      result[key] = true;
    } else if (rawValue === "false") {
      result[key] = false;
    } else {
      result[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }

  return result;
}

export class SkillsProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private skillsDir: string;
  private skills: SkillInfo[] = [];

  constructor(options: { skillsDir?: string }) {
    this.skillsDir = options.skillsDir ?? join(homedir(), ".hermes", "skills");

    this.server = createSlopServer({
      id: "skills",
      name: "Skills",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("skills", () => this.buildSkillsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());

    void this.discoverSkills().then((skills) => {
      this.skills = skills;
      this.server.refresh();
    });
  }

  stop(): void {
    this.server.stop();
  }

  private async discoverSkills(): Promise<SkillInfo[]> {
    const glob = new Bun.Glob("**/SKILL.md");
    const skills: SkillInfo[] = [];

    try {
      for await (const relativePath of glob.scan({ cwd: this.skillsDir })) {
        const filePath = join(this.skillsDir, relativePath);
        try {
          const content = await Bun.file(filePath).text();
          const fm = parseYamlFrontmatter(content);

          const stableId = `skill-${relativePath
            .replace(/\/SKILL\.md$/, "")
            .replace(/[\\/]/g, "-")
            .replace(/[^a-zA-Z0-9_-]/g, "_")}`;

          skills.push({
            id: stableId,
            name:
              typeof fm.name === "string"
                ? fm.name
                : relativePath.replace(/\/SKILL\.md$/, ""),
            description: typeof fm.description === "string" ? fm.description : "",
            version: typeof fm.version === "string" ? fm.version : "0.0.0",
            tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
            related_skills: Array.isArray(fm.related_skills)
              ? (fm.related_skills as string[])
              : [],
            dangerous: fm.dangerous === true,
            file_path: filePath,
          });
        } catch {
          // skip unreadable skill files
        }
      }
    } catch {
      // skills directory does not exist or is unreadable
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async viewSkill(skillName: string): Promise<{ name: string; content: string }> {
    const skill = this.skills.find((s) => s.name === skillName);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    const content = await Bun.file(skill.file_path)
      .text()
      .catch(() => {
        throw new Error(`Could not read skill file: ${skill.file_path}`);
      });

    return { name: skill.name, content };
  }

  private buildSessionDescriptor() {
    const tagSet = new Set(this.skills.flatMap((s) => s.tags));

    return {
      type: "context",
      props: {
        skills_count: this.skills.length,
        tags_count: tagSet.size,
        installed: this.skills.map((s) => s.name),
      },
      summary: "Discoverable agent skills installed on this system.",
      actions: {
        refresh_skills: action(
          async () => {
            const skills = await this.discoverSkills();
            this.skills = skills;
            this.server.refresh();
            return { skills_count: this.skills.length };
          },
          {
            label: "Refresh Skills",
            description: "Re-scan the skills directory and update the skills list.",
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
          },
          async ({ name }) => this.viewSkill(String(name)),
          {
            label: "View Skill By Name",
            description: "Read the full content of a skill by its name.",
            idempotent: true,
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
        file_path: skill.file_path,
        ...(skill.related_skills.length > 0 ? { related_skills: skill.related_skills } : {}),
      },
      summary: skill.description || skill.name,
      actions: {
        view_skill: action(
          async () => this.viewSkill(skill.name),
          {
            label: "View Skill",
            description: "Read the full content of this skill's SKILL.md file.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
      ...(skill.dangerous
        ? { meta: { salience: 0.9, urgency: "high" as const } }
        : {}),
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Skills discoverable from the skills directory.",
      items,
    };
  }
}

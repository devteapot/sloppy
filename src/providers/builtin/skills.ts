import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";

type SkillScope = "imported" | "global" | "workspace" | "session";

type SkillInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  related_skills: string[];
  dangerous: boolean;
  file_path: string;
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
  scope: Exclude<SkillScope, "imported">;
  name: string;
  version: string;
  body: string;
  status: "proposed" | "active" | "rejected";
  created_at: string;
  activated_at?: string;
  requires_approval: boolean;
};

const SKILL_SCOPE_PRECEDENCE: Record<SkillScope, number> = {
  session: 0,
  workspace: 1,
  global: 2,
  imported: 3,
};

function compareSkills(a: SkillInfo, b: SkillInfo): number {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  const byScope = SKILL_SCOPE_PRECEDENCE[a.scope] - SKILL_SCOPE_PRECEDENCE[b.scope];
  if (byScope !== 0) return byScope;
  return a.id.localeCompare(b.id);
}

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
  private roots: SkillRoot[];
  private skills: SkillInfo[] = [];
  private proposals = new Map<string, SkillProposal>();

  constructor(options: {
    skillsDir?: string;
    globalSkillsDir?: string;
    workspaceSkillsDir?: string;
  }) {
    this.roots = [
      {
        scope: "imported",
        dir: options.skillsDir ?? join(homedir(), ".hermes", "skills"),
        idPrefix: "",
      },
      ...(options.globalSkillsDir
        ? [{ scope: "global" as const, dir: options.globalSkillsDir, idPrefix: "global-" }]
        : []),
      ...(options.workspaceSkillsDir
        ? [{ scope: "workspace" as const, dir: options.workspaceSkillsDir, idPrefix: "workspace-" }]
        : []),
    ];

    this.server = createSlopServer({
      id: "skills",
      name: "Skills",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("skills", () => this.buildSkillsDescriptor());
    this.server.register("proposals", () => this.buildProposalsDescriptor());
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

    for (const root of this.roots) {
      try {
        for await (const relativePath of glob.scan({ cwd: root.dir })) {
          const filePath = join(root.dir, relativePath);
          try {
            const content = await Bun.file(filePath).text();
            const fm = parseYamlFrontmatter(content);

            const stableId = `skill-${root.idPrefix}${relativePath
              .replace(/\/SKILL\.md$/, "")
              .replace(/[\\/]/g, "-")
              .replace(/[^a-zA-Z0-9_-]/g, "_")}`;

            skills.push({
              id: stableId,
              name:
                typeof fm.name === "string" ? fm.name : relativePath.replace(/\/SKILL\.md$/, ""),
              description: typeof fm.description === "string" ? fm.description : "",
              version: typeof fm.version === "string" ? fm.version : "0.0.0",
              tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
              related_skills: Array.isArray(fm.related_skills)
                ? (fm.related_skills as string[])
                : [],
              dangerous: fm.dangerous === true,
              file_path: filePath,
              scope: root.scope,
            });
          } catch {
            // skip unreadable skill files
          }
        }
      } catch {
        // skills directory does not exist or is unreadable
      }
    }

    return skills.sort(compareSkills);
  }

  private async viewSkill(skillName: string): Promise<{ name: string; content: string }> {
    const skill = this.skills.find((s) => s.name === skillName);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    if (skill.content !== undefined) {
      return { name: skill.name, content: skill.content };
    }

    const content = await Bun.file(skill.file_path)
      .text()
      .catch(() => {
        throw new Error(`Could not read skill file: ${skill.file_path}`);
      });

    return { name: skill.name, content };
  }

  private proposeSkill(params: Record<string, unknown>): SkillProposal {
    const scope =
      params.scope === "global" || params.scope === "workspace" ? params.scope : "session";
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
      this.skills.push({
        id: `skill-session-${proposal.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        name: proposal.name,
        description: "",
        version: proposal.version,
        tags: [],
        related_skills: [],
        dangerous: false,
        file_path: "",
        scope: "session",
        content: proposal.body,
      });
      this.skills.sort(compareSkills);
    } else {
      const root = this.roots.find((candidate) => candidate.scope === proposal.scope);
      if (!root) {
        throw new Error(`No ${proposal.scope} skill root is configured.`);
      }
      const slug = proposal.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
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
      this.skills = await this.discoverSkills();
    }
    proposal.status = "active";
    proposal.activated_at = new Date().toISOString();
    this.server.refresh();
    return proposal;
  }

  private buildSessionDescriptor() {
    const tagSet = new Set(this.skills.flatMap((s) => s.tags));

    return {
      type: "context",
      props: {
        skills_count: this.skills.length,
        tags_count: tagSet.size,
        installed: this.skills.map((s) => s.name),
        proposals_count: this.proposals.size,
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
        file_path: skill.file_path,
        ...(skill.related_skills.length > 0 ? { related_skills: skill.related_skills } : {}),
      },
      summary: skill.description || skill.name,
      actions: {
        view_skill: action(async () => this.viewSkill(skill.name), {
          label: "View Skill",
          description: "Read the full content of this skill's SKILL.md file.",
          idempotent: true,
          estimate: "fast",
        }),
      },
      ...(skill.dangerous ? { meta: { salience: 0.9, urgency: "high" as const } } : {}),
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

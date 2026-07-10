import { statSync } from "node:fs";
import { join, sep } from "node:path";

import { parse as parseYaml } from "yaml";

export type SkillScope = "session" | "workspace" | "global" | "builtin" | "imported";
export type WritableSkillScope = Exclude<SkillScope, "builtin" | "imported">;

export type SkillInfo = {
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

export type SkillRoot = {
  scope: Exclude<SkillScope, "session">;
  dir: string;
  idPrefix: string;
};

export type SkillProposal = {
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

export type SkillManageOperation =
  | "create"
  | "patch"
  | "edit"
  | "delete"
  | "write_file"
  | "remove_file";

const SKILL_SCOPE_PRECEDENCE: Record<SkillScope, number> = {
  session: 0,
  workspace: 1,
  global: 2,
  builtin: 3,
  imported: 4,
};

export const DEFAULT_VIEW_MAX_BYTES = 65536;
export const SLOPPY_SKILL_DIR_TOKEN = "$" + "{SLOPPY_SKILL_DIR}";

export function compareSkills(a: SkillInfo, b: SkillInfo): number {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  const byScope = SKILL_SCOPE_PRECEDENCE[a.scope] - SKILL_SCOPE_PRECEDENCE[b.scope];
  if (byScope !== 0) return byScope;
  return a.id.localeCompare(b.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const parsed = parseYaml(match[1]);
  return isRecord(parsed) ? parsed : {};
}

export function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function portablePath(path: string): string {
  return path.split(sep).join("/");
}

export function stableSkillId(prefix: string, skillPath: string): string {
  return `skill-${prefix}${skillPath.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function writableScope(value: unknown): WritableSkillScope | undefined {
  return value === "session" || value === "workspace" || value === "global" ? value : undefined;
}

export function isWritableScope(scope: SkillScope): scope is WritableSkillScope {
  return scope === "session" || scope === "workspace" || scope === "global";
}

export async function readTextFile(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`File does not exist: ${path}`);
  }
  if (file.size > maxBytes) {
    throw new Error(`File is too large to read through skills provider: ${path}`);
  }
  return file.text();
}

export async function discoverSupportingFiles(skillDir: string): Promise<string[]> {
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
